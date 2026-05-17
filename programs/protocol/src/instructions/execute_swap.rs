use borsh::BorshDeserialize;
use pinocchio::{
    cpi::{Seed, Signer},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::Transfer;

use crate::constants::*;
use crate::error::ProtocolError;
use crate::events::{emit_swap_executed, SwapExecuted};
use crate::math::{curve, mul_div_floor, verify_signed_quote_signature};
use crate::safety::{
    load_token_account_amount, verify_address, verify_owner_program, verify_pda_with_bump,
    verify_signer, verify_token_authority, verify_token_mint, verify_writable,
};
use crate::state::{PoolState, QuoteNonceMarker, Side, SignedQuote};

// docs/SPECIFICATION.md §3.3

#[derive(BorshDeserialize)]
pub struct ExecuteSwapArgs {
    pub input_amount: u64,
    pub direction: Side,
    pub min_output: u64,
    pub signed_quote_opt: Option<SignedQuote>,
}

/// Accounts (positional):
///   0. user                   — signer, writable
///   1. pool_state             — writable, owned by this program (PDA)
///   2. base_vault             — writable, SPL token account at pool.base_vault
///   3. quote_vault            — writable, SPL token account at pool.quote_vault
///   4. user_base_ata          — writable, SPL token account, owner=user
///   5. user_quote_ata         — writable, SPL token account, owner=user
///   6. token_program          — `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
///   7. system_program         — `11111111111111111111111111111111`
///   8. instructions_sysvar    — `Sysvar1nstructions1111111111111111111111111`
///   9. (RFQ path only) quote_nonce_marker — writable, uninitialized PDA
pub fn process(
    _program_id: &Address,
    accounts: &mut [AccountView],
    ix_data: &[u8],
) -> ProgramResult {
    let args = ExecuteSwapArgs::try_from_slice(ix_data)
        .map_err(|_| ProtocolError::InvalidInstructionData)?;

    let [user_info, pool_info, base_vault_info, quote_vault_info, user_base_ata_info, user_quote_ata_info, token_program_info, _system_program_info, instructions_sysvar_info, rest @ ..] =
        accounts
    else {
        return Err(ProtocolError::NotEnoughAccountKeys.into());
    };

    verify_signer(user_info)?;
    verify_writable(user_info)?;
    verify_writable(pool_info)?;
    verify_writable(base_vault_info)?;
    verify_writable(quote_vault_info)?;
    verify_writable(user_base_ata_info)?;
    verify_writable(user_quote_ata_info)?;
    verify_owner_program(pool_info, &PROGRAM_ID)?;
    verify_owner_program(base_vault_info, &TOKEN_PROGRAM_ID)?;
    verify_owner_program(quote_vault_info, &TOKEN_PROGRAM_ID)?;
    verify_owner_program(user_base_ata_info, &TOKEN_PROGRAM_ID)?;
    verify_owner_program(user_quote_ata_info, &TOKEN_PROGRAM_ID)?;
    verify_address(token_program_info, &TOKEN_PROGRAM_ID)?;
    verify_address(instructions_sysvar_info, &INSTRUCTIONS_SYSVAR_ID)?;

    let pool = PoolState::from_account_view(pool_info)?;
    verify_pda_with_bump(
        pool_info,
        &[POOL_SEED, pool.base_mint.as_ref(), pool.quote_mint.as_ref()],
        pool.bump,
        &PROGRAM_ID,
    )?;
    verify_address(base_vault_info, &pool.base_vault)?;
    verify_address(quote_vault_info, &pool.quote_vault)?;
    verify_token_mint(user_base_ata_info, &pool.base_mint)?;
    verify_token_mint(user_quote_ata_info, &pool.quote_mint)?;
    verify_token_authority(user_base_ata_info, user_info.address())?;
    verify_token_authority(user_quote_ata_info, user_info.address())?;

    if pool.paused != 0 {
        return Err(ProtocolError::PoolPaused.into());
    }
    if args.input_amount == 0 {
        return Err(ProtocolError::InvalidSize.into());
    }

    let now = Clock::get()?.slot;

    // Fork rollback safety: if now < last_oracle_update_slot, the oracle was
    // pushed in a slot that has been rolled back, so we force the curve to
    // stale. Relying on saturating_sub alone would yield age=0 (fresh) and
    // execute against the rolled-back price.
    let curve_fresh = pool.current_mode_ttl > 0
        && now >= pool.last_oracle_update_slot
        && (now - pool.last_oracle_update_slot) <= pool.current_mode_ttl as u64;

    let base_balance = load_token_account_amount(base_vault_info)?;
    let quote_balance = load_token_account_amount(quote_vault_info)?;

    // Decision policy §3.1: curve-first. When the curve is fresh, ignore signed_quote_opt.
    let mut mode: u8 = 0; // 0=curve, 1=rfq
    let mut quote_nonce: u64 = 0;
    let pool_key = *pool_info.address();
    let user_key = *user_info.address();

    let execution_price: u64 = if curve_fresh {
        curve::evaluate(
            pool.fair_value,
            pool.spread_bps,
            &pool.depth_curve_params,
            &pool.inventory_skew_params,
            base_balance,
            quote_balance,
            args.input_amount,
            args.direction,
        )?
    } else {
        mode = 1;
        let sq = args
            .signed_quote_opt
            .as_ref()
            .ok_or(ProtocolError::NoFreshPriceSource)?;

        if sq.pool != pool_key {
            return Err(ProtocolError::QuoteWrongPool.into());
        }
        if sq.user != user_key {
            return Err(ProtocolError::QuoteWrongUser.into());
        }
        if sq.direction != args.direction {
            return Err(ProtocolError::QuoteDirectionMismatch.into());
        }
        if sq.input_amount != args.input_amount {
            return Err(ProtocolError::QuoteSizeMismatch.into());
        }
        if now > sq.expiry_slot {
            return Err(ProtocolError::QuoteExpired.into());
        }

        verify_signed_quote_signature(
            instructions_sysvar_info,
            sq,
            &pool.authorized_oracle_signer,
        )?;

        // Replay guard: init the quote_nonce_marker PDA (`rest[0]`).
        let [marker_info, _rest2 @ ..] = rest else {
            return Err(ProtocolError::NoFreshPriceSource.into());
        };
        init_quote_nonce_marker(marker_info, user_info, pool_key, sq.nonce, sq.expiry_slot)?;

        quote_nonce = sq.nonce;
        sq.price
    };

    // ExactIn output (floored to protect the protocol).
    let output_amount: u64 = match args.direction {
        // Buy: input=quote, output=base. base_out = input * PRICE_SCALE / price.
        Side::Buy => mul_div_floor(args.input_amount, PRICE_SCALE, execution_price)?,
        // Sell: input=base, output=quote. quote_out = input * price / PRICE_SCALE.
        Side::Sell => mul_div_floor(args.input_amount, execution_price, PRICE_SCALE)?,
    };
    if output_amount < args.min_output {
        return Err(ProtocolError::SlippageExceeded.into());
    }

    // ----- Token transfers -----
    let pool_bump_arr = [pool.bump];
    let pool_seeds = [
        Seed::from(POOL_SEED),
        Seed::from(pool.base_mint.as_ref()),
        Seed::from(pool.quote_mint.as_ref()),
        Seed::from(pool_bump_arr.as_ref()),
    ];
    let pool_signer = Signer::from(&pool_seeds);

    match args.direction {
        Side::Buy => {
            // user_quote_ata → quote_vault (user-signed)
            Transfer::new(
                user_quote_ata_info,
                quote_vault_info,
                user_info,
                args.input_amount,
            )
            .invoke()?;
            // base_vault → user_base_ata (pool PDA signs)
            Transfer::new(base_vault_info, user_base_ata_info, pool_info, output_amount)
                .invoke_signed(&[pool_signer])?;
        }
        Side::Sell => {
            Transfer::new(user_base_ata_info, base_vault_info, user_info, args.input_amount)
                .invoke()?;
            Transfer::new(
                quote_vault_info,
                user_quote_ata_info,
                pool_info,
                output_amount,
            )
            .invoke_signed(&[pool_signer])?;
        }
    }

    emit_swap_executed(&SwapExecuted {
        pool: pool_key,
        user: user_key,
        direction: match args.direction {
            Side::Buy => 0,
            Side::Sell => 1,
        },
        mode,
        input_amount: args.input_amount,
        output_amount,
        execution_price,
        quote_nonce,
        slot: now,
    });

    Ok(())
}

// ----------------------------------------------------------------------------
// Manual init of quote_nonce_marker
// ----------------------------------------------------------------------------
// PDA seeds: [QUOTE_USED_SEED, pool, nonce.to_le_bytes()]. Anchor previously
// did this with `init`; here we drive create_account ourselves so the rest
// of the instruction can be branch-aware (RFQ path only).

fn init_quote_nonce_marker(
    marker_info: &mut AccountView,
    payer: &AccountView,
    pool: Address,
    nonce: u64,
    expiry_slot: u64,
) -> ProgramResult {
    let nonce_bytes = nonce.to_le_bytes();
    let (expected_addr, bump) = Address::find_program_address(
        &[QUOTE_USED_SEED, pool.as_ref(), nonce_bytes.as_ref()],
        &PROGRAM_ID,
    );
    if &expected_addr != marker_info.address() {
        return Err(ProtocolError::WrongPool.into());
    }
    if !marker_info.is_data_empty() || marker_info.lamports() != 0 {
        return Err(ProtocolError::QuoteAlreadyUsed.into());
    }

    let space = QuoteNonceMarker::ACCOUNT_SIZE;
    let lamports = Rent::get()?.try_minimum_balance(space)?;

    let bump_arr = [bump];
    let seeds = [
        Seed::from(QUOTE_USED_SEED),
        Seed::from(pool.as_ref()),
        Seed::from(nonce_bytes.as_ref()),
        Seed::from(bump_arr.as_ref()),
    ];
    let signer = Signer::from(&seeds);

    CreateAccount {
        from: payer,
        to: marker_info,
        lamports,
        space: space as u64,
        owner: &PROGRAM_ID,
    }
    .invoke_signed(&[signer])?;

    let marker = QuoteNonceMarker {
        pool,
        nonce,
        expiry_slot,
        bump,
        _reserved: [0; 7],
    };
    let mut data = marker_info.try_borrow_mut()?;
    marker.store(&mut data)?;

    Ok(())
}
