// ============================================================================
// Mode decision logic
// ============================================================================
// docs/OPERATIONS.md §2 — Mode transition triggers.
//
// PoC v0 is *simplified*:
//   - Reactive trigger only (time schedules + market calendar come later).
//   - Upgrade is RV-Z-score driven.
//   - Downgrade is quiet-duration driven (with hysteresis).
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

/**
 * Decide the next mode. Returns `current` when nothing changes.
 */
export function decideMode(
  inputs: ModeDecisionInputs,
  t: ModeDecisionThresholds = DEFAULT_THRESHOLDS,
  now: number = Date.now()
): Mode {
  const { current, tick, lastChangeAt, lastUpgradeTriggerAt, nbbo30sMoveBps } = inputs;

  // Cool-down: don't switch modes too often.
  if (now - lastChangeAt < t.modeMinDwellMs) return current;

  const rvBps = Number(tick.realizedVolBps);

  const upgradeSignal =
    rvBps > t.upgradeAFromBRvBpsThreshold ||
    Math.abs(nbbo30sMoveBps) > t.upgradeAFromBNbboBpsThreshold;

  // Upgrade path
  if (current === "C" && upgradeSignal) return "B";
  if (current === "B" && upgradeSignal) return "A";

  // Downgrade path — when the quiet duration threshold is met.
  const quietSince = now - lastUpgradeTriggerAt;
  if (current === "A" && quietSince > t.downgradeAToBQuietDurationMs) return "B";
  if (current === "B" && quietSince > t.downgradeBToCQuietDurationMs) return "C";

  return current;
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
