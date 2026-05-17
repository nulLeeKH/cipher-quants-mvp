// ============================================================================
// Stale-tick policy
// ============================================================================
// When the price source goes non-fresh (Pyth equity feed after-hours, Hermes
// outage, mock paused for testing), the worker should not advertise a stale
// curve on-chain. Two-stage response:
//
//   1. Per-cycle: refuse to push the update_oracle ix when the tick isn't
//      `"fresh"`. Existing on-chain TTL runs out naturally.
//
//   2. After `holdoffMs` of *consecutive* non-fresh observations: force the
//      worker into Mode C so the RFQ path takes over (no further push
//      attempts, freshness check at swap time short-circuits to RFQ).
//
// This helper is the pure stage-2 decision. The worker calls it on every
// push outcome; we keep it stand-alone so it can be tested without
// constructing the full worker closure.

export interface StalePolicyInput {
  /** Whether the most recent pushOracle() succeeded (true = tick was fresh
   *  AND the on-chain tx landed). */
  pushed: boolean;
  /** Timestamp (ms) of the FIRST observed non-fresh push since the last
   *  successful one. `null` = currently in a healthy run. */
  firstStaleObservedAt: number | null;
  /** How long consecutive non-fresh must persist before forcing Mode C. */
  holdoffMs: number;
  /** Whether the worker is already in Mode C (so we don't keep "forcing"). */
  alreadyModeC: boolean;
}

export interface StalePolicyOutcome {
  /** Updated firstStaleObservedAt to persist into the next call. */
  firstStaleObservedAt: number | null;
  /** True when this call decided to flip the worker into Mode C. */
  forceModeC: boolean;
  /** Optional log message when forcing; null otherwise. */
  message: string | null;
}

export function evaluateStalePolicy(
  input: StalePolicyInput,
  now: number,
): StalePolicyOutcome {
  // Successful push → reset the staleness window.
  if (input.pushed) {
    return { firstStaleObservedAt: null, forceModeC: false, message: null };
  }

  // First non-fresh observation since the last success → start the clock.
  const firstStaleObservedAt = input.firstStaleObservedAt ?? now;
  const elapsed = now - firstStaleObservedAt;

  if (elapsed > input.holdoffMs && !input.alreadyModeC) {
    return {
      firstStaleObservedAt,
      forceModeC: true,
      message: `source non-fresh for ${(elapsed / 1000).toFixed(0)}s → forcing Mode C`,
    };
  }

  return { firstStaleObservedAt, forceModeC: false, message: null };
}

/** Production holdoff — 30 s of consecutive non-fresh ticks before we give
 *  up on the source and force RFQ-only mode. */
export const DEFAULT_STALE_HOLDOFF_MS = 30_000;
