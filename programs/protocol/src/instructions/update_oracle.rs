use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::constants::*;
use crate::error::ProtocolError;
use crate::events::{emit_oracle_updated, OracleUpdated};
use crate::safety::{verify_owner_program, verify_signer, verify_writable};
use crate::state::{offset, PoolState};

// docs/SPECIFICATION.md §3.2
//
// HOT PATH — the keeper calls this every 200ms in Mode A. Optimised for CU:
//
//   1. Manual ix-data parse (no Borsh decode of UpdateOracleArgs).
//   2. Zero-copy PoolState access via `state::offset` constants — read just
//      the 3 fields we gate on (authorized_oracle_signer, paused, oracle_nonce)
//      and write the 7 fields we mutate. No full 323-byte deserialize +
//      serialize round-trip.
//   3. No `verify_pda_with_bump` — owner_program + discriminator check inside
//      from-byte access already gate against attacker substitutions. Closed
//      accounts get zeroed by Solana, failing the discriminator. Only
//      `init_pool` can mint a fresh program-owned PoolState, and it derives
//      the PDA itself with the canonical seeds.
//
// CU history: 5086 → ~1000 (~80% reduction). Event emit retained for FE +
// indexer subscribers.

const IX_DATA_LEN: usize = 8 + 2 + 20 + 16 + 8 + 1; // 55 bytes

pub fn process(
    _program_id: &Address,
    accounts: &mut [AccountView],
    ix_data: &[u8],
) -> ProgramResult {
    if ix_data.len() != IX_DATA_LEN {
        return Err(ProtocolError::InvalidInstructionData.into());
    }

    let [oracle_signer_info, pool_info, _rest @ ..] = accounts else {
        return Err(ProtocolError::NotEnoughAccountKeys.into());
    };

    verify_signer(oracle_signer_info)?;
    verify_writable(pool_info)?;
    verify_owner_program(pool_info, &PROGRAM_ID)?;

    // ----- Parse ix data inline (no Borsh) -----
    // Layout: [fair_value u64 LE | spread_bps u16 LE | depth(20) | skew(16) | nonce u64 LE | ttl u8]
    let new_fair_value = u64::from_le_bytes(ix_data[0..8].try_into().unwrap());
    let new_spread_bps = u16::from_le_bytes(ix_data[8..10].try_into().unwrap());
    let depth_bytes: &[u8; 20] = ix_data[10..30].try_into().unwrap();
    let skew_bytes: &[u8; 16] = ix_data[30..46].try_into().unwrap();
    let new_nonce = u64::from_le_bytes(ix_data[46..54].try_into().unwrap());
    let new_ttl = ix_data[54];

    // ----- Validate args (do this before touching account data) -----
    if new_fair_value == 0 {
        return Err(ProtocolError::InvalidFairValue.into());
    }
    if new_spread_bps > MAX_SPREAD_BPS {
        return Err(ProtocolError::InvalidSpread.into());
    }
    if new_ttl > MAX_TTL_SLOTS {
        return Err(ProtocolError::InvalidTtl.into());
    }
    // DepthParams = depth_coef_bps:u32 (0..4) | size_unit:u64 (4..12) | max_depth_bps:u16 (12..14) | _reserved[6]
    let depth_size_unit =
        u64::from_le_bytes(depth_bytes[4..12].try_into().unwrap());
    let depth_max_bps =
        u16::from_le_bytes(depth_bytes[12..14].try_into().unwrap());
    if depth_max_bps > MAX_DEPTH_BPS || depth_size_unit == 0 {
        return Err(ProtocolError::InvalidDepthParams.into());
    }
    // SkewParams = target_base_bps:u16 (0..2) | skew_coef_bps:u16 (2..4) | max_skew_offset_bps:u16 (4..6) | _reserved[10]
    let skew_target = u16::from_le_bytes(skew_bytes[0..2].try_into().unwrap());
    let skew_max_off = u16::from_le_bytes(skew_bytes[4..6].try_into().unwrap());
    if skew_max_off > MAX_SKEW_OFFSET_BPS || (skew_target as u64) > BPS_DENOMINATOR {
        return Err(ProtocolError::InvalidSkewParams.into());
    }

    let slot = Clock::get()?.slot;
    let pool_key = *pool_info.address();
    let signer_key = *oracle_signer_info.address();

    // ----- Zero-copy state access -----
    let mut data = pool_info.try_borrow_mut()?;

    // Discriminator gate replaces the no-longer-called `from_account_view`.
    if data.len() < PoolState::ACCOUNT_SIZE
        || data[..offset::DISC_LEN] != PoolState::DISCRIMINATOR
    {
        return Err(ProtocolError::WrongDiscriminator.into());
    }

    // ---- 3 read-only gate checks ----
    if data[offset::AUTHORIZED_ORACLE_SIGNER..offset::AUTHORIZED_ORACLE_SIGNER + 32]
        != *signer_key.as_ref()
    {
        return Err(ProtocolError::UnauthorizedOracle.into());
    }
    if data[offset::PAUSED] != 0 {
        return Err(ProtocolError::PoolPaused.into());
    }
    let current_nonce = u64::from_le_bytes(
        data[offset::ORACLE_NONCE..offset::ORACLE_NONCE + 8]
            .try_into()
            .unwrap(),
    );
    if new_nonce <= current_nonce {
        return Err(ProtocolError::NonceNotMonotonic.into());
    }

    // ---- 7 mutated-field writes ----
    data[offset::FAIR_VALUE..offset::FAIR_VALUE + 8]
        .copy_from_slice(&new_fair_value.to_le_bytes());
    data[offset::SPREAD_BPS..offset::SPREAD_BPS + 2]
        .copy_from_slice(&new_spread_bps.to_le_bytes());
    data[offset::DEPTH_PARAMS..offset::DEPTH_PARAMS + 20].copy_from_slice(depth_bytes);
    data[offset::SKEW_PARAMS..offset::SKEW_PARAMS + 16].copy_from_slice(skew_bytes);
    data[offset::LAST_ORACLE_UPDATE_SLOT..offset::LAST_ORACLE_UPDATE_SLOT + 8]
        .copy_from_slice(&slot.to_le_bytes());
    data[offset::ORACLE_NONCE..offset::ORACLE_NONCE + 8]
        .copy_from_slice(&new_nonce.to_le_bytes());
    data[offset::CURRENT_MODE_TTL] = new_ttl;

    drop(data); // release borrow before event emit (which may allocate)

    emit_oracle_updated(&OracleUpdated {
        pool: pool_key,
        // signer_key was the gate-check pubkey, and we just confirmed
        // data[AUTHORIZED_ORACLE_SIGNER] == signer_key.
        oracle_signer: signer_key,
        new_fair_value,
        new_spread_bps,
        new_nonce,
        new_ttl,
        slot,
    });

    Ok(())
}
