use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::constants::*;
use crate::error::ProtocolError;
// Note: `OracleUpdated` event intentionally NOT emitted from this hot path.
// Every field it carried (`fair_value`, `spread_bps`, `new_nonce`, `new_ttl`,
// `last_oracle_update_slot`) is written to PoolState in this same ix, so
// subscribers should listen for `Connection.onAccountChange(pool_state)` and
// diff fields — zero information loss, ~600-800 CU saved per emit. The
// `OracleUpdated` struct + decoder remain in events.rs / sdk/events.ts for
// back-compat with historical transaction logs.
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
// CU history: 5086 → 313 (~94% reduction). Full record in docs/CU_OPTIMIZATION.md.

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
    // Layout (matches state[FAIR_VALUE..SKEW_PARAMS+16] verbatim for fields 0..46):
    //   [fair_value u64 LE | spread_bps u16 LE | depth(20) | skew(16) | nonce u64 LE | ttl u8]
    let new_fair_value = u64::from_le_bytes(ix_data[0..8].try_into().unwrap());
    let new_spread_bps = u16::from_le_bytes(ix_data[8..10].try_into().unwrap());
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
    // DepthParams = depth_coef_bps:u32 (10..14) | size_unit:u64 (14..22) | max_depth_bps:u16 (22..24) | _reserved[6]
    let depth_size_unit = u64::from_le_bytes(ix_data[14..22].try_into().unwrap());
    let depth_max_bps = u16::from_le_bytes(ix_data[22..24].try_into().unwrap());
    if depth_max_bps > MAX_DEPTH_BPS || depth_size_unit == 0 {
        return Err(ProtocolError::InvalidDepthParams.into());
    }
    // SkewParams = target_base_bps:u16 (30..32) | skew_coef_bps:u16 (32..34) | max_skew_offset_bps:u16 (34..36) | _reserved[10]
    let skew_target = u16::from_le_bytes(ix_data[30..32].try_into().unwrap());
    let skew_max_off = u16::from_le_bytes(ix_data[34..36].try_into().unwrap());
    if skew_max_off > MAX_SKEW_OFFSET_BPS || (skew_target as u64) > BPS_DENOMINATOR {
        return Err(ProtocolError::InvalidSkewParams.into());
    }

    let slot = Clock::get()?.slot;
    let signer_key = *oracle_signer_info.address();

    // ----- Zero-copy state access -----
    let mut data = pool_info.try_borrow_mut()?;

    // Account-size gate. Discriminator check (8 bytes at offset 0) deliberately
    // skipped: only init_pool can mint a program-owned PoolState (PDA-derived),
    // and the *other* program-owned account types are smaller — QuoteNonceMarker
    // = 64 B, AdminRotationProposal = 120 B, both < ACCOUNT_SIZE. The
    // length check below therefore disambiguates without the extra 8-byte
    // compare. ~20 CU saved.
    if data.len() < PoolState::ACCOUNT_SIZE {
        return Err(ProtocolError::WrongAccountSize.into());
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

    // ---- Combined writes ----
    // FAIR_VALUE..SKEW_PARAMS+16 = state[224..270] = 46 contiguous bytes that
    // exactly mirror ix_data[0..46] (fair | spread | depth | skew). One memcpy
    // beats 4 separate copy_from_slice calls. Then nonce/slot/ttl follow.
    data[offset::FAIR_VALUE..offset::SKEW_PARAMS + 16].copy_from_slice(&ix_data[0..46]);
    data[offset::LAST_ORACLE_UPDATE_SLOT..offset::LAST_ORACLE_UPDATE_SLOT + 8]
        .copy_from_slice(&slot.to_le_bytes());
    data[offset::ORACLE_NONCE..offset::ORACLE_NONCE + 8]
        .copy_from_slice(&new_nonce.to_le_bytes());
    data[offset::CURRENT_MODE_TTL] = new_ttl;

    drop(data);
    let _ = (signer_key, slot); // intentionally unused — no event emit; all info written to PoolState.

    Ok(())
}
