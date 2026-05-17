// Deno unit tests for the Pyth Hermes adapter.
// Run via `deno task test` (no network required — covers pure helpers +
// in-memory class behaviour).

import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import {
  applyStaleness,
  computeRollingRvBps,
  parseSseChunk,
  PythPriceSource,
  pythRawToFairValue,
  type HermesEntry,
} from "./pyth.ts";
import type { PriceTick } from "./types.ts";

// ────────────────────────────────────────────────────────────────────────────
// pythRawToFairValue — unit conversion
// ────────────────────────────────────────────────────────────────────────────

Deno.test("pythRawToFairValue — BTC/USDC at $109k (8/6 decimals, expo=-8)", () => {
  // 1 BTC (10^8 satoshis) = 109_000 USDC (10^6 micro-USDC × 109_000)
  // raw_quote_per_raw_base = 109_000 * 10^6 / 10^8 = 1090 (micro-USDC / satoshi)
  // fair_value = 1090 * PRICE_SCALE(1e6) = 1_090_000_000
  const fv = pythRawToFairValue(10_900_000_000_000n, -8, 8, 6);
  assertEquals(fv, 1_090_000_000n);
});

Deno.test("pythRawToFairValue — AAPL/USDC at $190 (6/6 decimals, expo=-8)", () => {
  // human price = 190.00, equal decimals → raw_q_per_raw_b = 190
  // fair_value = 190 * 1e6 = 190_000_000
  const fv = pythRawToFairValue(19_000_000_000n, -8, 6, 6);
  assertEquals(fv, 190_000_000n);
});

Deno.test("pythRawToFairValue — handles negative net exponent (truncates with floor)", () => {
  // Force totalShift < 0 with deliberately small expo and large base decimals.
  const fv = pythRawToFairValue(12_345_678n, -10, 12, 6);
  // totalShift = -10 + 6 - 12 + 6 = -10 → fv = floor(12_345_678 / 1e10) = 0
  assertEquals(fv, 0n);
});

Deno.test("pythRawToFairValue — preserves bigint precision past 2^53", () => {
  // raw close to u64 max would overflow Number arithmetic; bigint must survive.
  const raw = 9_223_372_036_854_775_000n;
  const fv = pythRawToFairValue(raw, 0, 0, 0); // totalShift = 6 → multiply by 1e6
  assertEquals(fv, raw * 1_000_000n);
});

Deno.test("pythRawToFairValue — rejects non-positive raw", () => {
  assertThrows(() => pythRawToFairValue(0n, -8, 6, 6), Error, "raw must be > 0");
  assertThrows(() => pythRawToFairValue(-5n, -8, 6, 6), Error, "raw must be > 0");
});

// ────────────────────────────────────────────────────────────────────────────
// applyStaleness — wall-clock freshness re-evaluation
// ────────────────────────────────────────────────────────────────────────────

const baseTick: PriceTick = {
  fairValue: 1_000_000_000n,
  confidenceBps: 5n,
  realizedVolBps: 0n,
  timestamp: 0,
  status: "fresh",
};

Deno.test("applyStaleness — fresh tick under threshold stays fresh", () => {
  const t = { ...baseTick, timestamp: 1_000_000 };
  const out = applyStaleness(t, 60_000, 1_030_000); // 30 s old, 60 s limit
  assertEquals(out.status, "fresh");
});

Deno.test("applyStaleness — fresh tick over threshold becomes stale", () => {
  const t = { ...baseTick, timestamp: 1_000_000 };
  const out = applyStaleness(t, 60_000, 1_120_000); // 120 s old
  assertEquals(out.status, "stale");
});

Deno.test("applyStaleness — halted tick is preserved (never downgraded)", () => {
  const t: PriceTick = { ...baseTick, status: "halted", timestamp: 1_000_000 };
  const out = applyStaleness(t, 60_000, 9_999_999_999);
  assertEquals(out.status, "halted");
});

Deno.test("applyStaleness — unknown tick is preserved", () => {
  const t: PriceTick = { ...baseTick, status: "unknown", timestamp: 0 };
  const out = applyStaleness(t, 60_000, 9_999_999_999);
  assertEquals(out.status, "unknown");
});

Deno.test("applyStaleness — already-stale tick is rechecked, can flip back to fresh", () => {
  // Source could re-receive a fresh value after a stale window; status must
  // re-evaluate, not latch.
  const t: PriceTick = { ...baseTick, status: "stale", timestamp: 1_000_000 };
  const out = applyStaleness(t, 60_000, 1_010_000); // 10 s old → fresh again
  assertEquals(out.status, "fresh");
});

// ────────────────────────────────────────────────────────────────────────────
// parseSseChunk — Server-Sent Events framing
// ────────────────────────────────────────────────────────────────────────────

function makeEntry(price: string, expo = -8, conf = "1"): HermesEntry {
  const field = { price, conf, expo, publish_time: 1_700_000_000 };
  return { id: "feed", price: field, ema_price: field };
}

Deno.test("parseSseChunk — single complete event", () => {
  const e = makeEntry("19000000000");
  const buf = `data: ${JSON.stringify({ parsed: [e] })}\n\n`;
  const { entries, remaining } = parseSseChunk(buf);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].price.price, "19000000000");
  assertEquals(remaining, "");
});

