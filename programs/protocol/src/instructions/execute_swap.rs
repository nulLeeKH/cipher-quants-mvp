use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction, sysvar};
use anchor_lang::Discriminator;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::ErrorCode;
use crate::events::SwapExecuted;
use crate::math::{curve, mul_div_floor, verify_signed_quote_signature};
use crate::state::{PoolState, QuoteNonceMarker, Side, SignedQuote};

// docs/SPECIFICATION.md §3.3

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_SEED, pool_state.base_mint.as_ref(), pool_state.quote_mint.as_ref()],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(mut, address = pool_state.base_vault)]
    pub base_vault: Account<'info, TokenAccount>,

    #[account(mut, address = pool_state.quote_vault)]
    pub quote_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = pool_state.base_mint,
        token::authority = user,
    )]
    pub user_base_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = pool_state.quote_mint,
        token::authority = user,
    )]
    pub user_quote_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// CHECK: Instructions sysvar for ed25519 verify cross-check (RFQ path only).
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    // RFQ path: remaining_accounts[0] = quote_nonce_marker (manual init).
}

pub fn process_execute_swap<'info>(
    ctx: Context<'_, '_, '_, 'info, ExecuteSwap<'info>>,
    input_amount: u64,
    direction: Side,
    min_output: u64,
    signed_quote_opt: Option<SignedQuote>,
) -> Result<()> {
    // Phase 1: Validation & pricing
    let now = Clock::get()?.slot;
    let pool = &ctx.accounts.pool_state;

    require!(!pool.paused, ErrorCode::PoolPaused);
    require!(input_amount > 0, ErrorCode::InvalidSize);

    // Fork rollback safety: if now < last_oracle_update_slot, the oracle was
    // pushed in a slot that has been rolled back, so we force the curve to
    // stale. Relying on saturating_sub alone would yield age=0 (fresh) and
    // execute against the rolled-back price.
    let curve_fresh = pool.current_mode_ttl > 0
        && now >= pool.last_oracle_update_slot
        && (now - pool.last_oracle_update_slot) <= pool.current_mode_ttl as u64;

    // Decision policy §3.1: curve-first. When the curve is fresh, ignore signed_quote_opt.
    let mut mode: u8 = 0; // 0=curve, 1=rfq (for the emitted event)
    let mut quote_nonce: u64 = 0; // 0 on the curve path
    let execution_price: u64 = if curve_fresh {
        curve::evaluate(
            pool.fair_value,
            pool.spread_bps,
            &pool.depth_curve_params,
            &pool.inventory_skew_params,
            ctx.accounts.base_vault.amount,
            ctx.accounts.quote_vault.amount,
            input_amount,
            direction,
        )?
    } else {
        mode = 1;
        let sq = signed_quote_opt
            .as_ref()
            .ok_or(error!(ErrorCode::NoFreshPriceSource))?;

        // SignedQuote fields must match the instruction arguments.
        require!(sq.pool == pool.key(), ErrorCode::QuoteWrongPool);
        require!(sq.user == ctx.accounts.user.key(), ErrorCode::QuoteWrongUser);
        require!(sq.direction == direction, ErrorCode::QuoteDirectionMismatch);
        require!(
            sq.input_amount == input_amount,
            ErrorCode::QuoteSizeMismatch
        );
        require!(now <= sq.expiry_slot, ErrorCode::QuoteExpired);

        // ed25519 verify — cross-check against the verify ix prepended in the same tx
        // (read through the Instructions sysvar).
        verify_signed_quote_signature(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            sq,
            &pool.authorized_oracle_signer,
        )?;

        // Replay guard: manually init the quote_nonce_marker PDA inside this instruction.
        // remaining_accounts[0] = marker (UncheckedAccount, not yet allocated).
        require!(
            !ctx.remaining_accounts.is_empty(),
            ErrorCode::NoFreshPriceSource
        );
        let marker_info = &ctx.remaining_accounts[0];
        init_quote_nonce_marker(
            marker_info,
            &ctx.accounts.user,
            &ctx.accounts.system_program,
            ctx.program_id,
            pool.key(),
            sq.nonce,
            sq.expiry_slot,
        )?;

        quote_nonce = sq.nonce;
        sq.price
    };

    // Phase 1.5: Compute output (ExactIn; sale-side floor).
    let output_amount: u64 = match direction {
        // Buy: input=quote, output=base. base_out = input * PRICE_SCALE / price.
        Side::Buy => mul_div_floor(input_amount, PRICE_SCALE, execution_price)?,
        // Sell: input=base, output=quote. quote_out = input * price / PRICE_SCALE.
        Side::Sell => mul_div_floor(input_amount, execution_price, PRICE_SCALE)?,
    };
    require!(output_amount >= min_output, ErrorCode::SlippageExceeded);

    // Phase 2: Token transfers
    let base_mint_key = pool.base_mint;
    let quote_mint_key = pool.quote_mint;
    let pool_bump = pool.bump;
    let pool_seeds: &[&[u8]] = &[
        POOL_SEED,
        base_mint_key.as_ref(),
        quote_mint_key.as_ref(),
        &[pool_bump],
    ];
    let signer_seeds = &[pool_seeds];

    match direction {
        Side::Buy => {
            // user_quote_ata → quote_vault (user signer)
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_quote_ata.to_account_info(),
                        to: ctx.accounts.quote_vault.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                input_amount,
            )?;
            // base_vault → user_base_ata (PDA signer)
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.base_vault.to_account_info(),
                        to: ctx.accounts.user_base_ata.to_account_info(),
                        authority: ctx.accounts.pool_state.to_account_info(),
                    },
                    signer_seeds,
                ),
                output_amount,
            )?;
        }
        Side::Sell => {
            // user_base_ata → base_vault (user signer)
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_base_ata.to_account_info(),
                        to: ctx.accounts.base_vault.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                input_amount,
            )?;
            // quote_vault → user_quote_ata (PDA signer)
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.quote_vault.to_account_info(),
                        to: ctx.accounts.user_quote_ata.to_account_info(),
                        authority: ctx.accounts.pool_state.to_account_info(),
                    },
                    signer_seeds,
                ),
                output_amount,
            )?;
        }
    }

    // Phase 3: No separate state update — vault.amount is refreshed by the SPL Token CPI.
    emit!(SwapExecuted {
        pool: ctx.accounts.pool_state.key(),
        user: ctx.accounts.user.key(),
        direction: match direction {
            Side::Buy => 0,
            Side::Sell => 1,
        },
        mode,
        input_amount,
        output_amount,
        execution_price,
        quote_nonce,
        slot: now,
    });

    Ok(())
}

