import type { PriceSource, PriceTick } from "./types.ts";

// ============================================================================
// MockPriceSource — random walk around a base price
// ============================================================================
// For PoC / local development. fair_value performs a small-step random walk
// around a base value; realized vol is a function of the step magnitude.
//
// Spikes can be simulated via the `MOCK_SPIKE_PROB` env var.
//
// ⚠️ Decimals: `basePrice` is expected to be raw_quote_per_raw_base × PRICE_SCALE
// already. Convert a human price first with sources/types.ts'
// `priceToFairValue(price, baseDecimals, quoteDecimals)`. For equal-decimal
// pairs (e.g. xStock/USDC both 6dp), that's equivalent to priceHuman * PRICE_SCALE.

export interface MockPriceSourceOpts {
  basePrice: bigint;     // starting value (PRICE_SCALE units). e.g. 100_000_000 = $100
  stepBps: number;       // standard per-tick step (bps)
  tickIntervalMs: number;
  spikeProb: number;     // 0–1, probability of a spike per tick
  spikeMagnitudeBps: number;
}

export class MockPriceSource implements PriceSource {
  readonly label = "mock";

  private current_: PriceTick;
  private running = false;
  private timer?: number;
  private recentStepsBps: number[] = []; // used to estimate 5-min RV

  constructor(private opts: MockPriceSourceOpts) {
    this.current_ = {
      fairValue: opts.basePrice,
      confidenceBps: 0n,
      realizedVolBps: 0n,
      timestamp: Date.now(),
    };
  }

  current(): Promise<PriceTick> {
    return Promise.resolve(this.current_);
  }

  start(): Promise<() => void> {
    if (this.running) return Promise.resolve(() => this.stop());
    this.running = true;
    this.timer = setInterval(() => this.tick(), this.opts.tickIntervalMs);
    return Promise.resolve(() => this.stop());
  }

  private stop() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.running = false;
  }

  private tick() {
    // Random walk step in bps
    const u = Math.random();
    const stepBps = (u - 0.5) * 2 * this.opts.stepBps; // ±stepBps
    let totalBps = stepBps;

    // Spike occasionally
    if (Math.random() < this.opts.spikeProb) {
      const sign = Math.random() < 0.5 ? -1 : 1;
      totalBps += sign * this.opts.spikeMagnitudeBps;
    }

    const prev = this.current_.fairValue;
    const delta = (prev * BigInt(Math.round(totalBps))) / 10_000n;
    const next = prev + delta;
    const newFairValue = next > 0n ? next : prev;

    // RV (window 60 ticks, simple)
    this.recentStepsBps.push(Math.abs(totalBps));
    if (this.recentStepsBps.length > 60) this.recentStepsBps.shift();
    const rv =
      this.recentStepsBps.reduce((a, b) => a + b, 0) /
      Math.max(this.recentStepsBps.length, 1);

    this.current_ = {
      fairValue: newFairValue,
      confidenceBps: BigInt(Math.round(rv / 2)),
      realizedVolBps: BigInt(Math.round(rv)),
      timestamp: Date.now(),
    };
  }
}
