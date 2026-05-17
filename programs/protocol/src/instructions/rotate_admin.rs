use borsh::BorshDeserialize;
use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::constants::PROGRAM_ID;
use crate::error::ProtocolError;
use crate::events::{emit_admin_rotated, AdminRotated};
use crate::safety::{verify_owner_program, verify_signer, verify_writable};
use crate::state::PoolState;

// docs/SPECIFICATION.md §3.7 — single-step rotation (deprecated, retained for
// backward compatibility / emergency recovery). Prefer the 2-step
// `propose_admin` + `accept_admin` flow.

#[derive(BorshDeserialize)]
pub struct RotateAdminArgs {
    pub new_admin: Address,
}

/// Accounts (positional):
///   0. admin       — signer
///   1. pool_state  — writable, owned by this program
pub fn process(
    _program_id: &Address,
    accounts: &mut [AccountView],
    ix_data: &[u8],
) -> ProgramResult {
    let args = RotateAdminArgs::try_from_slice(ix_data)
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

    let previous_admin = pool.admin;
    pool.admin = args.new_admin;
    pool.store_account_view(pool_info)?;

    let slot = Clock::get()?.slot;
    emit_admin_rotated(&AdminRotated {
        pool: *pool_info.address(),
        previous_admin,
        new_admin: args.new_admin,
        slot,
    });

    Ok(())
}
