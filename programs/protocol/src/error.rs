use anchor_lang::prelude::*;

// ============================================================================
// Error Codes
// ============================================================================
// Keep in sync with docs/SPECIFICATION.md §4 and CLAUDE.md "Error Codes".
//
// Categories:
//   60xx — math (overflow / underflow / div0)
//   61xx — input validation (mint pair, TTL, fair_value, spread, size)
//   62xx — authorization & state (oracle/admin signer, nonce monotonic, paused)
//   63xx — pricing source (curve stale + no quote, quote invalid)
//   64xx — execution (slippage, insufficient reserves)
//   65xx — account / nonce lifecycle
// ============================================================================

#[error_code]
pub enum ErrorCode {
    // ----- 60xx math -----
    #[msg("Arithmetic overflow occurred.")]
    MathOverflow, // 6000

    #[msg("Math error occurred (division by zero or invalid operation).")]
    MathError, // 6001

    #[msg("Arithmetic underflow occurred.")]
    MathUnderflow, // 6002

    // ----- 61xx input validation -----
    #[msg("base_mint and quote_mint must be different.")]
    InvalidMintPair = 6100,

    #[msg("Mints must be lexicographically sorted (base_mint < quote_mint).")]
    MintsNotSorted,

    #[msg("TTL out of allowed range.")]
    InvalidTtl,

    #[msg("fair_value must be greater than zero.")]
    InvalidFairValue,

    #[msg("spread_bps exceeds MAX_SPREAD_BPS.")]
    InvalidSpread,

    #[msg("input_amount must be greater than zero.")]
    InvalidSize,

    #[msg("DepthParams out of allowed range.")]
    InvalidDepthParams,

    #[msg("SkewParams out of allowed range.")]
    InvalidSkewParams,

    // ----- 62xx authorization & state -----
    #[msg("Unauthorized oracle signer.")]
    UnauthorizedOracle = 6200,

    #[msg("Unauthorized admin.")]
    UnauthorizedAdmin,

    #[msg("Oracle nonce must be strictly monotonic.")]
    NonceNotMonotonic,

    #[msg("Pool is paused.")]
    PoolPaused,

    // ----- 63xx pricing source -----
    #[msg("Curve is stale and no signed quote provided.")]
    NoFreshPriceSource = 6300,

    #[msg("Signed quote is expired.")]
    QuoteExpired,

    #[msg("Signed quote pool does not match.")]
    QuoteWrongPool,

    #[msg("Signed quote user does not match transaction signer.")]
    QuoteWrongUser,

    #[msg("Signed quote direction does not match instruction direction.")]
    QuoteDirectionMismatch,

    #[msg("Signed quote input_amount does not match instruction input_amount.")]
    QuoteSizeMismatch,

    #[msg("Signed quote ed25519 signature verification failed.")]
    QuoteSignatureInvalid,

    // ----- 64xx execution -----
    #[msg("Output amount below min_output (slippage exceeded).")]
    SlippageExceeded = 6400,

    #[msg("Vault has insufficient balance.")]
    InsufficientReserves,

    // ----- 65xx account / nonce lifecycle -----
    #[msg("Account.pool field does not match expected pool_state.")]
    WrongPool = 6500,

    #[msg("Nonce marker not yet eligible for close (expiry + safety buffer not reached).")]
    NonceNotYetClosable,
}