Deno.test("parseSseChunk — two events back-to-back", () => {
  const a = makeEntry("100");
  const b = makeEntry("200");
  const buf =
    `data: ${JSON.stringify({ parsed: [a] })}\n\n` +
    `data: ${JSON.stringify({ parsed: [b] })}\n\n`;
  const { entries, remaining } = parseSseChunk(buf);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].price.price, "100");
  assertEquals(entries[1].price.price, "200");
  assertEquals(remaining, "");
});

Deno.test("parseSseChunk — partial trailing event is returned in `remaining`", () => {
  const a = makeEntry("100");
  const buf =
    `data: ${JSON.stringify({ parsed: [a] })}\n\n` +
    `data: {"par`; // truncated next event
  const { entries, remaining } = parseSseChunk(buf);
  assertEquals(entries.length, 1);
  assertEquals(remaining, `data: {"par`);
});

Deno.test("parseSseChunk — empty / keep-alive data is skipped", () => {
  const buf = `data: {}\n\ndata: \n\n`;
  const { entries, remaining } = parseSseChunk(buf);
  assertEquals(entries.length, 0);
  assertEquals(remaining, "");
});

Deno.test("parseSseChunk — malformed JSON is dropped, stream survives", () => {
  const good = makeEntry("100");
  const buf =
    `data: {not_json}\n\n` +
    `data: ${JSON.stringify({ parsed: [good] })}\n\n`;
  const { entries } = parseSseChunk(buf);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].price.price, "100");
});

// ────────────────────────────────────────────────────────────────────────────
// PythPriceSource — class behaviour around entryToTick + quote kind
// ────────────────────────────────────────────────────────────────────────────

function makeSource(opts?: Partial<ConstructorParameters<typeof PythPriceSource>[0]>) {
  return new PythPriceSource({
    feedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    baseDecimals: 8,
    quoteDecimals: 6,
    ...opts,
  });
}

Deno.test("PythPriceSource — rejects malformed feedId at construction", () => {
  assertThrows(
    () => makeSource({ feedId: "not-hex" }),
    Error,
    "feedId must be a 64-char hex string",
  );
});

Deno.test("PythPriceSource — rejects negative decimals", () => {
  assertThrows(
    () => makeSource({ baseDecimals: -1 }),
    Error,
    "decimals must be non-negative",
  );
});

Deno.test("PythPriceSource — entryToTick spot vs EMA selects different prices", () => {
  const entry: HermesEntry = {
    id: "feed",
    price: { price: "10000000000", conf: "1000000", expo: -8, publish_time: 1_700_000_000 },
    ema_price: { price: "10005000000", conf: "1000000", expo: -8, publish_time: 1_700_000_000 },
  };
  const spotSrc = makeSource({ quoteKind: "spot" });
  const emaSrc = makeSource({ quoteKind: "ema" });
  const spotTick = spotSrc.entryToTick(entry);
  const emaTick = emaSrc.entryToTick(entry);
  assertEquals(spotTick.status, "fresh");
  assertEquals(emaTick.status, "fresh");
  // EMA price is 0.05 % higher in the fixture; fair_value reflects it.
  assertEquals(emaTick.fairValue > spotTick.fairValue, true);
});

Deno.test("PythPriceSource — halted: price=0 produces halted tick", () => {
  const entry: HermesEntry = {
    id: "feed",
    price: { price: "0", conf: "1000", expo: -8, publish_time: 1_700_000_000 },
    ema_price: { price: "0", conf: "1000", expo: -8, publish_time: 1_700_000_000 },
  };
  const tick = makeSource().entryToTick(entry);
  assertEquals(tick.status, "halted");
  assertEquals(tick.fairValue, 0n);
  assertEquals(tick.timestamp, 1_700_000_000_000);
});

Deno.test("PythPriceSource — halted: conf=0 produces halted tick", () => {
  const entry: HermesEntry = {
    id: "feed",
    price: { price: "100000000", conf: "0", expo: -8, publish_time: 1_700_000_000 },
    ema_price: { price: "100000000", conf: "0", expo: -8, publish_time: 1_700_000_000 },
  };
  const tick = makeSource().entryToTick(entry);
  assertEquals(tick.status, "halted");
});

Deno.test("PythPriceSource — label encodes transport + quote kind", () => {
  assertEquals(makeSource({ transport: "sse", quoteKind: "spot" }).label, "pyth:sse:spot");
  assertEquals(makeSource({ transport: "poll", quoteKind: "ema" }).label, "pyth:poll:ema");
});

// ────────────────────────────────────────────────────────────────────────────
// computeRollingRvBps
// ────────────────────────────────────────────────────────────────────────────

Deno.test("computeRollingRvBps — empty / single-point window returns 0", () => {
  assertEquals(computeRollingRvBps([]), 0);
  assertEquals(computeRollingRvBps([100]), 0);
});

Deno.test("computeRollingRvBps — flat series → 0 bps", () => {
  assertEquals(computeRollingRvBps([100, 100, 100, 100]), 0);
});

Deno.test("computeRollingRvBps — 1 % moves average to ~100 bps", () => {
  const rv = computeRollingRvBps([100, 101, 100, 101]);
  // Three returns of ~1 % each = ~100 bps each → average ~100 bps.
  // Allow a small floating tolerance.
  assertEquals(Math.round(rv), 100);
});

Deno.test("computeRollingRvBps — skips zero-prior to avoid div-by-zero", () => {
  // First sample is 0; subsequent returns are well-defined.
  const rv = computeRollingRvBps([0, 100, 101]);
  // Only one valid return: (101-100)/100 = 100 bps. Average = 100.
  assertEquals(Math.round(rv), 100);
});
