use borsh::BorshDeserialize;
use pinocchio::{
    cpi::{Seed, Signer},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::constants::{ADMIN_PROPOSAL_SEED, PROGRAM_ID};
use crate::error::ProtocolError;
use crate::events::{emit_admin_proposal_created, AdminProposalCreated};
use crate::safety::{verify_owner_program, verify_signer, verify_writable};
use crate::state::{AdminRotationProposal, PoolState};

// docs/SPECIFICATION.md §3.9 — 2-step rotation, step 1 (propose).

#[derive(BorshDeserialize)]
pub struct ProposeAdminArgs {
    pub new_admin: Address,
}

/// Accounts (positional):
///   0. admin           — signer, writable (pays rent)
///   1. pool_state      — owned by this program (admin check)
///   2. admin_proposal  — writable, uninitialized PDA (will be allocated)
///   3. system_program  — `11111111111111111111111111111111`
pub fn process(
    _program_id: &Address,
    accounts: &mut [AccountView],
    ix_data: &[u8],
) -> ProgramResult {
    let args = ProposeAdminArgs::try_from_slice(ix_data)
        .map_err(|_| ProtocolError::InvalidInstructionData)?;

    let [admin_info, pool_info, proposal_info, _system_program_info, _rest @ ..] = accounts else {
        return Err(ProtocolError::NotEnoughAccountKeys.into());
    };

    verify_signer(admin_info)?;
    verify_writable(admin_info)?;
    verify_writable(proposal_info)?;
    verify_owner_program(pool_info, &PROGRAM_ID)?;

    let pool = PoolState::from_account_view(pool_info)?;
    if &pool.admin != admin_info.address() {
        return Err(ProtocolError::UnauthorizedAdmin.into());
    }
    if args.new_admin == Address::default() || args.new_admin == pool.admin {
        return Err(ProtocolError::InvalidNewAdmin.into());
    }

    let pool_key = *pool_info.address();
    let (expected_pda, bump) =
        Address::find_program_address(&[ADMIN_PROPOSAL_SEED, pool_key.as_ref()], &PROGRAM_ID);
    if &expected_pda != proposal_info.address() {
        return Err(ProtocolError::WrongPda.into());
    }
    if !proposal_info.is_data_empty() || proposal_info.lamports() != 0 {
        // Already initialized — caller must cancel first.
        return Err(ProtocolError::InvalidNewAdmin.into());
    }

    let space = AdminRotationProposal::ACCOUNT_SIZE;
    let rent_lamports = Rent::get()?.try_minimum_balance(space)?;

    let bump_arr = [bump];
    let seeds = [
        Seed::from(ADMIN_PROPOSAL_SEED),
        Seed::from(pool_key.as_ref()),
        Seed::from(bump_arr.as_ref()),
    ];
    let signer = Signer::from(&seeds);
    CreateAccount {
        from: admin_info,
        to: proposal_info,
        lamports: rent_lamports,
        space: space as u64,
        owner: &PROGRAM_ID,
    }
    .invoke_signed(&[signer])?;

    let slot = Clock::get()?.slot;
    let admin_key = *admin_info.address();
    let proposal = AdminRotationProposal {
        pool: pool_key,
        proposed_by: admin_key,
        new_admin: args.new_admin,
        created_slot: slot,
        bump,
        _reserved: [0; 7],
    };
    {
        let mut data = proposal_info.try_borrow_mut()?;
        proposal.store(&mut data)?;
    }

    emit_admin_proposal_created(&AdminProposalCreated {
        pool: pool_key,
        proposed_by: admin_key,
        new_admin: args.new_admin,
        slot,
    });

    Ok(())
}
