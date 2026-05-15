// ============================================================================
// PriceSource interface
// ============================================================================
// docs/OPERATIONS.md §3.1 — Price engine input.
// PoC v0: MockPriceSource (random walk).
// Later: FinnhubPriceSource, PythPriceSource, ChainlinkPriceSource (Stage 1+).
//
// All sources expose the same interface, so they can be swapped freely.
// fair_value composition is the responsibility of the PriceEngine.

export interface PriceTick {
  /** Fair value (quote per base, integer-encoded as PRICE_SCALE=1e6 units) */
  fairValue: bigint;
  /** Confidence interval (bps). 0 = unknown. */
  confidenceBps: bigint;
  /** Realized volatility, 5-minute window (bps). 0 = unknown. */
  realizedVolBps: bigint;
  /** Tick timestamp (ms since epoch) */
  timestamp: number;
}

export interface PriceSource {
  /** Source identifier for logging/metrics */
  readonly label: string;
  /** Get the latest price tick (cached or fresh) */
  current(): Promise<PriceTick>;
  /** Start background polling/subscription. Returns stop fn. */
  start(): Promise<() => void>;
}
