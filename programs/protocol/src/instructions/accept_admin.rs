use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::events::AdminRotated;
use crate::state::{AdminRotationProposal, PoolState};

// docs/SPECIFICATION.md §3.7 — 2-step rotation, step 2 (accept).
//
// The proposed admin signs this; the actual admin transfer happens atomically
// here and the proposal account is closed (rent refunded to the new admin).

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut)]
    pub new_admin: Signer<'info>,

    #[account(mut)]
    pub pool_state: Account<'info, PoolState>,

    /// Proposal must (a) exist for this pool, (b) name `new_admin` as the
    /// candidate, and (c) target the current pool admin so a stale proposal
    /// from a previous admin can't be replayed across rotations.
    #[account(
        mut,
        close = new_admin,
        seeds = [ADMIN_PROPOSAL_SEED, pool_state.key().as_ref()],
        bump = admin_proposal.bump,
        constraint = admin_proposal.pool == pool_state.key() @ ErrorCode::WrongPool,
        constraint = admin_proposal.new_admin == new_admin.key() @ ErrorCode::UnauthorizedAdmin,
        constraint = admin_proposal.proposed_by == pool_state.admin @ ErrorCode::ProposalStale,
    )]
    pub admin_proposal: Account<'info, AdminRotationProposal>,
}

pub fn process_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let previous_admin = ctx.accounts.pool_state.admin;
    let new_admin = ctx.accounts.new_admin.key();

    ctx.accounts.pool_state.admin = new_admin;

    emit!(AdminRotated {
        pool: ctx.accounts.pool_state.key(),
        previous_admin,
        new_admin,
        slot: Clock::get()?.slot,
    });

    // `close = new_admin` on the proposal account handles rent reclaim.
    Ok(())
}
