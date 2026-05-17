// ============================================================================
// PythPriceSource — Pyth Hermes adapter (REST polling + SSE streaming)
// ============================================================================
// docs/OPERATIONS.md §3.1, TODO.md §1 — first real (non-mock) price source.
//
// Pyth Hermes is the HTTP gateway over the Pyth Wormhole VAA stream:
//   REST: GET  https://hermes.pyth.network/v2/updates/price/latest?ids[]=<id>
//   SSE:  GET  https://hermes.pyth.network/v2/updates/price/stream?ids[]=<id>
//
// Free, no API key. SSE is push-based (matches Pyth's ~400 ms publish cadence
// without polling overhead) and is the right choice for production. Polling
// is kept as a fallback for environments behind proxies that drop long-lived
// connections.
//
// Feed IDs: https://pyth.network/developers/price-feed-ids
//   BTC/USD   e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
//   SOL/USD   ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
//   AAPL/USD  49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688
//
// ────────────────────────────────────────────────────────────────────────────
// IMPORTANT — "underlying" vs "tokenized" price
// ────────────────────────────────────────────────────────────────────────────
// Pyth publishes the *underlying* asset price (NYSE AAPL, native BTC,
// native SOL, etc.). For tokenized assets such as xStocks (Backed's AAPLx,
// TSLAx, …) there is a basis (premium / discount, redemption cost, off-hours
// drift) between the underlying and the on-chain token. This adapter does
// NOT correct for that — basis adjustment is handled by `BasisAdjustedSource`
// in `basis.ts`. The intended pipeline is:
//
//     PythPriceSource (underlying)
//       └─► BasisAdjustedSource (basis bps, configurable / future-feed-driven)
//             └─► keeper worker
//
// For PoC and crypto pairs (BTC/USDC, SOL/USDC) the basis is ~0; the wrapper
// is a no-op and we can use this source directly. When trading xStocks the
// basis must be set via env or a dynamic basis feed before going live.
// ────────────────────────────────────────────────────────────────────────────
//
// Staleness handling: Pyth equity feeds stop publishing outside US market
// hours. `publish_time` becomes older than `maxStalenessSec`, at which point
// we tag the tick as `"stale"`. The worker MUST refuse to push stale ticks
// (would otherwise advertise an out-of-date curve as fresh on-chain).

import type { PriceSource, PriceTick, PriceTickStatus } from "./types.ts";

export type PythQuoteKind = "spot" | "ema";

export interface PythPriceSourceOpts {
  /** 64-char hex feed id (no leading 0x). */
  feedId: string;
  /** Base mint decimals (e.g. 6 for xStocks/USDC pair). */
  baseDecimals: number;
  /** Quote mint decimals. */
  quoteDecimals: number;
  /**
   * Transport: `"poll"` issues REST requests every `pollIntervalMs`, `"sse"`
   * subscribes to the Hermes event stream. Default `"sse"` — push-based
   * removes RTT from the Mode-A push budget.
   */
  transport?: "poll" | "sse";
  /** Poll cadence (ms). Only used when transport = "poll". Default 1000. */
  pollIntervalMs?: number;
  /** Use the EMA price (smoothed) instead of spot. Default false (spot). */
  quoteKind?: PythQuoteKind;
  /**
   * Tick is `"stale"` when `now - publish_time > maxStalenessSec`. Defaults
   * to 60 s — appropriate for crypto. For equity feeds (which freeze
   * outside US market hours by design) this is *expected* off-hours and the
   * worker should respond by holding Mode C.
   */
  maxStalenessSec?: number;
  /** Override the Hermes base URL (default https://hermes.pyth.network). */
  hermesUrl?: string;
  /** RV rolling window (samples). Default 60. */
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

const INITIAL_TICK: PriceTick = {
  fairValue: 0n,
  confidenceBps: 0n,
  realizedVolBps: 0n,
  timestamp: 0,
  status: "unknown",
};

export class PythPriceSource implements PriceSource {
  readonly label: string;

  private current_: PriceTick = INITIAL_TICK;
  private running = false;
  private abort = new AbortController();
  private pollTimer?: number;
  private recentHumanPrices: number[] = [];
  private readonly hermesBase: string;
  private readonly transport: "poll" | "sse";
  private readonly pollMs: number;
  private readonly rvWindow: number;
  private readonly maxStalenessMs: number;
  private readonly quoteKind: PythQuoteKind;

  constructor(private opts: PythPriceSourceOpts) {
    if (!/^[0-9a-fA-F]{64}$/.test(opts.feedId)) {
      throw new Error(
        `PythPriceSource: feedId must be a 64-char hex string, got "${opts.feedId}"`
      );
    }
    if (opts.baseDecimals < 0 || opts.quoteDecimals < 0) {
      throw new Error("PythPriceSource: decimals must be non-negative");
    }
    this.hermesBase = (opts.hermesUrl ?? "https://hermes.pyth.network").replace(/\/$/, "");
    this.transport = opts.transport ?? "sse";
    this.pollMs = opts.pollIntervalMs ?? 1000;
    this.rvWindow = opts.rvWindow ?? 60;
    this.maxStalenessMs = (opts.maxStalenessSec ?? 60) * 1000;
    this.quoteKind = opts.quoteKind ?? "spot";
    this.label = `pyth:${this.transport}:${this.quoteKind}`;
  }

  current(): Promise<PriceTick> {
    // On every read, refresh the staleness verdict against wall time. The
    // underlying tick data doesn't change between fetches; only the
    // staleness label can flip if the source went quiet.
    return Promise.resolve(this.withFreshStatus(this.current_));
  }

