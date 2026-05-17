use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::constants::{ADMIN_PROPOSAL_SEED, PROGRAM_ID};
use crate::error::ProtocolError;
use crate::events::{emit_admin_proposal_cancelled, AdminProposalCancelled};
use crate::safety::{
    close_account, verify_owner_program, verify_pda_with_bump, verify_signer, verify_writable,
};
use crate::state::{AdminRotationProposal, PoolState};

// docs/SPECIFICATION.md §3.7 — 2-step rotation, optional cancellation.

/// Accounts (positional):
///   0. admin           — signer, writable (rent destination)
///   1. pool_state      — owned by this program
///   2. admin_proposal  — writable, owned by this program (closed)
pub fn process(
    _program_id: &Address,
    accounts: &mut [AccountView],
    _ix_data: &[u8],
) -> ProgramResult {
    let [admin_info, pool_info, proposal_info, _rest @ ..] = accounts else {
        return Err(ProtocolError::NotEnoughAccountKeys.into());
    };

    verify_signer(admin_info)?;
    verify_writable(admin_info)?;
    verify_writable(proposal_info)?;
    verify_owner_program(pool_info, &PROGRAM_ID)?;
    verify_owner_program(proposal_info, &PROGRAM_ID)?;

    let pool = PoolState::from_account_view(pool_info)?;
    if &pool.admin != admin_info.address() {
        return Err(ProtocolError::UnauthorizedAdmin.into());
    }

    let proposal = AdminRotationProposal::from_account_view(proposal_info)?;
    if &proposal.pool != pool_info.address() {
        return Err(ProtocolError::WrongPool.into());
    }
    verify_pda_with_bump(
        proposal_info,
        &[ADMIN_PROPOSAL_SEED, pool_info.address().as_ref()],
        proposal.bump,
        &PROGRAM_ID,
    )?;

    let pool_key = *pool_info.address();
    let admin_key = *admin_info.address();
    let cancelled_new_admin = proposal.new_admin;

    close_account(proposal_info, admin_info)?;

    emit_admin_proposal_cancelled(&AdminProposalCancelled {
        pool: pool_key,
        admin: admin_key,
        cancelled_new_admin,
        slot: Clock::get()?.slot,
    });

    Ok(())
}
