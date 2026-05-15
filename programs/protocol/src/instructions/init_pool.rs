use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::{DepthParams, PoolState, SkewParams};

// docs/SPECIFICATION.md §3.1

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + PoolState::INIT_SPACE,
        seeds = [POOL_SEED, base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, pool_state.key().as_ref(), base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = pool_state,
    )]
    pub base_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, pool_state.key().as_ref(), quote_mint.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = pool_state,
    )]
    pub quote_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process_init_pool(
    ctx: Context<InitPool>,
    authorized_oracle_signer: Pubkey,
    initial_fair_value: u64,
    initial_spread_bps: u16,
    initial_depth_params: DepthParams,
    initial_skew_params: SkewParams,
    initial_mode_ttl: u8,
) -> Result<()> {
    // Phase 1: Validation
    let base_mint = ctx.accounts.base_mint.key();
    let quote_mint = ctx.accounts.quote_mint.key();
    require!(base_mint != quote_mint, ErrorCode::InvalidMintPair);
    require!(base_mint < quote_mint, ErrorCode::MintsNotSorted);
    require!(initial_mode_ttl <= MAX_TTL_SLOTS, ErrorCode::InvalidTtl);
    require!(initial_fair_value > 0, ErrorCode::InvalidFairValue);
    require!(
        initial_spread_bps <= MAX_SPREAD_BPS,
        ErrorCode::InvalidSpread
    );
    require!(
        initial_depth_params.max_depth_bps <= MAX_DEPTH_BPS
            && initial_depth_params.size_unit > 0,
        ErrorCode::InvalidDepthParams
    );
    require!(
        initial_skew_params.max_skew_offset_bps <= MAX_SKEW_OFFSET_BPS
            && (initial_skew_params.target_base_bps as u64) <= BPS_DENOMINATOR,
        ErrorCode::InvalidSkewParams
    );

    // Phase 2: CPIs — Anchor's `init` handles PoolState, base_vault, and quote_vault.

    // Phase 3: State
    let pool = &mut ctx.accounts.pool_state;
    pool.admin = ctx.accounts.admin.key();
    pool.authorized_oracle_signer = authorized_oracle_signer;
    pool.base_mint = base_mint;
    pool.quote_mint = quote_mint;
    pool.base_vault = ctx.accounts.base_vault.key();
    pool.quote_vault = ctx.accounts.quote_vault.key();
    pool.fair_value = initial_fair_value;
    pool.spread_bps = initial_spread_bps;
    pool.depth_curve_params = initial_depth_params;
    pool.inventory_skew_params = initial_skew_params;
    pool.last_oracle_update_slot = Clock::get()?.slot;
    pool.oracle_nonce = 0;
    pool.current_mode_ttl = initial_mode_ttl;
    pool.bump = ctx.bumps.pool_state;
    pool.base_vault_bump = ctx.bumps.base_vault;
    pool.quote_vault_bump = ctx.bumps.quote_vault;
    pool.paused = false;
    pool._reserved = [0; 64];

    Ok(())
}