  async start(): Promise<() => void> {
    if (this.running) return () => this.stop();
    this.running = true;

    if (this.transport === "poll") {
      // Initial fetch — fail loudly so a misconfigured feed id surfaces at
      // boot rather than producing fairValue=0 silently.
      await this.pollOnce(/* throwOnError */ true);
      this.pollTimer = setInterval(() => void this.pollOnce(false), this.pollMs);
    } else {
      // SSE: kick off the streaming loop in the background; do an initial
      // REST fetch so `current()` returns a real value before the first
      // server-sent event arrives.
      await this.pollOnce(/* throwOnError */ true);
      void this.runSseLoop();
    }
    return () => this.stop();
  }

  private stop() {
    this.running = false;
    this.abort.abort();
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
  }

  // ──────────────────────────────────────────────────────────────────────
  // REST polling
  // ──────────────────────────────────────────────────────────────────────

  private async pollOnce(throwOnError: boolean): Promise<void> {
    const url = `${this.hermesBase}/v2/updates/price/latest?ids[]=${this.opts.feedId}`;
    try {
      const resp = await fetch(url, {
        headers: { accept: "application/json" },
        signal: this.abort.signal,
      });
      if (!resp.ok) {
        const msg = `[pyth] HTTP ${resp.status} from ${url}`;
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
      this.current_ = this.entryToTick(entry);
    } catch (err) {
      if (this.abort.signal.aborted) return;
      const msg = `[pyth] poll failed: ${(err as Error).message}`;
      if (throwOnError) throw err;
      console.warn(msg);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // SSE streaming
  // ──────────────────────────────────────────────────────────────────────
  // Reconnects on disconnect / network blip with exponential backoff
  // (capped at 30 s). The keeper outlives any single TCP connection.

  private async runSseLoop(): Promise<void> {
    const url = `${this.hermesBase}/v2/updates/price/stream?ids[]=${this.opts.feedId}`;
    let backoffMs = 500;

    while (this.running && !this.abort.signal.aborted) {
      try {
        const resp = await fetch(url, {
          headers: { accept: "text/event-stream" },
          signal: this.abort.signal,
        });
        if (!resp.ok || !resp.body) {
          throw new Error(`HTTP ${resp.status}`);
        }
        backoffMs = 500; // reset on successful connect
        await this.consumeSseStream(resp.body);
        // Server closed the stream cleanly — loop and reconnect.
        console.warn(`[pyth] SSE stream closed by server; reconnecting`);
      } catch (err) {
        if (this.abort.signal.aborted) return;
        console.warn(
          `[pyth] SSE error: ${(err as Error).message}; reconnect in ${backoffMs}ms`
        );
      }
      // Backoff before reconnect, but wake up on abort.
      await this.sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }

  private async consumeSseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (this.running && !this.abort.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        // SSE framing: events separated by \n\n; each event is one or more
        // `field: value` lines. We only care about `data:` payloads.
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "{}") continue;
            try {
              const parsed = JSON.parse(payload) as HermesResponse;
              const entry = parsed.parsed?.[0];
              if (entry) this.current_ = this.entryToTick(entry);
            } catch {
              // Malformed event — skip, don't blow up the stream.
            }
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.abort.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      if (this.abort.signal.aborted) {
        clearTimeout(t);
        resolve();
        return;
      }
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Tick conversion
  // ──────────────────────────────────────────────────────────────────────

  /** Visible for testing. */
  entryToTick(entry: HermesEntry): PriceTick {
    const src = this.quoteKind === "ema" ? entry.ema_price : entry.price;

    // Pyth encodes "unknown" status as price <= 0 or conf == 0. Treat as
    // halted — the feed exists but isn't reporting a usable number.
    const rawSigned = BigInt(src.price);
    if (rawSigned <= 0n || src.conf === "0") {
      return {
        ...INITIAL_TICK,
        timestamp: src.publish_time * 1000,
        status: "halted",
      };
    }

    const raw = rawSigned;
    const expo = src.expo;
    const totalShift = expo + this.opts.quoteDecimals - this.opts.baseDecimals + 6;
    let fairValue: bigint;
    if (totalShift >= 0) {
      fairValue = raw * 10n ** BigInt(totalShift);
    } else {
      fairValue = raw / 10n ** BigInt(-totalShift);
    }

    const conf = BigInt(src.conf);
    const confidenceBps = raw > 0n ? (conf * 10_000n) / raw : 0n;

    const humanPrice = Number(raw) * Math.pow(10, expo);
    this.recentHumanPrices.push(humanPrice);
    if (this.recentHumanPrices.length > this.rvWindow) {
      this.recentHumanPrices.shift();
    }
    const rvBps = computeRollingRvBps(this.recentHumanPrices);

    const tsMs = src.publish_time * 1000;
    return {
      fairValue,
      confidenceBps,
      realizedVolBps: BigInt(Math.round(rvBps)),
      timestamp: tsMs,
      // Status is computed against wall time at read time, not write time
      // (see `current()`). Set the optimistic value here; downgrade later
      // if `now - publish_time` exceeds the threshold.
      status: "fresh",
    };
  }

  private withFreshStatus(tick: PriceTick): PriceTick {
    if (tick.status === "unknown" || tick.status === "halted") return tick;
    const age = Date.now() - tick.timestamp;
    if (age > this.maxStalenessMs) {
      return { ...tick, status: "stale" satisfies PriceTickStatus };
    }
    return tick;
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
