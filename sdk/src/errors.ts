// ============================================================================
// Error code → friendly message mapping
// ============================================================================
// Mirror of programs/protocol/src/error.rs. The frontend uses these to convert
// on-chain errors into user-friendly messages.
//
// Usage:
//   try { await program.methods.executeSwap(...).rpc(); }
//   catch (err) {
//     setErrorMessage(friendlyError(err));
//   }
// ============================================================================

/**
 * Stable error code → ProtocolError variant name. Mirrors the `ProtocolError`
 * enum in `programs/protocol/src/error.rs` 1-to-1.
 *
 * Anchor-era programs surfaced the variant name in the error message via the
 * IDL. Pinocchio has no IDL bundling, so we re-create the mapping here and
 * inject the name into any `custom program error: 0x…` message in the SDK's
 * `sendAndConfirm` path. Tests that check `.rejects.toThrow(/SomeError/)`
 * keep working unchanged.
 */
export const ERROR_CODE_NAMES: Record<number, string> = {
  6000: "MathOverflow",
  6001: "MathError",
  6002: "MathUnderflow",
  6100: "InvalidMintPair",
  6101: "MintsNotSorted",
  6102: "InvalidTtl",
  6103: "InvalidFairValue",
  6104: "InvalidSpread",
  6105: "InvalidSize",
  6106: "InvalidDepthParams",
  6107: "InvalidSkewParams",
  6108: "InvalidOracleSignerKey",
  6109: "InvalidNewAdmin",
  6110: "ProposalStale",
  6200: "UnauthorizedOracle",
  6201: "UnauthorizedAdmin",
  6202: "NonceNotMonotonic",
  6203: "PoolPaused",
  6300: "NoFreshPriceSource",
  6301: "QuoteExpired",
  6302: "QuoteWrongPool",
  6303: "QuoteWrongUser",
  6304: "QuoteDirectionMismatch",
  6305: "QuoteSizeMismatch",
  6306: "QuoteSignatureInvalid",
  6307: "QuoteAlreadyUsed",
  6400: "SlippageExceeded",
  6401: "InsufficientReserves",
  6500: "WrongPool",
  6501: "NonceNotYetClosable",
  6502: "WrongDiscriminator",
  6503: "WrongAccountOwner",
  6504: "WrongPda",
  6505: "MissingSigner",
  6506: "NotWritable",
  6507: "WrongTokenMint",
  6508: "WrongAccountSize",
  6509: "WrongAccountAddress",
  6510: "UnknownInstruction",
  6511: "InvalidInstructionData",
  6512: "NotEnoughAccountKeys",
};

export function errorCodeToName(code: number): string | null {
  return ERROR_CODE_NAMES[code] ?? null;
}

export const ERROR_CODE_MESSAGES: Record<number, string> = {
  // 60xx — math
  6000: "Arithmetic overflow",
  6001: "Math error (division by zero or invalid operation)",
  6002: "Arithmetic underflow",

  // 61xx — input validation
  6100: "base_mint and quote_mint must be different",
  6101: "Mints must be lexicographically sorted (base < quote)",
  6102: "TTL out of allowed range",
  6103: "Fair value must be greater than zero",
  6104: "Spread exceeds maximum",
  6105: "Input amount must be greater than zero",
  6106: "Depth params out of allowed range",
  6107: "Skew params out of allowed range",
  6108: "Authorized oracle signer must not be zero",
  6109: "Proposed new admin must not be zero or equal to the current admin",
  6110: "Admin-rotation proposal is stale (admin changed since it was proposed)",

  // 62xx — authorization & state
  6200: "Unauthorized oracle signer",
  6201: "Unauthorized admin",
  6202: "Oracle nonce must be strictly monotonic",
  6203: "Pool is paused. Try again later.",

  // 63xx — pricing source
  6300: "Curve is stale and no signed quote provided. Try again in a moment.",
  6301: "Signed quote expired. Request a new quote.",
  6302: "Signed quote does not match this pool",
  6303: "Signed quote was issued for a different user",
  6304: "Signed quote direction mismatch",
  6305: "Signed quote input amount mismatch",
  6306: "Signed quote signature invalid",
  6307: "Quote nonce already consumed (replay rejected)",

  // 64xx — execution
  6400: "Slippage exceeded. Adjust your tolerance and retry.",
  6401: "Insufficient vault balance",

  // 65xx — account / nonce lifecycle / safety helpers
  6500: "Account does not match expected pool",
  6501: "Nonce marker not yet eligible for close (waiting for safety buffer)",
  6502: "Account discriminator mismatch",
  6503: "Account owner mismatch",
  6504: "Account is not the expected program-derived address",
  6505: "Required signer flag is not set",
  6506: "Required writable flag is not set",
  6507: "Token account mint mismatch",
  6508: "Account size mismatch",
  6509: "Account address mismatch",
  6510: "Unknown instruction tag",
  6511: "Invalid instruction data (Borsh decode failed)",
  6512: "Not enough account keys provided",
};

export function errorCodeToMessage(code: number): string {
  return ERROR_CODE_MESSAGES[code] ?? `Unknown protocol error (${code})`;
}

/**
 * Extract custom program error code from various error shapes:
 * - Anchor-style `AnchorError.error.errorCode.number`
 * - Solana `SendTransactionError` with "Error Number: N" in logs
 * - Custom program error hex `0x<code>` in transaction logs
 */
export function extractErrorCode(err: unknown): number | null {
  if (err === null || typeof err !== "object") return null;

  // Anchor-shape: some downstream callers may wrap errors this way for
  // legacy back-compat.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrappedCode = (err as any)?.error?.errorCode?.number;
  if (typeof wrappedCode === "number") return wrappedCode;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message = String((err as any)?.message ?? err);
  const decMatch = message.match(/Error Number:\s*(\d+)/);
  if (decMatch) return parseInt(decMatch[1], 10);

  const hexMatch = message.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hexMatch) return parseInt(hexMatch[1], 16);

  return null;
}

/**
 * Convert any error → human-readable string. Use directly in UI:
 *   toast.error(friendlyError(err))
 */
export function friendlyError(err: unknown): string {
  const code = extractErrorCode(err);
  if (code !== null) {
    return errorCodeToMessage(code);
  }
  if (typeof err === "object" && err !== null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (err as any)?.message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
