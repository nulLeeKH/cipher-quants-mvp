use pinocchio::error::ProgramError;

// ============================================================================
// Error Codes
// ============================================================================
// Keep in sync with docs/SPECIFICATION.md §4 and CLAUDE.md "Error Codes".
//
// Categories (each spaced by 100 for grep-friendliness):
//   60xx — math (overflow / underflow / div0)
//   61xx — input validation (mint pair, TTL, fair_value, spread, size)
//   62xx — authorization & state (oracle/admin signer, nonce monotonic, paused)
//   63xx — pricing source (curve stale + no quote, quote invalid)
//   64xx — execution (slippage, insufficient reserves)
//   65xx — account / nonce lifecycle / safety helpers
//
// `ProgramError::Custom(code)` carries the u32 to the client. The numeric
// codes match the prior Anchor-era values 1:1 so existing SDK error mapping
// and runbooks keep working.
// ============================================================================

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    // ----- 60xx math -----
    MathOverflow = 6000,
    MathError = 6001,
    MathUnderflow = 6002,

    // ----- 61xx input validation -----
    InvalidMintPair = 6100,
    MintsNotSorted = 6101,
    InvalidTtl = 6102,
    InvalidFairValue = 6103,
    InvalidSpread = 6104,
    InvalidSize = 6105,
    InvalidDepthParams = 6106,
    InvalidSkewParams = 6107,
    InvalidOracleSignerKey = 6108,
    InvalidNewAdmin = 6109,
    ProposalStale = 6110,

    // ----- 62xx authorization & state -----
    UnauthorizedOracle = 6200,
    UnauthorizedAdmin = 6201,
    NonceNotMonotonic = 6202,
    PoolPaused = 6203,

    // ----- 63xx pricing source -----
    NoFreshPriceSource = 6300,
    QuoteExpired = 6301,
    QuoteWrongPool = 6302,
    QuoteWrongUser = 6303,
    QuoteDirectionMismatch = 6304,
    QuoteSizeMismatch = 6305,
    QuoteSignatureInvalid = 6306,
    QuoteAlreadyUsed = 6307,

    // ----- 64xx execution -----
    SlippageExceeded = 6400,
    InsufficientReserves = 6401,

    // ----- 65xx account / nonce lifecycle / safety helpers -----
    WrongPool = 6500,
    NonceNotYetClosable = 6501,
    /// Account does not carry the expected discriminator tag (zero-copy decode).
    WrongDiscriminator = 6502,
    /// Account owner does not match the expected program / token program.
    WrongAccountOwner = 6503,
    /// Account is not the expected program-derived address.
    WrongPda = 6504,
    /// Required signer flag is not set on the account.
    MissingSigner = 6505,
    /// Required `is_writable` flag is not set on the account.
    NotWritable = 6506,
    /// Token account mint does not match the expected mint.
    WrongTokenMint = 6507,
    /// Account data length does not match the expected size.
    WrongAccountSize = 6508,
    /// Account address does not match the expected pubkey — equivalent to
    /// Anchor's `#[account(address = X)]` constraint.
    WrongAccountAddress = 6509,
    /// Wired instruction tag is unknown to the dispatcher.
    UnknownInstruction = 6510,
    /// Borsh deserialize of instruction args failed.
    InvalidInstructionData = 6511,
    /// Required account was not provided in the accounts slice.
    NotEnoughAccountKeys = 6512,
}

impl From<ProtocolError> for ProgramError {
    fn from(e: ProtocolError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

/// `Result<T, ProgramError>` alias used throughout the crate. Mirrors the
/// shape of Anchor's `Result<T>` so call sites stay readable after porting.
pub type Result<T> = core::result::Result<T, ProgramError>;
