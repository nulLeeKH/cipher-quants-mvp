use anchor_lang::prelude::*;

// ============================================================================
// AdminRotationProposal
// ============================================================================
// One-shot record of a proposed admin rotation. Created by `propose_admin`
// (signed by current admin), consumed by `accept_admin` (signed by the
// proposed admin) or `cancel_admin_proposal` (signed by current admin).
//
// PDA seeds: [b"admin_proposal", pool_state].
// One proposal per pool at a time — re-proposing requires cancelling first.
//
// This sidesteps modifying PoolState's layout (which would force a migration),
// at the cost of an extra account read on the accept path. See
// docs/SPECIFICATION.md §3.7 for the policy rationale.

#[account]
#[derive(InitSpace, Debug)]
pub struct AdminRotationProposal {
    /// Which pool this proposal targets.
    pub pool: Pubkey,
    /// The admin pubkey that proposed it (must match pool_state.admin at the
    /// time the proposal was created). Stored so a subsequent admin rotation
    /// can invalidate stale proposals on review.
    pub proposed_by: Pubkey,
    /// The new admin candidate. Must sign `accept_admin` to take effect.
    pub new_admin: Pubkey,
    /// Slot the proposal was created. For audit + (future) expiry.
    pub created_slot: u64,
    pub bump: u8,
    pub _reserved: [u8; 7],
}
