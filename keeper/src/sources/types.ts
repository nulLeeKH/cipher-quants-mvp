// ============================================================================
// PriceSource interface
// ============================================================================
// docs/OPERATIONS.md §3.1 — Price engine input.
// PoC v0: MockPriceSource (random walk).
// Later: FinnhubPriceSource, PythPriceSource, ChainlinkPriceSource (Stage 1+).
//
// All sources expose the same interface, so they can be swapped freely.
// fair_value composition is the responsibility of the PriceEngine.
//
// ────────────────────────────────────────────────────────────────────────────
// fair_value unit convention (important)
// ────────────────────────────────────────────────────────────────────────────
// On-chain math operates on raw u64 token amounts. So fair_value is defined as:
//
//   fair_value = (raw_quote_per_raw_base) × PRICE_SCALE
//              = (human_price_quote_per_base) × (10^quote_dec / 10^base_dec) × PRICE_SCALE
//
// External data sources usually expose a "human price" (e.g. 1 stock = $100.50),
// so each source adapter must multiply by the base/quote decimal ratio to
// produce a raw fair_value. See the `priceToFairValue` helper.
//
// For equal-decimal pairs (e.g. xStock/USDC at 6/6 dp), the conversion factor
// is 1 — the mock source can emit PRICE_SCALE integers directly. When wiring
// up a mismatched-decimal pair (e.g. SOL/USDC), introduce decimal-aware
// conversion at that boundary.

/**
 * Tick freshness as reported by the underlying source.
 *
 *   "fresh"   — within the source's allowed staleness window; safe to push.
 *   "stale"   — last known value is older than the source's freshness
 *               threshold. Caller should NOT push as if it were fresh; mode
 *               policy may force Mode C until a fresh tick arrives.
 *   "halted"  — source reports the market/feed is explicitly halted
 *               (auction, circuit breaker, equity holiday, etc.).
 *   "unknown" — source has never produced a tick (initial boot, fetch
 *               failure). `fairValue` is meaningless.
 *
 * Worker policy: push only when status == "fresh". Anything else is a
 * signal to keep the on-chain curve stale (RFQ path takes over).
 */
export type PriceTickStatus = "fresh" | "stale" | "halted" | "unknown";

export interface PriceTick {
  /** Fair value, raw_quote_per_raw_base × PRICE_SCALE (decimals-aware). */
  fairValue: bigint;
  /** Confidence interval (bps). 0 = unknown. */
  confidenceBps: bigint;
  /** Realized volatility, 5-minute window (bps). 0 = unknown. */
  realizedVolBps: bigint;
  /** Tick timestamp (ms since epoch). For Pyth this is `publish_time`. */
  timestamp: number;
  /** Source-reported freshness. Default `"fresh"` for sources that don't
   *  expose a staleness signal (e.g. the deterministic mock). */
  status: PriceTickStatus;
}

/**
 * Convert human-readable price (quote tokens per 1 base token, as a string
 * decimal — avoids JS float precision loss for assets like BTC) into the
 * on-chain `fair_value` representation expected by `update_oracle`.
 *
 *   fair_value = priceHuman × (10^quote_dec / 10^base_dec) × PRICE_SCALE
 *
 * Implemented purely with bigint string math.
 */
export function priceToFairValue(
  priceHuman: string,
  baseDecimals: number,
  quoteDecimals: number,
  priceScale: bigint = 1_000_000n
): bigint {
  const trimmed = priceHuman.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`priceToFairValue: invalid price "${priceHuman}"`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  // Combine numerator: priceHuman × 10^quote_dec × PRICE_SCALE
  // Implementation: scale priceHuman to integer using `decimalsExtra` shift,
  // then divide by the appropriate base_dec offset (with floor).
  const totalShift = quoteDecimals + Number(priceScale.toString().length) - 1;
  const fracPadded = (frac + "0".repeat(totalShift)).slice(0, totalShift);
  const intStr = (whole + fracPadded).replace(/^0+(?=\d)/, "") || "0";
  const numerator = BigInt(intStr);
  const denominator = 10n ** BigInt(baseDecimals);
  return numerator / denominator;
}

export interface PriceSource {
  /** Source identifier for logging/metrics */
  readonly label: string;
  /** Get the latest price tick (cached or fresh) */
  current(): Promise<PriceTick>;
  /** Start background polling/subscription. Returns stop fn. */
  start(): Promise<() => void>;
}
