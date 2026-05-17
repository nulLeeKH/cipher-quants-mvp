use borsh::BorshDeserialize;
use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::constants::*;
use crate::error::ProtocolError;
use crate::events::{emit_oracle_updated, OracleUpdated};
use crate::safety::{
    verify_owner_program, verify_pda_with_bump, verify_signer, verify_writable,
};
use crate::state::{DepthParams, PoolState, SkewParams};

// docs/SPECIFICATION.md §3.2

#[derive(BorshDeserialize)]
pub struct UpdateOracleArgs {
    pub new_fair_value: u64,
    pub new_spread_bps: u16,
    pub new_depth_params: DepthParams,
    pub new_skew_params: SkewParams,
    pub new_nonce: u64,
    pub new_ttl: u8,
}

/// Accounts (positional):
///   0. oracle_signer — signer
///   1. pool_state    — writable, owned by this program
pub fn process(
    _program_id: &Address,
    accounts: &mut [AccountView],
    ix_data: &[u8],
) -> ProgramResult {
    let args = UpdateOracleArgs::try_from_slice(ix_data)
        .map_err(|_| ProtocolError::InvalidInstructionData)?;

    let [oracle_signer_info, pool_info, _rest @ ..] = accounts else {
        return Err(ProtocolError::NotEnoughAccountKeys.into());
    };

    verify_signer(oracle_signer_info)?;
    verify_writable(pool_info)?;
    verify_owner_program(pool_info, &PROGRAM_ID)?;

    let mut pool = PoolState::from_account_view(pool_info)?;

    verify_pda_with_bump(
        pool_info,
        &[POOL_SEED, pool.base_mint.as_ref(), pool.quote_mint.as_ref()],
        pool.bump,
        &PROGRAM_ID,
    )?;

    if &pool.authorized_oracle_signer != oracle_signer_info.address() {
        return Err(ProtocolError::UnauthorizedOracle.into());
    }
    if pool.paused != 0 {
        return Err(ProtocolError::PoolPaused.into());
    }
    if args.new_nonce <= pool.oracle_nonce {
        return Err(ProtocolError::NonceNotMonotonic.into());
    }
    if args.new_ttl > MAX_TTL_SLOTS {
        return Err(ProtocolError::InvalidTtl.into());
    }
    if args.new_fair_value == 0 {
        return Err(ProtocolError::InvalidFairValue.into());
    }
    if args.new_spread_bps > MAX_SPREAD_BPS {
        return Err(ProtocolError::InvalidSpread.into());
    }
    if args.new_depth_params.max_depth_bps > MAX_DEPTH_BPS
        || args.new_depth_params.size_unit == 0
    {
        return Err(ProtocolError::InvalidDepthParams.into());
    }
    if args.new_skew_params.max_skew_offset_bps > MAX_SKEW_OFFSET_BPS
        || (args.new_skew_params.target_base_bps as u64) > BPS_DENOMINATOR
    {
        return Err(ProtocolError::InvalidSkewParams.into());
    }

    let slot = Clock::get()?.slot;
    pool.fair_value = args.new_fair_value;
    pool.spread_bps = args.new_spread_bps;
    pool.depth_curve_params = args.new_depth_params;
    pool.inventory_skew_params = args.new_skew_params;
    pool.oracle_nonce = args.new_nonce;
    pool.current_mode_ttl = args.new_ttl;
    pool.last_oracle_update_slot = slot;
    pool.store_account_view(pool_info)?;

    emit_oracle_updated(&OracleUpdated {
        pool: *pool_info.address(),
        oracle_signer: pool.authorized_oracle_signer,
        new_fair_value: args.new_fair_value,
        new_spread_bps: args.new_spread_bps,
        new_nonce: args.new_nonce,
        new_ttl: args.new_ttl,
        slot,
    });

    Ok(())
}
