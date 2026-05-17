import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import { priceToFairValue } from "./types.ts";

// Mirrors the conversion contract used by adapters that report human-decimal
// prices (Yahoo, Finnhub, manual override). On-chain math wants raw u64.

Deno.test("priceToFairValue — equal decimals (6/6), integer price", () => {
  // 1 base = $100; equal-decimals → factor = PRICE_SCALE × 1
  assertEquals(priceToFairValue("100", 6, 6), 100_000_000n);
});

Deno.test("priceToFairValue — equal decimals (6/6), fractional", () => {
  assertEquals(priceToFairValue("100.5", 6, 6), 100_500_000n);
});

Deno.test("priceToFairValue — equal decimals (6/6), many fraction digits truncate", () => {
  // PRICE_SCALE=1e6 caps usable fraction at 6 digits.
  assertEquals(priceToFairValue("100.123456789", 6, 6), 100_123_456n);
});

Deno.test("priceToFairValue — mismatched decimals (BTC 8 / USDC 6)", () => {
  // human price 109_000, base=8, quote=6
  //   = 109_000 × 10^6 / 10^8 × PRICE_SCALE
  //   = 109_000 × PRICE_SCALE / 100
  //   = 109_000_000_000 / 100 = 1_090_000_000
  assertEquals(priceToFairValue("109000", 8, 6), 1_090_000_000n);
});

Deno.test("priceToFairValue — high precision SOL/USDC ($164.523)", () => {
  // base=9 (SOL), quote=6 (USDC)
  //  raw_q_per_raw_b = 164.523 × 10^6 / 10^9 = 0.164523 → in PRICE_SCALE units = 164523
  assertEquals(priceToFairValue("164.523", 9, 6), 164_523n);
});

Deno.test("priceToFairValue — leading zeros in input are tolerated", () => {
  assertEquals(priceToFairValue("000100", 6, 6), 100_000_000n);
});

Deno.test("priceToFairValue — trailing whitespace trimmed", () => {
  assertEquals(priceToFairValue("  100.5  ", 6, 6), 100_500_000n);
});

Deno.test("priceToFairValue — '0' returns 0", () => {
  assertEquals(priceToFairValue("0", 6, 6), 0n);
});

Deno.test("priceToFairValue — '0.000001' returns 1 unit", () => {
  // 0.000001 × PRICE_SCALE = 1 (equal decimals)
  assertEquals(priceToFairValue("0.000001", 6, 6), 1n);
});

Deno.test("priceToFairValue — rejects non-numeric input", () => {
  assertThrows(
    () => priceToFairValue("abc", 6, 6),
    Error,
    "invalid price",
  );
  assertThrows(() => priceToFairValue("1.2.3", 6, 6), Error);
  assertThrows(() => priceToFairValue("-5", 6, 6), Error);
  assertThrows(() => priceToFairValue("1e5", 6, 6), Error);
});

Deno.test("priceToFairValue — empty string is rejected as non-numeric", () => {
  assertThrows(() => priceToFairValue("", 6, 6), Error);
});
