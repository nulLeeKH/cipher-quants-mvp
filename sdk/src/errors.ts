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

  // 64xx — execution
  6400: "Slippage exceeded. Adjust your tolerance and retry.",
  6401: "Insufficient vault balance",

  // 65xx — account / nonce lifecycle
  6500: "Account does not match expected pool",
  6501: "Nonce marker not yet eligible for close (waiting for safety buffer)",
};

export function errorCodeToMessage(code: number): string {
  return ERROR_CODE_MESSAGES[code] ?? `Unknown protocol error (${code})`;
}

/**
 * Extract custom program error code from various error shapes:
 * - Anchor `AnchorError.error.errorCode.number`
 * - Solana `SendTransactionError` with "Error Number: N" in logs
 * - Custom program error hex `0x<code>` in transaction logs
 */
export function extractErrorCode(err: unknown): number | null {
  if (err === null || typeof err !== "object") return null;

  // Anchor AnchorError
  const anchorCode = (err as any)?.error?.errorCode?.number;
  if (typeof anchorCode === "number") return anchorCode;

  // Logs scrape
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
    const m = (err as any)?.message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
