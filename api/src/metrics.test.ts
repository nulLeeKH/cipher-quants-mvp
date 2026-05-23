import { assertEquals } from "jsr:@std/assert@1";

import { newMetrics, percentile, recordLatency, renderMetrics } from "./metrics.ts";

Deno.test("percentile — empty → 0", () => {
  assertEquals(percentile([], 50), 0);
});

Deno.test("percentile — single element returns it", () => {
  assertEquals(percentile([42], 50), 42);
  assertEquals(percentile([42], 99), 42);
});

Deno.test("percentile — 1..100, p50≈50, p95≈95, p99≈99", () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  // floor((p/100) * length) → p50 idx=50 (value 51); p95 idx=95 (value 96)
  // We only assert these are within ±1 of the named percentile.
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  if (Math.abs(p50 - 50) > 1) throw new Error(`p50=${p50}`);
  if (Math.abs(p95 - 95) > 1) throw new Error(`p95=${p95}`);
  if (Math.abs(p99 - 99) > 1) throw new Error(`p99=${p99}`);
});

Deno.test("recordLatency — ring buffer wraps after 1024 samples", () => {
  const m = newMetrics();
  for (let i = 0; i < 1500; i++) recordLatency(m, i);
  assertEquals(m.latenciesMs.length, 1024);
  // After 1500 inserts into a 1024 buffer, the head is at index
  // (1500 - 1024) = 476. The most recent value (1499) sits at idx (476-1+1024)%1024 = 475.
  // Just sanity-check we kept the most recent values somewhere.
  const includesRecent = m.latenciesMs.some((v) => v >= 1400);
  assertEquals(includesRecent, true);
});

Deno.test("renderMetrics — includes counter names + Prometheus headers", () => {
  const m = newMetrics();
  m.quoteRequests = 7;
  m.quoteSuccess = 5;
  m.quoteInventoryFail = 1;
  m.quoteOtherFail = 1;
  m.swapRequests = 4;
  m.swapSuccess = 2;
  m.swapDriftReject = 1;
  m.swapInventoryReject = 0;
  m.swapCurveFreshReject = 0;
  m.swapExpiredReject = 1;
  m.swapPausedReject = 0;
  m.swapClientFail = 0;
  recordLatency(m, 10);
  recordLatency(m, 20);
  recordLatency(m, 30);
  const out = renderMetrics(m);
  if (!out.includes("cipher_quote_requests_total 7")) throw new Error(out);
  if (!out.includes("cipher_quote_success_total 5")) throw new Error(out);
  if (!out.includes("cipher_quote_inventory_fail_total 1")) throw new Error(out);
  if (!out.includes("cipher_quote_other_fail_total 1")) throw new Error(out);
  if (!out.includes("cipher_swap_requests_total 4")) throw new Error(out);
  if (!out.includes("cipher_swap_success_total 2")) throw new Error(out);
  if (!out.includes("cipher_swap_drift_reject_total 1")) throw new Error(out);
  if (!out.includes("cipher_swap_expired_reject_total 1")) throw new Error(out);
  if (!out.includes(`cipher_quote_latency_ms{quantile="0.95"}`)) throw new Error(out);
  if (!out.includes("# HELP")) throw new Error(out);
  if (!out.includes("# TYPE")) throw new Error(out);
  if (!out.includes("cipher_quote_latency_samples 3")) throw new Error(out);
});
