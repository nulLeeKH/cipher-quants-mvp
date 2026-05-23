import { assertEquals } from "jsr:@std/assert@1";

import { computeFreshness } from "./freshness.ts";

Deno.test("computeFreshness — fresh inside TTL window", () => {
  const f = computeFreshness({
    lastOracleUpdateSlot: 1_000,
    currentModeTtl: 3,
    paused: false,
    currentSlot: 1_002,
  });
  assertEquals(f.fresh, true);
  assertEquals(f.ageSlots, 2);
  assertEquals(f.ttlRemainingSlots, 1);
  assertEquals(f.recommendedPath, "curve");
});

Deno.test("computeFreshness — stale when age > ttl", () => {
  const f = computeFreshness({
    lastOracleUpdateSlot: 1_000,
    currentModeTtl: 3,
    paused: false,
    currentSlot: 1_010,
  });
  assertEquals(f.fresh, false);
  assertEquals(f.ageSlots, 10);
  assertEquals(f.ttlRemainingSlots, 0);
  assertEquals(f.recommendedPath, "rfq");
});

Deno.test("computeFreshness — Mode C (ttl=0) is always stale → rfq", () => {
  const f = computeFreshness({
    lastOracleUpdateSlot: 1_000,
    currentModeTtl: 0,
    paused: false,
    currentSlot: 1_000, // even at the exact push slot
  });
  assertEquals(f.fresh, false);
  assertEquals(f.recommendedPath, "rfq");
});

Deno.test("computeFreshness — exact boundary: age == ttl is still fresh (<=)", () => {
  const f = computeFreshness({
    lastOracleUpdateSlot: 1_000,
    currentModeTtl: 3,
    paused: false,
    currentSlot: 1_003,
  });
  assertEquals(f.fresh, true);
  assertEquals(f.ttlRemainingSlots, 0);
});

Deno.test("computeFreshness — paused overrides everything → none", () => {
  const f = computeFreshness({
    lastOracleUpdateSlot: 1_000,
    currentModeTtl: 3,
    paused: true,
    currentSlot: 1_001,
  });
  assertEquals(f.recommendedPath, "none");
  // Mechanical fields still populated for diagnostics.
  assertEquals(f.fresh, true);
  assertEquals(f.paused, true);
});

Deno.test("computeFreshness — slot underflow clamped to 0 (fork edge case)", () => {
  const f = computeFreshness({
    lastOracleUpdateSlot: 1_010,
    currentModeTtl: 3,
    paused: false,
    currentSlot: 1_000, // RPC lagging behind the push slot
  });
  assertEquals(f.ageSlots, 0);
  assertEquals(f.fresh, true);
});
