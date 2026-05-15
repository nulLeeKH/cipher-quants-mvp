use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::events::OracleUpdated;
use crate::state::{DepthParams, PoolState, SkewParams};

// docs/SPECIFICATION.md §3.2

#[derive(Accounts)]
pub struct UpdateOracle<'info> {
    pub oracle_signer: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_SEED, pool_state.base_mint.as_ref(), pool_state.quote_mint.as_ref()],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,
}

pub fn process_update_oracle(
    ctx: Context<UpdateOracle>,
    new_fair_value: u64,
    new_spread_bps: u16,
    new_depth_params: DepthParams,
    new_skew_params: SkewParams,
    new_nonce: u64,
    new_ttl: u8,
) -> Result<()> {
    // Phase 1: Validation
    let pool = &ctx.accounts.pool_state;
    require!(
        ctx.accounts.oracle_signer.key() == pool.authorized_oracle_signer,
        ErrorCode::UnauthorizedOracle
    );
    require!(!pool.paused, ErrorCode::PoolPaused);
    require!(new_nonce > pool.oracle_nonce, ErrorCode::NonceNotMonotonic);
    require!(new_ttl <= MAX_TTL_SLOTS, ErrorCode::InvalidTtl);
    require!(new_fair_value > 0, ErrorCode::InvalidFairValue);
    require!(new_spread_bps <= MAX_SPREAD_BPS, ErrorCode::InvalidSpread);
    require!(
        new_depth_params.max_depth_bps <= MAX_DEPTH_BPS && new_depth_params.size_unit > 0,
        ErrorCode::InvalidDepthParams
    );
    require!(
        new_skew_params.max_skew_offset_bps <= MAX_SKEW_OFFSET_BPS
            && (new_skew_params.target_base_bps as u64) <= BPS_DENOMINATOR,
        ErrorCode::InvalidSkewParams
    );

    // Phase 2: no CPIs.
    // Phase 3: state update (do NOT touch reserves_* — that's an invariant).
    let slot = Clock::get()?.slot;
    let pool = &mut ctx.accounts.pool_state;
    pool.fair_value = new_fair_value;
    pool.spread_bps = new_spread_bps;
    pool.depth_curve_params = new_depth_params;
    pool.inventory_skew_params = new_skew_params;
    pool.oracle_nonce = new_nonce;
    pool.current_mode_ttl = new_ttl;
    pool.last_oracle_update_slot = slot;

    emit!(OracleUpdated {
        pool: pool.key(),
        oracle_signer: pool.authorized_oracle_signer,
        new_fair_value,
        new_spread_bps,
        new_nonce,
        new_ttl,
        slot,
    });

    Ok(())
}
