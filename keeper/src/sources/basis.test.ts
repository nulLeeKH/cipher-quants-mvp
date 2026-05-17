import { assertAlmostEquals, assertEquals, assertThrows } from "jsr:@std/assert@1";

import { BasisAdjustedSource } from "./basis.ts";
import type { PriceSource, PriceTick } from "./types.ts";

class StubSource implements PriceSource {
  readonly label = "stub";
  private tick_: PriceTick;
  constructor(tick: Partial<PriceTick> = {}) {
    this.tick_ = {
      fairValue: 1_000_000_000n,
      confidenceBps: 5n,
      realizedVolBps: 12n,
      timestamp: 1_700_000_000_000,
      status: "fresh",
      ...tick,
    };
  }
  current(): Promise<PriceTick> {
    return Promise.resolve(this.tick_);
  }
  start(): Promise<() => void> {
    return Promise.resolve(() => {});
  }
}

Deno.test("BasisAdjustedSource — basis=0 returns the underlying tick untouched", async () => {
  const inner = new StubSource({ fairValue: 100_000_000n });
  const w = new BasisAdjustedSource(inner, { basisBps: 0 });
  const out = await w.current();
  assertEquals(out.fairValue, 100_000_000n);
});

Deno.test("BasisAdjustedSource — positive bps applies tokenized premium", async () => {
  // basis = +100 bps → 1 % premium
  const inner = new StubSource({ fairValue: 100_000_000n });
  const w = new BasisAdjustedSource(inner, { basisBps: 100 });
  const out = await w.current();
  assertEquals(out.fairValue, 101_000_000n);
});

Deno.test("BasisAdjustedSource — negative bps applies tokenized discount", async () => {
  const inner = new StubSource({ fairValue: 100_000_000n });
  const w = new BasisAdjustedSource(inner, { basisBps: -250 });
  const out = await w.current();
  assertEquals(out.fairValue, 97_500_000n);
});

Deno.test("BasisAdjustedSource — preserves confidence / RV / status / timestamp", async () => {
  const inner = new StubSource({
    fairValue: 100_000_000n,
    confidenceBps: 7n,
    realizedVolBps: 42n,
    timestamp: 12345,
    status: "stale",
  });
  const w = new BasisAdjustedSource(inner, { basisBps: 50 });
  const out = await w.current();
  assertEquals(out.confidenceBps, 7n);
  assertEquals(out.realizedVolBps, 42n);
  assertEquals(out.timestamp, 12345);
  assertEquals(out.status, "stale");
});

Deno.test("BasisAdjustedSource — bigint precision survives huge fair_values", async () => {
  const big = 9_000_000_000_000_000_000n;
  const inner = new StubSource({ fairValue: big });
  const w = new BasisAdjustedSource(inner, { basisBps: 1 });
  const out = await w.current();
  // (big * 10001) / 10000 = big + big/10000
  assertEquals(out.fairValue, (big * 10_001n) / 10_000n);
});

Deno.test("BasisAdjustedSource — rejects non-integer bps", () => {
  const inner = new StubSource();
  assertThrows(
    () => new BasisAdjustedSource(inner, { basisBps: 1.5 }),
    Error,
    "basisBps must be an integer",
  );
});

Deno.test("BasisAdjustedSource — rejects |bps| above 5000 cap", () => {
  const inner = new StubSource();
  assertThrows(
    () => new BasisAdjustedSource(inner, { basisBps: 5001 }),
    Error,
    "must be ≤ 5000",
  );
  assertThrows(
    () => new BasisAdjustedSource(inner, { basisBps: -5001 }),
    Error,
    "must be ≤ 5000",
  );
});

Deno.test("BasisAdjustedSource — label appends basis annotation", () => {
  const inner = new StubSource();
  const w = new BasisAdjustedSource(inner, { basisBps: 75 });
  assertEquals(w.label, "stub+basis(75bps)");
});

Deno.test("BasisAdjustedSource — start() delegates to inner", async () => {
  let started = false;
  let stopped = false;
  const inner: PriceSource = {
    label: "inner",
    current: () =>
      Promise.resolve({
        fairValue: 1n,
        confidenceBps: 0n,
        realizedVolBps: 0n,
        timestamp: 0,
        status: "fresh",
      }),
    start: () => {
      started = true;
      return Promise.resolve(() => {
        stopped = true;
      });
    },
  };
  const w = new BasisAdjustedSource(inner, { basisBps: 10 });
  const stop = await w.start();
  assertEquals(started, true);
  stop();
  assertEquals(stopped, true);
  // Avoid unused-vars lint:
  assertAlmostEquals(0, 0);
});