// ============================================================================
// Manual init of quote_nonce_marker
// ============================================================================
// Anchor's `#[account(init)]` does not support conditional init cleanly, so we
// invoke system_program::create_account manually and write the discriminator +
// data ourselves. Replay is blocked because system_program::create_account fails
// when the account already exists.

fn init_quote_nonce_marker<'info>(
    marker_info: &AccountInfo<'info>,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
    program_id: &Pubkey,
    pool: Pubkey,
    nonce: u64,
    expiry_slot: u64,
) -> Result<()> {
    let nonce_bytes = nonce.to_le_bytes();
    let seeds_for_derive: &[&[u8]] = &[QUOTE_USED_SEED, pool.as_ref(), &nonce_bytes];
    let (expected_addr, bump) = Pubkey::find_program_address(seeds_for_derive, program_id);

    require!(marker_info.key() == expected_addr, ErrorCode::WrongPool);
    // If already initialized, system_program::create_account will fail; we add an
    // explicit check here so callers see a clear `QuoteAlreadyUsed` (replay)
    // error code instead of the generic signature-invalid one.
    require!(
        marker_info.data_is_empty() && marker_info.lamports() == 0,
        ErrorCode::QuoteAlreadyUsed
    );

    let space = 8 + QuoteNonceMarker::INIT_SPACE;
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);

    let signer_seeds: &[&[u8]] = &[
        QUOTE_USED_SEED,
        pool.as_ref(),
        &nonce_bytes,
        std::slice::from_ref(&bump),
    ];

    let create_ix = system_instruction::create_account(
        payer.key,
        marker_info.key,
        lamports,
        space as u64,
        program_id,
    );

    invoke_signed(
        &create_ix,
        &[
            payer.to_account_info(),
            marker_info.clone(),
            system_program.to_account_info(),
        ],
        &[signer_seeds],
    )?;

    // Discriminator + data write.
    // Anchor's try_serialize re-writes the discriminator itself, so a `[8..]` slice
    // would be too short (total need = 8 + InitSpace, but `[8..]` holds only
    // InitSpace bytes). We use manual borsh instead.
    let marker = QuoteNonceMarker {
        pool,
        nonce,
        expiry_slot,
        bump,
        _reserved: [0; 7],
    };

    let mut data = marker_info.try_borrow_mut_data()?;
    data[..8].copy_from_slice(&QuoteNonceMarker::DISCRIMINATOR);
    let serialized = marker
        .try_to_vec()
        .map_err(|_| error!(ErrorCode::MathError))?;
    data[8..8 + serialized.len()].copy_from_slice(&serialized);

    Ok(())
}
