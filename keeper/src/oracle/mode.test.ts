import { assertEquals } from "jsr:@std/assert@1";

import {
  calendarFloor,
  decideMode,
  DEFAULT_THRESHOLDS,
  modeToTtl,
  type ModeDecisionInputs,
} from "./mode.ts";
import type { PriceTick } from "../sources/types.ts";

// ────────────────────────────────────────────────────────────────────────────
// modeToTtl — A=1, B=3, C=0 per OPERATIONS §1
// ────────────────────────────────────────────────────────────────────────────

Deno.test("modeToTtl — A → 1 slot", () => assertEquals(modeToTtl("A"), 1));
Deno.test("modeToTtl — B → 3 slots", () => assertEquals(modeToTtl("B"), 3));
Deno.test("modeToTtl — C → 0 (forced stale)", () => assertEquals(modeToTtl("C"), 0));

// ────────────────────────────────────────────────────────────────────────────
// calendarFloor — US-equity schedule (xStocks). Times are America/New_York.
// ────────────────────────────────────────────────────────────────────────────
// Helper: produce a millisecond timestamp for a given ET date+time. Built
// from a known UTC instant + offset so DST is handled correctly in 2026
// (DST starts 2026-03-08, ends 2026-11-01).

function etTimestamp(isoUtc: string): number {
  return new Date(isoUtc).getTime();
}

Deno.test("calendarFloor — Sunday → C (weekend)", () => {
  // 2026-05-17 is a Sunday. Any hour during ET → C.
  assertEquals(calendarFloor(etTimestamp("2026-05-17T15:00:00Z")), "C");
});

Deno.test("calendarFloor — Saturday → C", () => {
  // 2026-05-16 Saturday.
  assertEquals(calendarFloor(etTimestamp("2026-05-16T15:00:00Z")), "C");
});

Deno.test("calendarFloor — NYSE holiday (Memorial Day 2026-05-25) → C", () => {
  // Memorial Day 2026 — mid-day ET (15:00 ET = 19:00 UTC during EDT).
  assertEquals(calendarFloor(etTimestamp("2026-05-25T19:00:00Z")), "C");
});

Deno.test("calendarFloor — NYSE holiday (Christmas 2026-12-25) → C", () => {
  // Standard time (EST = UTC-5). 14:00 ET = 19:00 UTC.
  assertEquals(calendarFloor(etTimestamp("2026-12-25T19:00:00Z")), "C");
});

Deno.test("calendarFloor — weekday 02:00 ET (overnight) → C", () => {
  // 2026-06-04 Thursday, 02:00 ET = 06:00 UTC (EDT).
  assertEquals(calendarFloor(etTimestamp("2026-06-04T06:00:00Z")), "C");
});

Deno.test("calendarFloor — weekday 09:15 ET (15min pre-open, within A window) → A", () => {
  // 2026-06-04 Thursday, 09:15 ET = 13:15 UTC (EDT). A window is 09:00-10:00.
  assertEquals(calendarFloor(etTimestamp("2026-06-04T13:15:00Z")), "A");
});

Deno.test("calendarFloor — weekday 09:45 ET (mid-open A window) → A", () => {
  assertEquals(calendarFloor(etTimestamp("2026-06-04T13:45:00Z")), "A");
});

Deno.test("calendarFloor — weekday 10:30 ET (post-open, normal trading) → B", () => {
  assertEquals(calendarFloor(etTimestamp("2026-06-04T14:30:00Z")), "B");
});

Deno.test("calendarFloor — weekday 15:00 ET (mid-day) → B", () => {
  assertEquals(calendarFloor(etTimestamp("2026-06-04T19:00:00Z")), "B");
});

Deno.test("calendarFloor — weekday 15:45 ET (close A window) → A", () => {
  // 15:30-16:30 ET is A. 15:45 ET = 19:45 UTC (EDT).
  assertEquals(calendarFloor(etTimestamp("2026-06-04T19:45:00Z")), "A");
});

Deno.test("calendarFloor — weekday 16:15 ET (post-close A window tail) → A", () => {
  assertEquals(calendarFloor(etTimestamp("2026-06-04T20:15:00Z")), "A");
});

Deno.test("calendarFloor — weekday 17:00 ET (after close) → C", () => {
  // 17:00 ET = 21:00 UTC (EDT). After A_POST_CLOSE = 16:30 → C.
  assertEquals(calendarFloor(etTimestamp("2026-06-04T21:00:00Z")), "C");
});

Deno.test("calendarFloor — DST boundary: 2026-03-09 (Mon after DST start) 10:30 ET → B", () => {
  // 2026-03-08 is DST start. 2026-03-09 Monday, 10:30 ET = 14:30 UTC (EDT now).
  assertEquals(calendarFloor(etTimestamp("2026-03-09T14:30:00Z")), "B");
});

Deno.test("calendarFloor — DST boundary: 2026-11-02 (Mon after DST end) 10:30 ET → B", () => {
  // 2026-11-02 Monday, 10:30 ET = 15:30 UTC (EST = UTC-5).
  assertEquals(calendarFloor(etTimestamp("2026-11-02T15:30:00Z")), "B");
});

Deno.test("calendarFloor — 2027 holiday (New Year's Day) → C", () => {
  // 2027-01-01 Friday, mid-day ET.
  assertEquals(calendarFloor(etTimestamp("2027-01-01T17:00:00Z")), "C");
});

// ────────────────────────────────────────────────────────────────────────────
// decideMode — reactive + cooldown + calendar interaction
// ────────────────────────────────────────────────────────────────────────────

function tick(rvBps = 0): PriceTick {
  return {
    fairValue: 100_000_000n,
    confidenceBps: 0n,
    realizedVolBps: BigInt(rvBps),
    timestamp: Date.now(),
    status: "fresh",
  };
}

