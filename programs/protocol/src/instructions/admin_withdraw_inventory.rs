use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::PoolState;

// docs/SPECIFICATION.md §3.6

#[derive(Accounts)]
pub struct AdminWithdrawInventory<'info> {
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ ErrorCode::UnauthorizedAdmin,
        has_one = base_vault,
        has_one = quote_vault,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(mut)]
    pub base_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub quote_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = pool_state.base_mint,
        token::authority = admin,
    )]
    pub admin_base_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = pool_state.quote_mint,
        token::authority = admin,
    )]
    pub admin_quote_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn process_admin_withdraw_inventory(
    ctx: Context<AdminWithdrawInventory>,
    withdraw_base_amount: u64,
    withdraw_quote_amount: u64,
) -> Result<()> {
    // Phase 1: Validation
    require!(
        withdraw_base_amount > 0 || withdraw_quote_amount > 0,
        ErrorCode::InvalidSize
    );
    require!(
        withdraw_base_amount <= ctx.accounts.base_vault.amount,
        ErrorCode::InsufficientReserves
    );
    require!(
        withdraw_quote_amount <= ctx.accounts.quote_vault.amount,
        ErrorCode::InsufficientReserves
    );

    // Phase 2: CPIs (PDA signer)
    let base_mint = ctx.accounts.pool_state.base_mint;
    let quote_mint = ctx.accounts.pool_state.quote_mint;
    let pool_bump = ctx.accounts.pool_state.bump;
    let pool_seeds: &[&[u8]] = &[
        POOL_SEED,
        base_mint.as_ref(),
        quote_mint.as_ref(),
        &[pool_bump],
    ];
    let signer_seeds = &[pool_seeds];

    if withdraw_base_amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.base_vault.to_account_info(),
                    to: ctx.accounts.admin_base_ata.to_account_info(),
                    authority: ctx.accounts.pool_state.to_account_info(),
                },
                signer_seeds,
            ),
            withdraw_base_amount,
        )?;
    }

    if withdraw_quote_amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.quote_vault.to_account_info(),
                    to: ctx.accounts.admin_quote_ata.to_account_info(),
                    authority: ctx.accounts.pool_state.to_account_info(),
                },
                signer_seeds,
            ),
            withdraw_quote_amount,
        )?;
    }

    // Phase 3: no separate state update — vault.amount is refreshed by the SPL Token CPI.
    Ok(())
}
