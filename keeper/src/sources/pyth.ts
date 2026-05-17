// ============================================================================
// PythPriceSource — Pyth Hermes REST adapter
// ============================================================================
// docs/OPERATIONS.md §3.1, TODO.md §1 — first real (non-mock) price source.
//
// Hermes is Pyth Network's HTTP gateway over the Wormhole VAA stream:
//   GET https://hermes.pyth.network/v2/updates/price/latest?ids[]=<feedId>
//
// Free, no API key, no rate-limit headers. The keeper polls every
// `pollIntervalMs` (default 1s; Pyth itself publishes at ~400ms cadence for
// most feeds, so faster polling adds API load without new information).
//
// Feed IDs: https://pyth.network/developers/price-feed-ids
//   BTC/USD       e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
//   SOL/USD       ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
//   AAPL/USD      49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688
//
// Unit conversion (Pyth → on-chain fair_value):
//
//   human_price        = pyth_raw * 10^pyth_expo
//   raw_quote_per_base = human_price * 10^quote_dec / 10^base_dec
//   fair_value         = raw_quote_per_base * PRICE_SCALE
//                      = pyth_raw * 10^(pyth_expo + quote_dec - base_dec + 6)
//
// Done in integer bigint math to avoid float precision loss.

import type { PriceSource, PriceTick } from "./types.ts";

export interface PythPriceSourceOpts {
  /** 64-char hex feed id (no leading 0x). */
  feedId: string;
  /** Base mint decimals (e.g. 6 for xStocks/USDC pair). */
  baseDecimals: number;
  /** Quote mint decimals. */
  quoteDecimals: number;
  /** Poll cadence. Default 1000ms. Pyth publishes ~400ms; faster polling
   *  doesn't yield new ticks. */
  pollIntervalMs?: number;
  /** Override the Hermes base URL (default https://hermes.pyth.network). */
  hermesUrl?: string;
  /** RV rolling window (samples). Default 60 (= ~1 min at 1s poll). */
  rvWindow?: number;
}

interface HermesPriceField {
  price: string;        // signed integer string
  conf: string;         // unsigned integer string
  expo: number;         // signed; usually negative (e.g. -8)
  publish_time: number; // unix seconds
}

interface HermesEntry {
  id: string;
  price: HermesPriceField;
  ema_price: HermesPriceField;
}

interface HermesResponse {
  parsed?: HermesEntry[];
}

export class PythPriceSource implements PriceSource {
  readonly label = "pyth";

  private current_: PriceTick = {
    fairValue: 0n,
    confidenceBps: 0n,
    realizedVolBps: 0n,
    timestamp: 0,
  };
  private running = false;
  private timer?: number;
  private recentHumanPrices: number[] = [];
  private readonly url: string;
  private readonly pollMs: number;
  private readonly rvWindow: number;

  constructor(private opts: PythPriceSourceOpts) {
    if (!/^[0-9a-fA-F]{64}$/.test(opts.feedId)) {
      throw new Error(
        `PythPriceSource: feedId must be a 64-char hex string, got "${opts.feedId}"`
      );
    }
    if (opts.baseDecimals < 0 || opts.quoteDecimals < 0) {
      throw new Error("PythPriceSource: decimals must be non-negative");
    }
    const base = opts.hermesUrl ?? "https://hermes.pyth.network";
    this.url = `${base}/v2/updates/price/latest?ids[]=${opts.feedId}`;
    this.pollMs = opts.pollIntervalMs ?? 1000;
    this.rvWindow = opts.rvWindow ?? 60;
  }

  current(): Promise<PriceTick> {
    return Promise.resolve(this.current_);
  }

  async start(): Promise<() => void> {
    if (this.running) return () => this.stop();
    this.running = true;
    // Initial fetch — fail loudly if the feed is unreachable on boot so the
    // operator notices immediately, instead of silently emitting fairValue=0.
    await this.tick(/* throwOnError */ true);
    this.timer = setInterval(() => void this.tick(false), this.pollMs);
    return () => this.stop();
  }

  private stop() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.running = false;
  }

  private async tick(throwOnError: boolean): Promise<void> {
    try {
      const resp = await fetch(this.url, {
        headers: { accept: "application/json" },
      });
      if (!resp.ok) {
        const msg = `[pyth] HTTP ${resp.status} from ${this.url}`;
        if (throwOnError) throw new Error(msg);
        console.warn(msg);
        return;
      }
      const body = (await resp.json()) as HermesResponse;
      const entry = body.parsed?.[0];
      if (!entry) {
        const msg = `[pyth] empty parsed[] for feed ${this.opts.feedId}`;
        if (throwOnError) throw new Error(msg);
        console.warn(msg);
        return;
      }

      const tick = this.entryToTick(entry);
      this.current_ = tick;
    } catch (err) {
      const msg = `[pyth] tick failed: ${(err as Error).message}`;
      if (throwOnError) throw err;
      console.warn(msg);
    }
  }

  /** Visible for testing. */
  entryToTick(entry: HermesEntry): PriceTick {
    const rawSigned = BigInt(entry.price.price);
    if (rawSigned <= 0n) {
      throw new Error(`[pyth] non-positive price: ${entry.price.price}`);
    }
    const raw = rawSigned; // already positive
    const expo = entry.price.expo;
    const totalShift = expo + this.opts.quoteDecimals - this.opts.baseDecimals + 6;
    let fairValue: bigint;
    if (totalShift >= 0) {
      fairValue = raw * 10n ** BigInt(totalShift);
    } else {
      fairValue = raw / 10n ** BigInt(-totalShift);
    }

    // Confidence as bps of price. conf and price share the same expo, so the
    // ratio is exponent-free.
    const conf = BigInt(entry.price.conf);
    const confidenceBps = raw > 0n ? (conf * 10_000n) / raw : 0n;

    // Realized vol: rolling mean of |return| over the last rvWindow samples.
    // Float is fine here — this is a *signal* for mode switching, not money.
    const humanPrice = Number(raw) * Math.pow(10, expo);
    this.recentHumanPrices.push(humanPrice);
    if (this.recentHumanPrices.length > this.rvWindow) {
      this.recentHumanPrices.shift();
    }
    const rvBps = computeRollingRvBps(this.recentHumanPrices);

    return {
      fairValue,
      confidenceBps,
      realizedVolBps: BigInt(Math.round(rvBps)),
      timestamp: entry.price.publish_time * 1000,
    };
  }
}

function computeRollingRvBps(prices: number[]): number {
  if (prices.length < 2) return 0;
  let sumAbsRetBps = 0;
  let n = 0;
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    if (prev <= 0) continue;
    sumAbsRetBps += Math.abs((prices[i] - prev) / prev) * 10_000;
    n++;
  }
  return n > 0 ? sumAbsRetBps / n : 0;
}
