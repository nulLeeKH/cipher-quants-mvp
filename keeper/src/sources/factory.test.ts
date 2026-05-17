import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import {
  createPriceSource,
  parsePriceSourceKind,
  parsePythQuoteKind,
  parsePythTransport,
} from "./factory.ts";

// ────────────────────────────────────────────────────────────────────────────
// Env parsers
// ────────────────────────────────────────────────────────────────────────────

Deno.test("parsePriceSourceKind — defaults to mock when unset", () => {
  assertEquals(parsePriceSourceKind(undefined), "mock");
  assertEquals(parsePriceSourceKind(""), "mock");
});

Deno.test("parsePriceSourceKind — case-insensitive accept", () => {
  assertEquals(parsePriceSourceKind("MOCK"), "mock");
  assertEquals(parsePriceSourceKind("Pyth"), "pyth");
  assertEquals(parsePriceSourceKind("  pyth  "), "pyth");
});

Deno.test("parsePriceSourceKind — rejects unknown values", () => {
  assertThrows(() => parsePriceSourceKind("finnhub"), Error, "PRICE_SOURCE must be one of");
});

Deno.test("parsePythQuoteKind / parsePythTransport — sensible defaults + reject unknowns", () => {
  assertEquals(parsePythQuoteKind(undefined), "spot");
  assertEquals(parsePythTransport(undefined), "sse");
  assertThrows(() => parsePythQuoteKind("median"), Error, "PYTH_QUOTE_KIND");
  assertThrows(() => parsePythTransport("ws"), Error, "PYTH_TRANSPORT");
});

// ────────────────────────────────────────────────────────────────────────────
// Composition
// ────────────────────────────────────────────────────────────────────────────

Deno.test("createPriceSource — mock primary alone", () => {
  const src = createPriceSource({
    kind: "mock",
    baseDecimals: 6,
    quoteDecimals: 6,
  });
  // Mock's label is "mock".
  assertEquals(src.label, "mock");
});

Deno.test("createPriceSource — basis wrapper only applies when bps != 0", () => {
  const plain = createPriceSource({
    kind: "mock",
    baseDecimals: 6,
    quoteDecimals: 6,
    basisAdjustmentBps: 0,
  });
  assertEquals(plain.label, "mock"); // basis=0 → no wrapper

  const wrapped = createPriceSource({
    kind: "mock",
    baseDecimals: 6,
    quoteDecimals: 6,
    basisAdjustmentBps: 50,
  });
  assertEquals(wrapped.label, "mock+basis(50bps)");
});

Deno.test("createPriceSource — failover composes primary + fallback", () => {
  const src = createPriceSource({
    kind: "mock",
    baseDecimals: 6,
    quoteDecimals: 6,
    fallback: { kind: "mock", baseDecimals: 6, quoteDecimals: 6 },
  });
  assertEquals(src.label, "failover(mock,mock)");
});

Deno.test("createPriceSource — failover + basis stacked in the right order", () => {
  const src = createPriceSource({
    kind: "mock",
    baseDecimals: 6,
    quoteDecimals: 6,
    fallback: { kind: "mock", baseDecimals: 6, quoteDecimals: 6 },
    basisAdjustmentBps: -20,
  });
  // Failover is wrapped first, then basis on top — label reads outside-in.
  assertEquals(src.label, "failover(mock,mock)+basis(-20bps)");
});

Deno.test("createPriceSource — pyth requires PYTH_FEED_ID", () => {
  assertThrows(
    () =>
      createPriceSource({
        kind: "pyth",
        baseDecimals: 6,
        quoteDecimals: 6,
      }),
    Error,
    "PYTH_FEED_ID",
  );
});

Deno.test("createPriceSource — pyth label encodes transport + quote kind", () => {
  const src = createPriceSource({
    kind: "pyth",
    baseDecimals: 8,
    quoteDecimals: 6,
    pythFeedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    pythTransport: "poll",
    pythQuoteKind: "ema",
  });
  assertEquals(src.label, "pyth:poll:ema");
});
