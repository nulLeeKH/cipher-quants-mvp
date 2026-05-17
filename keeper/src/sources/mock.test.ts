import { assertEquals } from "jsr:@std/assert@1";

import { MockPriceSource } from "./mock.ts";

Deno.test("MockPriceSource — initial tick uses basePrice and status=fresh", async () => {
  const src = new MockPriceSource({
    basePrice: 200_000_000n,
    stepBps: 5,
    tickIntervalMs: 1_000_000, // effectively never ticks during the test
    spikeProb: 0,
    spikeMagnitudeBps: 0,
  });
  const t = await src.current();
  assertEquals(t.fairValue, 200_000_000n);
  assertEquals(t.status, "fresh");
  assertEquals(t.confidenceBps, 0n);
});

Deno.test("MockPriceSource — label is 'mock'", () => {
  const src = new MockPriceSource({
    basePrice: 1n,
    stepBps: 0,
    tickIntervalMs: 1_000_000,
    spikeProb: 0,
    spikeMagnitudeBps: 0,
  });
  assertEquals(src.label, "mock");
});

Deno.test("MockPriceSource — start() / stop() lifecycle is idempotent", async () => {
  const src = new MockPriceSource({
    basePrice: 1n,
    stepBps: 0,
    tickIntervalMs: 1_000_000,
    spikeProb: 0,
    spikeMagnitudeBps: 0,
  });
  const stop1 = await src.start();
  const stop2 = await src.start(); // second start returns a stop fn too
  stop1();
  stop2(); // safe to double-stop
});

Deno.test("MockPriceSource — fast tick mutates fairValue within bounded range", async () => {
  const src = new MockPriceSource({
    basePrice: 1_000_000n,
    stepBps: 10,
    tickIntervalMs: 5,
    spikeProb: 0,
    spikeMagnitudeBps: 0,
  });
  const stop = await src.start();
  // Let it tick a handful of times.
  await new Promise((r) => setTimeout(r, 60));
  stop();
  const t = await src.current();
  // After 60 ms / 5 ms = ~12 steps of ±10 bps, fair_value should still be
  // in the same order of magnitude — guard against runaway drift.
  assertEquals(t.fairValue > 100_000n, true);
  assertEquals(t.fairValue < 100_000_000n, true);
  assertEquals(t.status, "fresh");
});

Deno.test("MockPriceSource — flat config (stepBps=0, no spike) returns base forever", async () => {
  const src = new MockPriceSource({
    basePrice: 50_000n,
    stepBps: 0,
    tickIntervalMs: 5,
    spikeProb: 0,
    spikeMagnitudeBps: 0,
  });
  const stop = await src.start();
  await new Promise((r) => setTimeout(r, 30));
  stop();
  const t = await src.current();
  assertEquals(t.fairValue, 50_000n);
});

Deno.test("MockPriceSource — spike with probability 1 always perturbs", async () => {
  const src = new MockPriceSource({
    basePrice: 1_000_000n,
    stepBps: 0, // no random walk → only spike contributes
    tickIntervalMs: 5,
    spikeProb: 1,
    spikeMagnitudeBps: 100, // 1 % per tick
  });
  const stop = await src.start();
  await new Promise((r) => setTimeout(r, 30));
  stop();
  const t = await src.current();
  // After multiple ticks with ±1% spikes, value WILL have moved away from base
  // (probability of returning exactly to 1_000_000 is vanishing).
  assertEquals(t.fairValue !== 1_000_000n, true);
});
