use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::constants::{ADMIN_PROPOSAL_SEED, PROGRAM_ID};
use crate::error::ProtocolError;
use crate::events::{emit_admin_rotated, AdminRotated};
use crate::safety::{
    close_account, verify_owner_program, verify_pda_with_bump, verify_signer, verify_writable,
};
use crate::state::{AdminRotationProposal, PoolState};

// docs/SPECIFICATION.md §3.10 — 2-step rotation, step 2 (accept).

/// Accounts (positional):
///   0. new_admin       — signer, writable (rent destination)
///   1. pool_state      — writable, owned by this program (admin updated)
///   2. admin_proposal  — writable, owned by this program (closed)
pub fn process(
    _program_id: &Address,
    accounts: &mut [AccountView],
    _ix_data: &[u8],
) -> ProgramResult {
    let [new_admin_info, pool_info, proposal_info, _rest @ ..] = accounts else {
        return Err(ProtocolError::NotEnoughAccountKeys.into());
    };

    verify_signer(new_admin_info)?;
    verify_writable(new_admin_info)?;
    verify_writable(pool_info)?;
    verify_writable(proposal_info)?;
    verify_owner_program(pool_info, &PROGRAM_ID)?;
    verify_owner_program(proposal_info, &PROGRAM_ID)?;

    let mut pool = PoolState::from_account_view(pool_info)?;
    let proposal = AdminRotationProposal::from_account_view(proposal_info)?;

    verify_pda_with_bump(
        proposal_info,
        &[ADMIN_PROPOSAL_SEED, pool_info.address().as_ref()],
        proposal.bump,
        &PROGRAM_ID,
    )?;
    if &proposal.pool != pool_info.address() {
        return Err(ProtocolError::WrongPool.into());
    }
    if &proposal.new_admin != new_admin_info.address() {
        return Err(ProtocolError::UnauthorizedAdmin.into());
    }
    // A stale proposal would carry an old `proposed_by` admin — reject so we
    // don't replay rotations across an admin change.
    if proposal.proposed_by != pool.admin {
        return Err(ProtocolError::ProposalStale.into());
    }

    let previous_admin = pool.admin;
    let new_admin = *new_admin_info.address();
    pool.admin = new_admin;
    pool.store_account_view(pool_info)?;

    let pool_key = *pool_info.address();
    close_account(proposal_info, new_admin_info)?;

    emit_admin_rotated(&AdminRotated {
        pool: pool_key,
        previous_admin,
        new_admin,
        slot: Clock::get()?.slot,
    });

    Ok(())
}
