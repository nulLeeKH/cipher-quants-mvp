// ============================================================================
// Mode decision logic
// ============================================================================
// docs/OPERATIONS.md §2 — Mode transition triggers.
//
// v0:
//   - Reactive: RV-Z-score / NBBO-move-driven upgrades.
//   - Calendar: floor mode by US-equity market schedule (xStocks).
//   - Hysteresis: quiet-duration-driven downgrades.
//
// Thresholds will be tuned against Stage 1 backtest results (OPERATIONS §1.1).

import type { PriceTick } from "../sources/types.ts";
import type { Mode } from "./state.ts";

export interface ModeDecisionInputs {
  /** Current mode */
  current: Mode;
  /** Latest price tick */
  tick: PriceTick;
  /** Last mode-change timestamp (ms). For cooldown. */
  lastChangeAt: number;
  /** Last upgrade trigger timestamp (ms). For "quiet" duration tracking. */
  lastUpgradeTriggerAt: number;
  /** Recent NBBO mid: 30-second cumulative move (bps). */
  nbbo30sMoveBps: number;
  /**
   * If set, override calendar-based mode floor. Useful for tests, backtests,
   * and the long-tail-crypto target where no schedule applies.
   * "off" → never apply a calendar floor.
   * "us-equities" → apply US-equity floor (default for xStocks venues).
   */
  calendar?: "us-equities" | "off";
}

export interface ModeDecisionThresholds {
  /** §1.1 — Upgrade A: RV Z>+1.5 (rough proxy = RV > 150 bps in PoC) */
  upgradeAFromBRvBpsThreshold: number;
  upgradeAFromBNbboBpsThreshold: number;
  /** §1.1 — Quiet "60s" → downgrade. PoC default values */
  downgradeBToCQuietDurationMs: number;
  downgradeAToBQuietDurationMs: number;
  /** Cool-down: minimum dwell time in the previous mode (ms). */
  modeMinDwellMs: number;
}

export const DEFAULT_THRESHOLDS: ModeDecisionThresholds = {
  upgradeAFromBRvBpsThreshold: 150, // Rough absolute analogue of RV Z > +1.5
  upgradeAFromBNbboBpsThreshold: 15,
  downgradeBToCQuietDurationMs: 90_000, // OPERATIONS §1.1
  downgradeAToBQuietDurationMs: 180_000,
  modeMinDwellMs: 30_000,
};

// ----------------------------------------------------------------------------
// US-equity market calendar (xStocks)
// ----------------------------------------------------------------------------
// Schedule (per OPERATIONS §2.1):
//   ±30 min around open  → Mode A (high vol)
//   ±30 min around close → Mode A
//   09:30–16:00 ET (Mon–Fri), outside the active windows → Mode B
//   All other times / weekends / holidays → Mode C
//
// Holidays are NYSE-observed dates; the list below covers 2026–2027 and must
// be refreshed each year. The cost of being a day off is "we run a thin
// trading day as Mode B/A" — not a safety issue — so a stale list is graceful.
// Times are computed in America/New_York to handle DST without a tz library.

const NYSE_HOLIDAYS = new Set<string>([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Day
  "2026-02-16", // Presidents Day
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18", // Juneteenth observed
  "2027-07-05", // Independence Day observed
  "2027-09-06",
  "2027-11-25",
  "2027-12-24", // Christmas observed
]);

interface EtParts {
  year: number;
  month: number; // 1..12
  day: number;
  weekday: number; // 0=Sun..6=Sat
  hour: number;
  minute: number;
  isoDate: string; // YYYY-MM-DD
  minutesSinceMidnight: number;
}

function getEtParts(now: number): EtParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(now))) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24; // Intl returns "24" at midnight on some engines
  const minute = Number(parts.minute);
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const weekday = weekdayMap[parts.weekday] ?? 0;
  const iso = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    year, month, day, weekday, hour, minute,
    isoDate: iso,
    minutesSinceMidnight: hour * 60 + minute,
  };
}

/**
 * Calendar-imposed minimum mode for the US-equities schedule.
 * Returns the lowest mode (in the A > B > C ordering) that the calendar
 * permits at this instant; the actual mode is `max(calendarFloor, reactive)`.
 */
export function calendarFloor(now: number = Date.now()): Mode {
  const et = getEtParts(now);
  // Weekend → C
  if (et.weekday === 0 || et.weekday === 6) return "C";
  // Holiday → C
  if (NYSE_HOLIDAYS.has(et.isoDate)) return "C";

  // Window definitions (minutes since 00:00 ET)
  const OPEN_MIN  = 9 * 60 + 30;   // 09:30
  const CLOSE_MIN = 16 * 60;       // 16:00
  const A_PRE_OPEN  = OPEN_MIN - 30;  // 09:00
  const A_POST_OPEN = OPEN_MIN + 30;  // 10:00
  const A_PRE_CLOSE  = CLOSE_MIN - 30; // 15:30
  const A_POST_CLOSE = CLOSE_MIN + 30; // 16:30

  const m = et.minutesSinceMidnight;
  if ((m >= A_PRE_OPEN && m < A_POST_OPEN) ||
      (m >= A_PRE_CLOSE && m < A_POST_CLOSE)) {
    return "A";
  }
  if (m >= OPEN_MIN && m < CLOSE_MIN) return "B";
  return "C";
}

const MODE_ORDER: Record<Mode, number> = { C: 0, B: 1, A: 2 };
function maxMode(a: Mode, b: Mode): Mode {
  return MODE_ORDER[a] >= MODE_ORDER[b] ? a : b;
}

/**
 * Decide the next mode. Returns `current` when nothing changes.
 *
 * Final mode = max(calendar floor, reactive decision). Calendar can only
 * *raise* the mode (Mode A at market open) — it never forces a downgrade in
 * the middle of a volatility spike.
 */
export function decideMode(
  inputs: ModeDecisionInputs,
  t: ModeDecisionThresholds = DEFAULT_THRESHOLDS,
  now: number = Date.now()
): Mode {
  const { current, tick, lastChangeAt, lastUpgradeTriggerAt, nbbo30sMoveBps } = inputs;
  const calendar = inputs.calendar ?? "us-equities";

  // Cool-down: don't switch modes too often.
  if (now - lastChangeAt < t.modeMinDwellMs) return current;

  const rvBps = Number(tick.realizedVolBps);

  const upgradeSignal =
    rvBps > t.upgradeAFromBRvBpsThreshold ||
    Math.abs(nbbo30sMoveBps) > t.upgradeAFromBNbboBpsThreshold;

  // Reactive decision (without calendar)
  let next: Mode = current;
  if (current === "C" && upgradeSignal) next = "B";
  else if (current === "B" && upgradeSignal) next = "A";
  else {
    const quietSince = now - lastUpgradeTriggerAt;
    if (current === "A" && quietSince > t.downgradeAToBQuietDurationMs) next = "B";
    else if (current === "B" && quietSince > t.downgradeBToCQuietDurationMs) next = "C";
  }

  // Calendar floor — never demotes a reactive upgrade, only raises a quiet mode.
  if (calendar === "us-equities") {
    const floor = calendarFloor(now);
    next = maxMode(next, floor);
  }

  return next;
}

/**
 * Mode → on-chain TTL mapping (OPERATIONS §1).
 */
export function modeToTtl(mode: Mode): number {
  switch (mode) {
    case "A":
      return 1;
    case "B":
      return 3;
    case "C":
      return 0;
  }
}
