// ============================================================================
// FailoverPriceSource — multi-source with priority order
// ============================================================================
// Wraps N PriceSources. `current()` walks them in order and returns the
// first tick whose status is "fresh". If none are fresh, returns the
// least-bad tick (fresh > stale > halted > unknown) — the worker will see
// the bad status and refuse to push.
//
// `start()` starts every wrapped source in parallel so they all keep their
// internal state warm. There is no automatic source-switching during
// normal operation; the priority order is re-evaluated on every read.
//
// Intended composition:
//
//   primary  = pyth(BTC/USD)            # 24/7 crypto feed
//   fallback = mock(basePrice=42_000)   # safety net if Hermes is down
//   keeper  ← FailoverPriceSource([primary, fallback])
//
// For Stage 2 (devnet) we typically ship a single source; the wrapper is in
// place so the second adapter (Finnhub, Yahoo, on-chain Pyth, …) can be
// dropped in without touching the worker.

import type { PriceSource, PriceTick, PriceTickStatus } from "./types.ts";

const STATUS_RANK: Record<PriceTickStatus, number> = {
  fresh: 0,
  stale: 1,
  halted: 2,
  unknown: 3,
};

export class FailoverPriceSource implements PriceSource {
  readonly label: string;

  constructor(private sources: PriceSource[]) {
    if (sources.length === 0) {
      throw new Error("FailoverPriceSource: needs at least one source");
    }
    this.label = `failover(${sources.map((s) => s.label).join(",")})`;
  }

  async current(): Promise<PriceTick> {
    let best: PriceTick | undefined;
    for (const s of this.sources) {
      let tick: PriceTick;
      try {
        tick = await s.current();
      } catch (err) {
        console.warn(
          `[failover] ${s.label} threw on current(): ${(err as Error).message}`
        );
        continue;
      }
      if (tick.status === "fresh") return tick;
      if (!best || STATUS_RANK[tick.status] < STATUS_RANK[best.status]) {
        best = tick;
      }
    }
    // No source was fresh — return the best we got (or an explicit unknown
    // tick if everything threw).
    return (
      best ?? {
        fairValue: 0n,
        confidenceBps: 0n,
        realizedVolBps: 0n,
        timestamp: 0,
        status: "unknown",
      }
    );
  }

  async start(): Promise<() => void> {
    const stops = await Promise.all(this.sources.map((s) => s.start()));
    return () => {
      for (const stop of stops) {
        try {
          stop();
        } catch {
          /* ignore */
        }
      }
    };
  }
}
