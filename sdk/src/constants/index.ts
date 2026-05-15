// ============================================================================
// SDK Constants
// ============================================================================
// On-chain mirror of programs/protocol/src/constants.rs.
// Update both files together when on-chain values change.
// ============================================================================

// ----- PDA Seeds -----
export const POOL_SEED = new TextEncoder().encode("pool");
export const VAULT_SEED = new TextEncoder().encode("vault");
export const QUOTE_USED_SEED = new TextEncoder().encode("quote_used");

// ----- Protocol Constants -----
/** TTL hard cap (code-level). Recommended operating values: Mode A=1, B=3, C=0. */
export const MAX_TTL_SLOTS = 8;

/** Maximum spread = 10% (sanity guard). */
export const MAX_SPREAD_BPS = 1_000;

/** Upper bound on DepthParams.max_depth_bps (5%). */
export const MAX_DEPTH_BPS = 500;

/** Upper bound on SkewParams.max_skew_offset_bps (5%). */
export const MAX_SKEW_OFFSET_BPS = 500;

/** Buffer for closing a QuoteNonceMarker (~1 minute assuming 400ms slots). */
export const SAFETY_BUFFER_SLOTS = 150n;

/** Integer scale for fair_value / price (1e6). */
export const PRICE_SCALE = 1_000_000n;

/** bps denominator. */
export const BPS_DENOMINATOR = 10_000n;

// ----- Side enum encoding (Borsh discriminant) -----
export const SIDE_BUY_TAG = 0;
export const SIDE_SELL_TAG = 1;

// ----- Mode operating defaults (off-chain hint) -----
export const MODE_A_TTL = 1; // Aggressive — push every slot, high-volatility window
export const MODE_B_TTL = 3; // Light Hybrid — threshold-triggered, normal trading
export const MODE_C_TTL = 0; // RFQ Only — force-stale, market-closed / low-vol

// ----- Solana native ed25519 verify precompile -----
export const ED25519_PROGRAM_ID =
  "Ed25519SigVerify111111111111111111111111111";
