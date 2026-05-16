use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::events::AdminProposalCreated;
use crate::state::{AdminRotationProposal, PoolState};

// docs/SPECIFICATION.md §3.7 — 2-step rotation, step 1 (propose).
//
// Mistype risk on `rotate_admin` (single-step) made the admin key a
// permanent-lock footgun. The 2-step flow forces the proposed admin to
// actively sign `accept_admin` before privileges transfer.

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ ErrorCode::UnauthorizedAdmin,
    )]
    pub pool_state: Account<'info, PoolState>,

    /// Per-pool proposal PDA. `init` here — re-proposing requires cancelling
    /// the existing proposal first (system_program::create_account fails on
    /// pre-existing accounts), which makes accidental overwrite impossible.
    #[account(
        init,
        payer = admin,
        space = 8 + AdminRotationProposal::INIT_SPACE,
        seeds = [ADMIN_PROPOSAL_SEED, pool_state.key().as_ref()],
        bump,
    )]
    pub admin_proposal: Account<'info, AdminRotationProposal>,

    pub system_program: Program<'info, System>,
}

pub fn process_propose_admin(
    ctx: Context<ProposeAdmin>,
    new_admin: Pubkey,
) -> Result<()> {
    // Phase 1: validation
    require!(
        new_admin != Pubkey::default(),
        ErrorCode::InvalidNewAdmin
    );
    require!(
        new_admin != ctx.accounts.pool_state.admin,
        ErrorCode::InvalidNewAdmin
    );

    let slot = Clock::get()?.slot;
    let pool_key = ctx.accounts.pool_state.key();

    // Phase 3: state
    let proposal = &mut ctx.accounts.admin_proposal;
    proposal.pool = pool_key;
    proposal.proposed_by = ctx.accounts.admin.key();
    proposal.new_admin = new_admin;
    proposal.created_slot = slot;
    proposal.bump = ctx.bumps.admin_proposal;
    proposal._reserved = [0; 7];

    emit!(AdminProposalCreated {
        pool: pool_key,
        proposed_by: ctx.accounts.admin.key(),
        new_admin,
        slot,
    });

    Ok(())
}
