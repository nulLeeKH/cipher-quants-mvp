use anchor_lang::prelude::*;

// ============================================================================
// Events
// ============================================================================
// Every state-changing instruction emits an event. Used by frontend history,
// keeper analytics, and external indexers.
//
// The `Side` enum is flattened to a u8 (Buy=0, Sell=1) instead of being
// serialized as an enum — this keeps the anchor IDL simpler and makes event
// subscribers easier to write.
//
// Spec: docs/SPECIFICATION.md §3.

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub admin: Pubkey,
    pub oracle_signer: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub initial_fair_value: u64,
    pub initial_spread_bps: u16,
    pub initial_mode_ttl: u8,
    pub slot: u64,
}

#[event]
pub struct OracleUpdated {
    pub pool: Pubkey,
    pub oracle_signer: Pubkey,
    pub new_fair_value: u64,
    pub new_spread_bps: u16,
    pub new_nonce: u64,
    pub new_ttl: u8,
    pub slot: u64,
}

/// `mode`: 0=curve fresh path (PropAMM), 1=RFQ fallback
#[event]
pub struct SwapExecuted {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub direction: u8, // 0=Buy, 1=Sell (flattened Side enum)
    pub mode: u8,      // 0=curve, 1=rfq
    pub input_amount: u64,
    pub output_amount: u64,
    pub execution_price: u64,
    pub quote_nonce: u64, // RFQ path: SignedQuote.nonce, curve path: 0
    pub slot: u64,
}

#[event]
pub struct PoolPausedChanged {
    pub pool: Pubkey,
    pub admin: Pubkey,
    pub paused: bool,
    pub slot: u64,
}

#[event]
pub struct OracleSignerRotated {
    pub pool: Pubkey,
    pub admin: Pubkey,
    pub previous_signer: Pubkey,
    pub new_signer: Pubkey,
    pub slot: u64,
}

#[event]
pub struct AdminRotated {
    pub pool: Pubkey,
    pub previous_admin: Pubkey,
    pub new_admin: Pubkey,
    pub slot: u64,
}

#[event]
pub struct InventoryWithdrawn {
    pub pool: Pubkey,
    pub admin: Pubkey,
    pub base_amount: u64,
    pub quote_amount: u64,
    pub slot: u64,
}

#[event]
pub struct QuoteMarkerClosed {
    pub pool: Pubkey,
    pub closer: Pubkey,
    pub nonce: u64,
    pub expiry_slot: u64,
    pub slot: u64,
}
