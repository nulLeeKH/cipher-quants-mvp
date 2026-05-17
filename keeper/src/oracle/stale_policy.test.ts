import { assertEquals } from "jsr:@std/assert@1";

import {
  DEFAULT_STALE_HOLDOFF_MS,
  evaluateStalePolicy,
} from "./stale_policy.ts";

Deno.test("stale policy — successful push clears the staleness clock", () => {
  const out = evaluateStalePolicy(
    {
      pushed: true,
      firstStaleObservedAt: 12_345,
      holdoffMs: 30_000,
      alreadyModeC: false,
    },
    50_000,
  );
  assertEquals(out.firstStaleObservedAt, null);
  assertEquals(out.forceModeC, false);
  assertEquals(out.message, null);
});

Deno.test("stale policy — first non-fresh sets the staleness clock without forcing", () => {
  const out = evaluateStalePolicy(
    {
      pushed: false,
      firstStaleObservedAt: null,
      holdoffMs: 30_000,
      alreadyModeC: false,
    },
    100_000,
  );
  assertEquals(out.firstStaleObservedAt, 100_000);
  assertEquals(out.forceModeC, false);
});

Deno.test("stale policy — sustained non-fresh under holdoff: no force yet", () => {
  // 20 s elapsed, 30 s holdoff
  const out = evaluateStalePolicy(
    {
      pushed: false,
      firstStaleObservedAt: 100_000,
      holdoffMs: 30_000,
      alreadyModeC: false,
    },
    120_000,
  );
  assertEquals(out.firstStaleObservedAt, 100_000); // unchanged
  assertEquals(out.forceModeC, false);
});

Deno.test("stale policy — non-fresh past holdoff forces Mode C with a message", () => {
  const out = evaluateStalePolicy(
    {
      pushed: false,
      firstStaleObservedAt: 100_000,
      holdoffMs: 30_000,
      alreadyModeC: false,
    },
    131_000, // 31 s elapsed
  );
  assertEquals(out.forceModeC, true);
  assertEquals(out.firstStaleObservedAt, 100_000);
  // Message should mention the duration in seconds.
  if (out.message === null) throw new Error("expected a message");
  assertEquals(out.message.includes("31s"), true);
});

Deno.test("stale policy — already in Mode C: no repeat force", () => {
  const out = evaluateStalePolicy(
    {
      pushed: false,
      firstStaleObservedAt: 100_000,
      holdoffMs: 30_000,
      alreadyModeC: true, // already there
    },
    200_000,
  );
  assertEquals(out.forceModeC, false);
  assertEquals(out.message, null);
  // Clock keeps ticking — we still record the first-stale-at.
  assertEquals(out.firstStaleObservedAt, 100_000);
});

Deno.test("stale policy — exactly at the holdoff boundary does NOT force (> not ≥)", () => {
  const out = evaluateStalePolicy(
    {
      pushed: false,
      firstStaleObservedAt: 100_000,
      holdoffMs: 30_000,
      alreadyModeC: false,
    },
    130_000, // exactly equal
  );
  assertEquals(out.forceModeC, false);
});

Deno.test("DEFAULT_STALE_HOLDOFF_MS — 30 s, matches the worker constant", () => {
  assertEquals(DEFAULT_STALE_HOLDOFF_MS, 30_000);
});
