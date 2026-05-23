// ============================================================================
// Freshness / routing-decision pure helper
// ============================================================================
// Used by `GET /freshness` (api/src/server.ts) and by the Metis-side adapter
// recipe in docs/INTEGRATIONS.md §3.2. Pure function so it can be unit-tested
// without spinning the validator.

export type RecommendedPath = "curve" | "rfq" | "none";

export interface FreshnessInput {
  /** PoolState.last_oracle_update_slot */
  lastOracleUpdateSlot: number;
  /** PoolState.current_mode_ttl. 0 = forced stale (Mode C). */
  currentModeTtl: number;
  /** PoolState.paused (decoded as boolean). */
  paused: boolean;
  /** Cluster's current slot at the time of the read. */
  currentSlot: number;
}

export interface Freshness {
  fresh: boolean;
  ttl: number;
  ttlRemainingSlots: number;
  ageSlots: number;
  lastOracleUpdateSlot: number;
  currentSlot: number;
  paused: boolean;
  /** Router action suggestion:
   *    "none"   = pool paused, do not route here
   *    "curve"  = curve fresh, prefer Metis curve-path
   *    "rfq"    = curve stale, prefer JupiterZ webhook
   *  Mirrors the on-chain `curve_fresh` check in execute_swap.rs. */
  recommendedPath: RecommendedPath;
}

export function computeFreshness(input: FreshnessInput): Freshness {
  // Defensive max(0) — slot can briefly underflow if the keeper pushed in a
  // forked slot that this RPC hasn't seen yet.
  const ageSlots = Math.max(0, input.currentSlot - input.lastOracleUpdateSlot);
  const fresh = input.currentModeTtl > 0 && ageSlots <= input.currentModeTtl;
  const ttlRemaining = fresh
    ? Math.max(0, input.currentModeTtl - ageSlots)
    : 0;
  const recommendedPath: RecommendedPath = input.paused
    ? "none"
    : fresh
      ? "curve"
      : "rfq";
  return {
    fresh,
    ttl: input.currentModeTtl,
    ttlRemainingSlots: ttlRemaining,
    ageSlots,
    lastOracleUpdateSlot: input.lastOracleUpdateSlot,
    currentSlot: input.currentSlot,
    paused: input.paused,
    recommendedPath,
  };
}
