use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::events::AdminProposalCancelled;
use crate::state::{AdminRotationProposal, PoolState};

// docs/SPECIFICATION.md §3.7 — 2-step rotation, optional cancellation.
//
// The current admin can drop an outstanding proposal (e.g. after typo
// detection, or to swap to a different candidate). Rent goes back to admin.

#[derive(Accounts)]
pub struct CancelAdminProposal<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(has_one = admin @ ErrorCode::UnauthorizedAdmin)]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        mut,
        close = admin,
        seeds = [ADMIN_PROPOSAL_SEED, pool_state.key().as_ref()],
        bump = admin_proposal.bump,
        constraint = admin_proposal.pool == pool_state.key() @ ErrorCode::WrongPool,
    )]
    pub admin_proposal: Account<'info, AdminRotationProposal>,
}

pub fn process_cancel_admin_proposal(
    ctx: Context<CancelAdminProposal>,
) -> Result<()> {
    emit!(AdminProposalCancelled {
        pool: ctx.accounts.pool_state.key(),
        admin: ctx.accounts.admin.key(),
        cancelled_new_admin: ctx.accounts.admin_proposal.new_admin,
        slot: Clock::get()?.slot,
    });
    Ok(())
}
