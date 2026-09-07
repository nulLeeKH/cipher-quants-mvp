// ============================================================================
// Pending quote store
// ============================================================================
// /quote creates PendingQuote entries and /swap consumes them. Keep that shared
// state out of the HTTP server bootstrap so storage can later move to Redis or
// another durable store without rewriting endpoint handlers.

import type { PublicKey } from "@solana/web3.js";

import { createBoundedTtlCache } from "./cache.ts";

export const QUOTE_CACHE_MAX_ENTRIES = 10_000;
export const QUOTE_CACHE_TTL_MS = 5 * 60_000;
export const QUOTE_CACHE_SWEEP_MS = 60_000;

/** Holds everything needed to sign at /swap time without re-deriving the quote.
 *  The MM does not commit until /swap. */
export interface PendingQuote {
  quoteId: string;
  poolAddr: PublicKey;
  userPk: PublicKey;
  direction: "buy" | "sell";
  inAmount: bigint;
  outAmount: bigint;
  price: bigint;
  fairValueAtQuote: bigint;
  expirySlot: bigint;
  nonce: bigint;
  marker: PublicKey;
}

export interface QuoteStore {
  set(pending: PendingQuote): void;
  get(quoteId: string): PendingQuote | undefined;
  delete(quoteId: string): void;
  stop(): void;
}

export function createQuoteStore(opts: {
  maxEntries?: number;
  ttlMs?: number;
  sweepIntervalMs?: number;
} = {}): QuoteStore {
  const cache = createBoundedTtlCache<PendingQuote>({
    maxEntries: opts.maxEntries ?? QUOTE_CACHE_MAX_ENTRIES,
    ttlMs: opts.ttlMs ?? QUOTE_CACHE_TTL_MS,
    sweepIntervalMs: opts.sweepIntervalMs ?? QUOTE_CACHE_SWEEP_MS,
  });
  return {
    set: (pending) => cache.set(pending.quoteId, pending),
    get: (quoteId) => cache.get(quoteId),
    delete: (quoteId) => cache.delete(quoteId),
    stop: () => cache.stop(),
  };
}
