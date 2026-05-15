use anchor_lang::prelude::*;

// ============================================================================
// QuoteNonceMarker
// ============================================================================
// One-shot marker that blocks RFQ quote replay.
// PDA seeds: [b"quote_used", pool, nonce.to_le_bytes()].
//
// Lifecycle:
//   - The RFQ path of execute_swap forces init → already existing means the
//     instruction fails, which is the replay block.
//   - Once expiry_slot + SAFETY_BUFFER_SLOTS < current_slot, anyone can call
//     close_expired_nonce to close it and reclaim rent.
//
// Full spec: docs/SPECIFICATION.md §2.4.

#[account]
#[derive(InitSpace, Debug)]
pub struct QuoteNonceMarker {
    /// Which pool this nonce belongs to.
    pub pool: Pubkey,

    /// The nonce value this marker represents.
    pub nonce: u64,

    /// Used to determine when close is allowed (expiry + safety buffer must elapse).
    pub expiry_slot: u64,

    pub bump: u8,

    pub _reserved: [u8; 7],
}
