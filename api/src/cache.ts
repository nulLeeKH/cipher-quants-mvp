// ============================================================================
// Bounded TTL cache (LRU + time-based expiry)
// ============================================================================
// Used by the API server for the quote cache. Generic so the same impl can
// hold rate-limit decisions or anything else with a per-entry expiry.
//
// Eviction:
//   - On set: drop expired entries lazily; cap at `maxEntries` (Map iteration
//     order = insertion → LRU semantics).
//   - On get: drop a single expired entry inline.
//   - Optional background sweep: pass `sweepIntervalMs` to start a timer.

export interface BoundedTtlCacheOpts {
  maxEntries: number;
  ttlMs: number;
  /** Optional background sweep cadence. 0 disables. */
  sweepIntervalMs?: number;
  /** Clock override (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export interface BoundedTtlCache<T> {
  set(key: string, value: T): void;
  get(key: string): T | undefined;
  delete(key: string): void;
  size(): number;
  stop(): void;
}

export function createBoundedTtlCache<T>(
  opts: BoundedTtlCacheOpts,
): BoundedTtlCache<T> {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { value: T; expiresAtMs: number }>();
  let sweepTimer: number | undefined;

  function set(key: string, value: T): void {
    const expiresAtMs = now() + opts.ttlMs;
    entries.delete(key); // re-insert at tail
    entries.set(key, { value, expiresAtMs });
    while (entries.size > opts.maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  function get(key: string): T | undefined {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs < now()) {
      entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function sweepExpired(): void {
    const cutoff = now();
    for (const [k, v] of entries) {
      if (v.expiresAtMs < cutoff) entries.delete(k);
    }
  }

  if (opts.sweepIntervalMs && opts.sweepIntervalMs > 0) {
    sweepTimer = setInterval(sweepExpired, opts.sweepIntervalMs);
  }

  return {
    set,
    get,
    delete: (k) => entries.delete(k),
    size: () => entries.size,
    stop: () => {
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
    },
  };
}
