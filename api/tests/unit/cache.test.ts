import { assertEquals } from "@std/assert";

import { createBoundedTtlCache } from "../../src/cache.ts";

// Controllable clock so we don't actually wait for ms to pass.
function mkClock(
  start = 1_000,
): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

Deno.test("cache — set/get round-trip within TTL", () => {
  const clk = mkClock();
  const c = createBoundedTtlCache<string>({
    maxEntries: 10,
    ttlMs: 1_000,
    now: clk.now,
  });
  c.set("k", "v");
  assertEquals(c.get("k"), "v");
  clk.advance(500);
  assertEquals(c.get("k"), "v");
  c.stop();
});

Deno.test("cache — expired entry is dropped lazily on get", () => {
  const clk = mkClock();
  const c = createBoundedTtlCache<string>({
    maxEntries: 10,
    ttlMs: 1_000,
    now: clk.now,
  });
  c.set("k", "v");
  clk.advance(1_001);
  assertEquals(c.get("k"), undefined);
  assertEquals(c.size(), 0); // get() removes it
  c.stop();
});

Deno.test("cache — re-set extends TTL (re-insert at tail)", () => {
  const clk = mkClock();
  const c = createBoundedTtlCache<string>({
    maxEntries: 10,
    ttlMs: 1_000,
    now: clk.now,
  });
  c.set("k", "v");
  clk.advance(800);
  c.set("k", "v2"); // resets TTL
  clk.advance(500);
  assertEquals(c.get("k"), "v2");
  c.stop();
});

Deno.test("cache — eviction respects maxEntries (FIFO/LRU by insertion)", () => {
  const clk = mkClock();
  const c = createBoundedTtlCache<number>({
    maxEntries: 3,
    ttlMs: 100_000,
    now: clk.now,
  });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.set("d", 4); // evicts "a"
  assertEquals(c.get("a"), undefined);
  assertEquals(c.get("b"), 2);
  assertEquals(c.get("c"), 3);
  assertEquals(c.get("d"), 4);
  c.stop();
});

Deno.test("cache — re-setting a key moves it to the tail (avoids eviction)", () => {
  const clk = mkClock();
  const c = createBoundedTtlCache<number>({
    maxEntries: 3,
    ttlMs: 100_000,
    now: clk.now,
  });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.set("a", 10); // a moves to tail
  c.set("d", 4); // evicts "b" (now oldest), not "a"
  assertEquals(c.get("a"), 10);
  assertEquals(c.get("b"), undefined);
  assertEquals(c.get("d"), 4);
  c.stop();
});

Deno.test("cache — delete works", () => {
  const c = createBoundedTtlCache<string>({ maxEntries: 5, ttlMs: 1_000 });
  c.set("k", "v");
  c.delete("k");
  assertEquals(c.get("k"), undefined);
  c.stop();
});

Deno.test("cache — stop() halts the background sweep", async () => {
  const c = createBoundedTtlCache<string>({
    maxEntries: 5,
    ttlMs: 1_000,
    sweepIntervalMs: 5,
  });
  c.set("k", "v");
  c.stop();
  // If stop() didn't clear the interval, this test would leak (Deno tests
  // assert no leaked timers).
  await new Promise((r) => setTimeout(r, 20));
});
