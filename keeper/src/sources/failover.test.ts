import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import { FailoverPriceSource } from "./failover.ts";
import type { PriceSource, PriceTick, PriceTickStatus } from "./types.ts";

function stub(label: string, status: PriceTickStatus, fairValue = 1_000n): PriceSource {
  return {
    label,
    current: () =>
      Promise.resolve({
        fairValue,
        confidenceBps: 0n,
        realizedVolBps: 0n,
        timestamp: 0,
        status,
      } satisfies PriceTick),
    start: () => Promise.resolve(() => {}),
  };
}

function throwing(label: string): PriceSource {
  return {
    label,
    current: () => Promise.reject(new Error(`${label} boom`)),
    start: () => Promise.resolve(() => {}),
  };
}

Deno.test("FailoverPriceSource — rejects empty source list", () => {
  assertThrows(
    () => new FailoverPriceSource([]),
    Error,
    "needs at least one source",
  );
});

Deno.test("FailoverPriceSource — single fresh source returns its tick", async () => {
  const w = new FailoverPriceSource([stub("a", "fresh", 100n)]);
  const out = await w.current();
  assertEquals(out.status, "fresh");
  assertEquals(out.fairValue, 100n);
});

Deno.test("FailoverPriceSource — fresh primary wins, fallback is not consulted", async () => {
  let fallbackCalled = false;
  const fallback: PriceSource = {
    label: "fallback",
    current: () => {
      fallbackCalled = true;
      return Promise.resolve({
        fairValue: 999n,
        confidenceBps: 0n,
        realizedVolBps: 0n,
        timestamp: 0,
        status: "fresh",
      });
    },
    start: () => Promise.resolve(() => {}),
  };
  const w = new FailoverPriceSource([stub("primary", "fresh", 100n), fallback]);
  const out = await w.current();
  assertEquals(out.fairValue, 100n);
  assertEquals(fallbackCalled, false);
});

Deno.test("FailoverPriceSource — stale primary falls through to fresh fallback", async () => {
  const w = new FailoverPriceSource([
    stub("primary", "stale", 100n),
    stub("fallback", "fresh", 999n),
  ]);
  const out = await w.current();
  assertEquals(out.fairValue, 999n);
  assertEquals(out.status, "fresh");
});

Deno.test("FailoverPriceSource — all non-fresh returns best status (stale > halted > unknown)", async () => {
  const w = new FailoverPriceSource([
    stub("a", "halted", 1n),
    stub("b", "stale", 2n),
    stub("c", "unknown", 3n),
  ]);
  const out = await w.current();
  assertEquals(out.status, "stale");
  assertEquals(out.fairValue, 2n);
});

Deno.test("FailoverPriceSource — throwing sources are skipped, not fatal", async () => {
  const w = new FailoverPriceSource([
    throwing("primary"),
    stub("fallback", "fresh", 42n),
  ]);
  const out = await w.current();
  assertEquals(out.status, "fresh");
  assertEquals(out.fairValue, 42n);
});

Deno.test("FailoverPriceSource — all-throwing returns explicit unknown placeholder", async () => {
  const w = new FailoverPriceSource([throwing("a"), throwing("b")]);
  const out = await w.current();
  assertEquals(out.status, "unknown");
  assertEquals(out.fairValue, 0n);
});

Deno.test("FailoverPriceSource — label lists every wrapped source", () => {
  const w = new FailoverPriceSource([stub("a", "fresh"), stub("b", "fresh")]);
  assertEquals(w.label, "failover(a,b)");
});

Deno.test("FailoverPriceSource — start() launches every source; returned stop() stops all", async () => {
  const started: string[] = [];
  const stopped: string[] = [];
  const mk = (name: string): PriceSource => ({
    label: name,
    current: () =>
      Promise.resolve({
        fairValue: 0n,
        confidenceBps: 0n,
        realizedVolBps: 0n,
        timestamp: 0,
        status: "fresh",
      }),
    start: () => {
      started.push(name);
      return Promise.resolve(() => {
        stopped.push(name);
      });
    },
  });
  const w = new FailoverPriceSource([mk("a"), mk("b")]);
  const stop = await w.start();
  assertEquals(started.sort(), ["a", "b"]);
  stop();
  assertEquals(stopped.sort(), ["a", "b"]);
});
