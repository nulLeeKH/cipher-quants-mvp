use borsh::BorshDeserialize;
use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::constants::PROGRAM_ID;
use crate::error::ProtocolError;
use crate::events::{emit_quote_signer_rotated, QuoteSignerRotated};
use crate::safety::{verify_owner_program, verify_signer, verify_writable};
use crate::state::PoolState;

// docs/SPECIFICATION.md §3.12 — rotate the ed25519 signer used by the RFQ
// path. Mirrors `rotate_oracle_signer` but writes the *quote* signer field
// so the api-server hot key can be cycled without touching the keeper key
// (and vice versa).

#[derive(BorshDeserialize)]
pub struct RotateQuoteSignerArgs {
    pub new_authorized_quote_signer: Address,
}

/// Accounts (positional):
///   0. admin       — signer
///   1. pool_state  — writable, owned by this program
pub fn process(
    _program_id: &Address,
    accounts: &mut [AccountView],
    ix_data: &[u8],
) -> ProgramResult {
    let args = RotateQuoteSignerArgs::try_from_slice(ix_data)
        .map_err(|_| ProtocolError::InvalidInstructionData)?;

    let [admin_info, pool_info, _rest @ ..] = accounts else {
        return Err(ProtocolError::NotEnoughAccountKeys.into());
    };

    verify_signer(admin_info)?;
    verify_writable(pool_info)?;
    verify_owner_program(pool_info, &PROGRAM_ID)?;

    let mut pool = PoolState::from_account_view(pool_info)?;

    if &pool.admin != admin_info.address() {
        return Err(ProtocolError::UnauthorizedAdmin.into());
    }
    if args.new_authorized_quote_signer == Address::default() {
        return Err(ProtocolError::InvalidQuoteSignerKey.into());
    }

    let previous_signer = pool.authorized_quote_signer;
    pool.authorized_quote_signer = args.new_authorized_quote_signer;
    pool.store_account_view(pool_info)?;

    let slot = Clock::get()?.slot;
    emit_quote_signer_rotated(&QuoteSignerRotated {
        pool: *pool_info.address(),
        admin: *admin_info.address(),
        previous_signer,
        new_signer: args.new_authorized_quote_signer,
        slot,
    });

    Ok(())
}
