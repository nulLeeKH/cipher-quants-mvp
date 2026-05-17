// ============================================================================
// Per-key sliding-window rate limiter
// ============================================================================
// In-memory; keys are typically client IPs. Window is constant; the limit
// is per-call so different endpoints can share one limiter with different
// thresholds.

export interface SlidingWindowRateLimiterOpts {
  windowMs: number;
  /** Optional cleanup cadence (drops empty buckets). 0 disables. */
  cleanupIntervalMs?: number;
  now?: () => number;
}

export interface SlidingWindowRateLimiter {
  isLimited(key: string, limit: number): boolean;
  /** Bucket count, for monitoring. */
  buckets(): number;
  stop(): void;
}

export function createSlidingWindowRateLimiter(
  opts: SlidingWindowRateLimiterOpts,
): SlidingWindowRateLimiter {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, number[]>();
  let cleanup: number | undefined;

  function isLimited(key: string, limit: number): boolean {
    const t = now();
    const hits = buckets.get(key) ?? [];
    // Drop stale hits.
    while (hits.length > 0 && hits[0] < t - opts.windowMs) {
      hits.shift();
    }
    if (hits.length >= limit) {
      buckets.set(key, hits);
      return true;
    }
    hits.push(t);
    buckets.set(key, hits);
    return false;
  }

  if (opts.cleanupIntervalMs && opts.cleanupIntervalMs > 0) {
    cleanup = setInterval(() => {
      const t = now();
      for (const [k, v] of buckets) {
        const fresh = v.filter((h) => h >= t - opts.windowMs);
        if (fresh.length === 0) buckets.delete(k);
        else buckets.set(k, fresh);
      }
    }, opts.cleanupIntervalMs);
  }

  return {
    isLimited,
    buckets: () => buckets.size,
    stop: () => {
      if (cleanup !== undefined) clearInterval(cleanup);
    },
  };
}
