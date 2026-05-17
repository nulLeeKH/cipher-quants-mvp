// ============================================================================
// Quote-nonce generator
// ============================================================================
// 8-byte cryptographically-random u64. On-chain replay defense relies on the
// PDA `[quote_used, pool, nonce_le]` being unique per quote — `Date.now() +
// Math.random()` would collide within a single millisecond AND be
// attacker-predictable, so we use `crypto.getRandomValues`.
//
// Hoisted out of server.ts so tests can spot-check distribution + byte order.

export function nextQuoteNonce(rng: Crypto = crypto): bigint {
  const buf = new Uint8Array(8);
  rng.getRandomValues(buf);
  return new DataView(buf.buffer).getBigUint64(0, true /* LE: matches on-chain */);
}
