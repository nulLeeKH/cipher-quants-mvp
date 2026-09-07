import { assertEquals, assertThrows } from "@std/assert";

import { computeQuotePricing } from "../../src/quote_pricing.ts";

const FAIR = 100_000_000n; // $100 in PRICE_SCALE units (equal-decimal pair)

Deno.test("quote pricing — Buy: price above fair (half spread up)", () => {
  const r = computeQuotePricing({
    fairValue: FAIR,
    spreadBps: 20, // half = 10 bps
    inAmount: 1_000_000n,
    direction: "buy",
  });
  // price = 100_000_000 * (10_000 + 10) / 10_000 = 100_100_000
  assertEquals(r.price, 100_100_000n);
  // outAmount = 1_000_000 * 1e6 / 100_100_000 = 9990 (floor)
  assertEquals(r.outAmount, 9_990n);
});

Deno.test("quote pricing — Sell: price below fair (half spread down)", () => {
  const r = computeQuotePricing({
    fairValue: FAIR,
    spreadBps: 20,
    inAmount: 10_000n, // 10_000 base units
    direction: "sell",
  });
  // price = 100_000_000 * 9990 / 10_000 = 99_900_000
  assertEquals(r.price, 99_900_000n);
  // outAmount = 10_000 * 99_900_000 / 1e6 = 999_000
  assertEquals(r.outAmount, 999_000n);
});

Deno.test("quote pricing — zero spread → price == fair", () => {
  const r = computeQuotePricing({
    fairValue: FAIR,
    spreadBps: 0,
    inAmount: 1_000_000n,
    direction: "buy",
  });
  assertEquals(r.price, FAIR);
});

Deno.test("quote pricing — odd spread truncates half toward zero (matches on-chain)", () => {
  // spread_bps = 21 → half = 10 (Math.floor(21/2)) — bit-for-bit with curve.rs
  const r = computeQuotePricing({
    fairValue: FAIR,
    spreadBps: 21,
    inAmount: 1n,
    direction: "buy",
  });
  // price = fair * 10_010 / 10_000 (NOT 10_010.5)
  assertEquals(r.price, 100_100_000n);
});

Deno.test("quote pricing — large bigint inputs don't lose precision", () => {
  const big = 9_000_000_000_000_000_000n;
  const r = computeQuotePricing({
    fairValue: big,
    spreadBps: 50,
    inAmount: 1n,
    direction: "buy",
  });
  // half = 25 → price = big * 10_025 / 10_000
  assertEquals(r.price, (big * 10_025n) / 10_000n);
});

Deno.test("quote pricing — custom PRICE_SCALE is honored", () => {
  const r = computeQuotePricing({
    fairValue: 1_000_000_000_000n, // PRICE_SCALE = 1e9, value = $1000
    spreadBps: 0,
    inAmount: 1_000_000_000n,
    direction: "buy",
    priceScale: 1_000_000_000n,
  });
  // outAmount = 1e9 * 1e9 / 1e12 = 1e6
  assertEquals(r.outAmount, 1_000_000n);
});

Deno.test("quote pricing — rejects fair_value <= 0", () => {
  assertThrows(
    () =>
      computeQuotePricing({
        fairValue: 0n,
        spreadBps: 10,
        inAmount: 1n,
        direction: "buy",
      }),
    Error,
    "fair_value must be > 0",
  );
});

Deno.test("quote pricing — rejects inAmount <= 0", () => {
  assertThrows(
    () =>
      computeQuotePricing({
        fairValue: FAIR,
        spreadBps: 10,
        inAmount: 0n,
        direction: "buy",
      }),
    Error,
    "inAmount must be > 0",
  );
});

Deno.test("quote pricing — rejects negative spreadBps", () => {
  assertThrows(
    () =>
      computeQuotePricing({
        fairValue: FAIR,
        spreadBps: -5,
        inAmount: 1n,
        direction: "buy",
      }),
    Error,
    "spreadBps must be ≥ 0",
  );
});

Deno.test("quote pricing — Sell at >=20000 bps would underflow price → throws", () => {
  // half = 10_000; (10_000 - 10_000) = 0 → price = 0 → throws.
  assertThrows(
    () =>
      computeQuotePricing({
        fairValue: FAIR,
        spreadBps: 20_000,
        inAmount: 1n,
        direction: "sell",
      }),
    Error,
    "price went non-positive",
  );
});