function inputs(over: Partial<ModeDecisionInputs> = {}): ModeDecisionInputs {
  return {
    current: "C",
    tick: tick(),
    lastChangeAt: 0,
    lastUpgradeTriggerAt: 0,
    nbbo30sMoveBps: 0,
    calendar: "off", // disable calendar so reactive logic is testable in isolation
    ...over,
  };
}

const FAR_FUTURE = etTimestamp("2026-05-25T19:00:00Z"); // Memorial Day → calendar=off keeps reactive

Deno.test("decideMode — cooldown blocks transitions inside modeMinDwellMs", () => {
  // RV spike present but lastChangeAt was just now (0 ms ago)
  const next = decideMode(
    inputs({
      current: "B",
      tick: tick(500), // high RV
      lastChangeAt: FAR_FUTURE - 1_000, // 1s ago
    }),
    DEFAULT_THRESHOLDS,
    FAR_FUTURE,
  );
  assertEquals(next, "B");
});

Deno.test("decideMode — C → B on RV upgrade signal", () => {
  const next = decideMode(
    inputs({
      current: "C",
      tick: tick(200), // > 150 bps threshold
      lastChangeAt: FAR_FUTURE - 60_000,
    }),
    DEFAULT_THRESHOLDS,
    FAR_FUTURE,
  );
  assertEquals(next, "B");
});

Deno.test("decideMode — B → A on RV upgrade signal", () => {
  const next = decideMode(
    inputs({
      current: "B",
      tick: tick(200),
      lastChangeAt: FAR_FUTURE - 60_000,
    }),
    DEFAULT_THRESHOLDS,
    FAR_FUTURE,
  );
  assertEquals(next, "A");
});

Deno.test("decideMode — C → B on NBBO move upgrade signal", () => {
  const next = decideMode(
    inputs({
      current: "C",
      nbbo30sMoveBps: 30, // > 15 bps threshold
      lastChangeAt: FAR_FUTURE - 60_000,
    }),
    DEFAULT_THRESHOLDS,
    FAR_FUTURE,
  );
  assertEquals(next, "B");
});

Deno.test("decideMode — A → B downgrade after quiet 180s+", () => {
  const next = decideMode(
    inputs({
      current: "A",
      lastChangeAt: FAR_FUTURE - 300_000,
      lastUpgradeTriggerAt: FAR_FUTURE - 200_000, // 200s ago > 180s
    }),
    DEFAULT_THRESHOLDS,
    FAR_FUTURE,
  );
  assertEquals(next, "B");
});

Deno.test("decideMode — A → B requires the full quiet window", () => {
  const next = decideMode(
    inputs({
      current: "A",
      lastChangeAt: FAR_FUTURE - 300_000,
      lastUpgradeTriggerAt: FAR_FUTURE - 100_000, // 100s ago, still under 180s
    }),
    DEFAULT_THRESHOLDS,
    FAR_FUTURE,
  );
  assertEquals(next, "A");
});

Deno.test("decideMode — B → C downgrade after quiet 90s+", () => {
  const next = decideMode(
    inputs({
      current: "B",
      lastChangeAt: FAR_FUTURE - 200_000,
      lastUpgradeTriggerAt: FAR_FUTURE - 100_000, // 100s ago > 90s
    }),
    DEFAULT_THRESHOLDS,
    FAR_FUTURE,
  );
  assertEquals(next, "C");
});

Deno.test("decideMode — calendar floor RAISES reactive decision but never demotes", () => {
  // Reactive would settle at C (no upgrade signal, quiet enough). But during
  // the 09:00-10:00 ET A window the calendar forces A.
  const next = decideMode(
    {
      current: "C",
      tick: tick(),
      lastChangeAt: 0,
      lastUpgradeTriggerAt: 0,
      nbbo30sMoveBps: 0,
      calendar: "us-equities",
    },
    DEFAULT_THRESHOLDS,
    etTimestamp("2026-06-04T13:45:00Z"), // Thursday 09:45 ET → A floor
  );
  assertEquals(next, "A");
});

Deno.test("decideMode — calendar does NOT demote: reactive A wins over calendar B", () => {
  // 11:00 ET (B floor) but reactive RV is high → A stays.
  const next = decideMode(
    {
      current: "A",
      tick: tick(200), // high RV keeps A
      lastChangeAt: etTimestamp("2026-06-04T15:00:00Z") - 60_000,
      lastUpgradeTriggerAt: etTimestamp("2026-06-04T15:00:00Z") - 5_000,
      nbbo30sMoveBps: 25,
      calendar: "us-equities",
    },
    DEFAULT_THRESHOLDS,
    etTimestamp("2026-06-04T15:00:00Z"), // 11:00 ET (B-floor)
  );
  assertEquals(next, "A");
});

Deno.test("decideMode — calendar=off ignores the schedule entirely", () => {
  // Memorial Day, would be C under us-equities; calendar=off keeps reactive C.
  const next = decideMode(
    inputs({
      current: "B",
      lastChangeAt: FAR_FUTURE - 200_000,
      lastUpgradeTriggerAt: FAR_FUTURE - 100_000,
      calendar: "off",
    }),
    DEFAULT_THRESHOLDS,
    FAR_FUTURE,
  );
  assertEquals(next, "C");
});

Deno.test("decideMode — no transition when nothing changes (idle)", () => {
  const next = decideMode(
    inputs({
      current: "B",
      lastChangeAt: FAR_FUTURE - 60_000,
      lastUpgradeTriggerAt: FAR_FUTURE - 10_000, // quiet started recently
    }),
    DEFAULT_THRESHOLDS,
    FAR_FUTURE,
  );
  assertEquals(next, "B");
});
