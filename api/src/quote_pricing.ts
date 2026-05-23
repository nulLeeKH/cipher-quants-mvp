// ============================================================================
// Quote pricing (v0 simplification)
// ============================================================================
// The PoC RFQ price is just fair_value ± half-spread. Depth and skew are
// applied by the on-chain curve when curve-fresh; the API never quotes
// while the curve is fresh (caller is told to use the curve path), so the
// off-chain quote can stay simple.
//
// Lives standalone so it's unit-testable without booting the HTTP server.

export type Direction = "buy" | "sell";

export interface QuotePricingInput {
  /** fair_value as raw_quote_per_raw_base × PRICE_SCALE */
  fairValue: bigint;
  /** total spread in bps (half on each side) */
  spreadBps: number;
  /** user's input amount in raw token units */
  inAmount: bigint;
  /** trade direction (buy = inputs quote, outputs base) */
  direction: Direction;
  /** PRICE_SCALE used on-chain (1e6 by default) */
  priceScale?: bigint;
}

export interface QuotePricing {
  /** quote price in PRICE_SCALE units (raw_quote_per_raw_base × PRICE_SCALE) */
  price: bigint;
  /** output amount in raw token units (floor) */
  outAmount: bigint;
}

export function computeQuotePricing(input: QuotePricingInput): QuotePricing {
  const priceScale = input.priceScale ?? 1_000_000n;
  if (input.fairValue <= 0n) {
    throw new Error("computeQuotePricing: fair_value must be > 0");
  }
  if (input.inAmount <= 0n) {
    throw new Error("computeQuotePricing: inAmount must be > 0");
  }
  if (input.spreadBps < 0) {
    throw new Error("computeQuotePricing: spreadBps must be ≥ 0");
  }
  // Match the on-chain integer convention exactly: half-spread truncates
  // (floor); for odd spread_bps the protocol takes spread-1 bps total per
  // round-trip. Pool operators should set even spread_bps for exact symmetric
  // take. See docs/SPECIFICATION.md §2.2 (Rounding rules).
  const half = BigInt(Math.floor(input.spreadBps / 2));
  // Price rounding mirrors on-chain math/curve.rs::evaluate:
  //   Buy  → CEIL (maximise price ⇒ minimise output base ⇒ favour protocol)
  //   Sell → FLOOR (minimise price ⇒ minimise output quote ⇒ favour protocol)
  // BigInt `/` truncates toward zero (= floor for positive); ceilDiv is the
  // standard (num + denom - 1) / denom idiom for unsigned division.
  const ceilDiv = (num: bigint, denom: bigint): bigint =>
    (num + denom - 1n) / denom;
  const price = input.direction === "buy"
    ? ceilDiv(input.fairValue * (10_000n + half), 10_000n)
    : (input.fairValue * (10_000n - half)) / 10_000n;
  if (price <= 0n) {
    throw new Error(
      "computeQuotePricing: price went non-positive (spreadBps too high)",
    );
  }
  const outAmount = input.direction === "buy"
    ? (input.inAmount * priceScale) / price
    : (input.inAmount * price) / priceScale;
  return { price, outAmount };
}
