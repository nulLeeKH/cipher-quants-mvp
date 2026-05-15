use anchor_lang::prelude::*;

// ============================================================================
// PDA Seeds
// ============================================================================
// Keep in sync with docs/ARCHITECTURE.md §5 and CLAUDE.md "PDA Seeds".

#[constant]
pub const POOL_SEED: &[u8] = b"pool";

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

#[constant]
pub const QUOTE_USED_SEED: &[u8] = b"quote_used";

// ============================================================================
// Protocol Constants
// ============================================================================
// Keep in sync with docs/SPECIFICATION.md §5.

/// Maximum TTL in slots. v0 operating values: Mode A=1, B=3, C=0; cap includes margin.
#[constant]
pub const MAX_TTL_SLOTS: u8 = 8;

/// Maximum spread = 10% (sanity guard).
#[constant]
pub const MAX_SPREAD_BPS: u16 = 1_000;

/// Upper bound on DepthParams.max_depth_bps (5%).
#[constant]
pub const MAX_DEPTH_BPS: u16 = 500;

/// Upper bound on SkewParams.max_skew_offset_bps (5%).
#[constant]
pub const MAX_SKEW_OFFSET_BPS: u16 = 500;

/// Buffer for the close condition of QuoteNonceMarker (`expiry_slot + buffer < now`).
/// ~1 minute assuming 400ms slots.
#[constant]
pub const SAFETY_BUFFER_SLOTS: u64 = 150;

/// Integer scale for fair_value / price (1e6).
#[constant]
pub const PRICE_SCALE: u64 = 1_000_000;

/// bps denominator.
pub const BPS_DENOMINATOR: u64 = 10_000;

// ============================================================================
// Invariant (compile-time check)
// ============================================================================
// MAX_SPREAD_BPS/2 + MAX_DEPTH_BPS + MAX_SKEW_OFFSET_BPS < BPS_DENOMINATOR
// Guards (10_000 + total_bps) against underflow/overflow during price computation.
//
// Check: 500 + 500 + 500 = 1500 << 10_000 ✓
const _: () = assert!(
    (MAX_SPREAD_BPS as u64) / 2 + (MAX_DEPTH_BPS as u64) + (MAX_SKEW_OFFSET_BPS as u64)
        < BPS_DENOMINATOR,
    "price calc invariant violated: half_spread + max_depth + max_skew must be < 10_000"
);
