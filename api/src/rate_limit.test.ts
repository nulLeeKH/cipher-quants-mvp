import { assertEquals } from "jsr:@std/assert@1";

import { createSlidingWindowRateLimiter } from "./rate_limit.ts";

function mkClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

Deno.test("rate limit — under the threshold returns false", () => {
  const clk = mkClock();
  const rl = createSlidingWindowRateLimiter({ windowMs: 1_000, now: clk.now });
  for (let i = 0; i < 5; i++) {
    assertEquals(rl.isLimited("1.2.3.4", 10), false);
  }
  rl.stop();
});

Deno.test("rate limit — at the threshold blocks subsequent calls", () => {
  const clk = mkClock();
  const rl = createSlidingWindowRateLimiter({ windowMs: 1_000, now: clk.now });
  for (let i = 0; i < 5; i++) {
    assertEquals(rl.isLimited("ip", 5), false);
  }
  // 6th hit in the same window → blocked.
  assertEquals(rl.isLimited("ip", 5), true);
  rl.stop();
});

Deno.test("rate limit — window slides as time advances", () => {
  const clk = mkClock();
  const rl = createSlidingWindowRateLimiter({ windowMs: 1_000, now: clk.now });
  for (let i = 0; i < 5; i++) rl.isLimited("ip", 5);
  assertEquals(rl.isLimited("ip", 5), true);
  clk.advance(1_001); // all previous hits fall outside the window
  assertEquals(rl.isLimited("ip", 5), false);
  rl.stop();
});

Deno.test("rate limit — distinct keys have independent buckets", () => {
  const rl = createSlidingWindowRateLimiter({ windowMs: 1_000 });
  for (let i = 0; i < 5; i++) rl.isLimited("a", 5);
  assertEquals(rl.isLimited("a", 5), true);
  assertEquals(rl.isLimited("b", 5), false);
  rl.stop();
});

Deno.test("rate limit — buckets() count grows then cleanup drops empties", async () => {
  const rl = createSlidingWindowRateLimiter({
    windowMs: 50,
    cleanupIntervalMs: 30,
  });
  rl.isLimited("a", 5);
  rl.isLimited("b", 5);
  assertEquals(rl.buckets(), 2);
  // Wait past window + 1 cleanup cycle.
  await new Promise((r) => setTimeout(r, 120));
  assertEquals(rl.buckets(), 0);
  rl.stop();
});

Deno.test("rate limit — limit=0 always blocks", () => {
  const rl = createSlidingWindowRateLimiter({ windowMs: 1_000 });
  assertEquals(rl.isLimited("ip", 0), true);
  rl.stop();
});
