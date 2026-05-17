use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::constants::{POOL_SEED, PROGRAM_ID, SAFETY_BUFFER_SLOTS};
use crate::error::ProtocolError;
use crate::events::{emit_quote_marker_closed, QuoteMarkerClosed};
use crate::safety::{
    close_account, verify_owner_program, verify_pda_with_bump, verify_signer, verify_writable,
};
use crate::state::{PoolState, QuoteNonceMarker};

// docs/SPECIFICATION.md §3.8

/// Accounts (positional):
///   0. closer            — signer, writable (receives reclaimed rent)
///   1. pool_state        — owned by this program (read-only PDA assertion only)
///   2. quote_nonce_marker — writable, owned by this program (closed)
pub fn process(
    _program_id: &Address,
    accounts: &mut [AccountView],
    _ix_data: &[u8],
) -> ProgramResult {
    let [closer_info, pool_info, marker_info, _rest @ ..] = accounts else {
        return Err(ProtocolError::NotEnoughAccountKeys.into());
    };

    verify_signer(closer_info)?;
    verify_writable(closer_info)?;
    verify_writable(marker_info)?;
    verify_owner_program(pool_info, &PROGRAM_ID)?;
    verify_owner_program(marker_info, &PROGRAM_ID)?;

    let pool = PoolState::from_account_view(pool_info)?;
    verify_pda_with_bump(
        pool_info,
        &[POOL_SEED, pool.base_mint.as_ref(), pool.quote_mint.as_ref()],
        pool.bump,
        &PROGRAM_ID,
    )?;

    let marker = QuoteNonceMarker::from_account_view(marker_info)?;
    if &marker.pool != pool_info.address() {
        return Err(ProtocolError::WrongPool.into());
    }

    let now = Clock::get()?.slot;
    if marker.expiry_slot.saturating_add(SAFETY_BUFFER_SLOTS) >= now {
        return Err(ProtocolError::NonceNotYetClosable.into());
    }

    // Snapshot the values we need post-close, since closing zeroes the data.
    let nonce = marker.nonce;
    let expiry_slot = marker.expiry_slot;
    let pool_key = *pool_info.address();
    let closer_key = *closer_info.address();

    close_account(marker_info, closer_info)?;

    emit_quote_marker_closed(&QuoteMarkerClosed {
        pool: pool_key,
        closer: closer_key,
        nonce,
        expiry_slot,
        slot: now,
    });

    Ok(())
}
