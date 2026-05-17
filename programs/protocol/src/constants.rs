use pinocchio::Address;

// ============================================================================
// PDA Seeds
// ============================================================================
// Keep in sync with docs/ARCHITECTURE.md §5 and CLAUDE.md "PDA Seeds".

pub const POOL_SEED: &[u8] = b"pool";
pub const VAULT_SEED: &[u8] = b"vault";
pub const QUOTE_USED_SEED: &[u8] = b"quote_used";
pub const ADMIN_PROPOSAL_SEED: &[u8] = b"admin_proposal";

// ============================================================================
// Protocol Constants
// ============================================================================
// Keep in sync with docs/SPECIFICATION.md §5.

/// Maximum TTL in slots. v0 operating values: Mode A=1, B=3, C=0; cap includes margin.
pub const MAX_TTL_SLOTS: u8 = 8;

/// Maximum spread = 10% (sanity guard).
pub const MAX_SPREAD_BPS: u16 = 1_000;

/// Upper bound on DepthParams.max_depth_bps (5%).
pub const MAX_DEPTH_BPS: u16 = 500;

/// Upper bound on SkewParams.max_skew_offset_bps (5%).
pub const MAX_SKEW_OFFSET_BPS: u16 = 500;

/// Buffer for the close condition of QuoteNonceMarker (`expiry_slot + buffer < now`).
/// Production value: ~1 minute assuming 400ms slots (150 slots).
/// Under the `test-feature` cfg we shrink the buffer to 5 slots (~2 seconds)
/// so the integration suite can exercise the happy path of
/// `close_expired_nonce` without burning a full minute per test. The mainnet
/// build script does **not** pass `--features test-feature`; only `scripts/test.sh`
/// does. Production rent-reclaim safety is unchanged.
#[cfg(not(feature = "test-feature"))]
pub const SAFETY_BUFFER_SLOTS: u64 = 150;
#[cfg(feature = "test-feature")]
pub const SAFETY_BUFFER_SLOTS: u64 = 5;

/// Integer scale for fair_value / price (1e6).
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

// ============================================================================
// Program ID + native programs
// ============================================================================
// `Address::from_str_const` is a const fn that base58-decodes at compile
// time (`solana_address`'s `decode` feature). Mirror of the entrypoint
// `declare_id!` in lib.rs — they must always agree.

pub const PROGRAM_ID: Address =
    Address::from_str_const("3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy");

pub const TOKEN_PROGRAM_ID: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

pub const SYSTEM_PROGRAM_ID: Address =
    Address::from_str_const("11111111111111111111111111111111");

pub const ED25519_PROGRAM_ID: Address =
    Address::from_str_const("Ed25519SigVerify111111111111111111111111111");

pub const INSTRUCTIONS_SYSVAR_ID: Address =
    Address::from_str_const("Sysvar1nstructions1111111111111111111111111");

pub const RENT_SYSVAR_ID: Address =
    Address::from_str_const("SysvarRent111111111111111111111111111111111");
