// ============================================================================
// Lightweight in-memory metrics
// ============================================================================
// Reflects only what /metrics exposes today: counters + a latency ring
// buffer with p50/p95/p99. At Stage 2 we'd swap this for a Prometheus client.
//
// Pure functions on a plain state object so the test suite can poke at it
// directly without spinning the HTTP server.

const LATENCY_RING_SIZE = 1024;

export interface Metrics {
  quoteRequests: number;
  quoteSuccess: number;
  quoteInventoryFail: number;
  quoteOtherFail: number;
  swapRequests: number;
  latenciesMs: number[];
  latencyIdx: number;
}

export function newMetrics(): Metrics {
  return {
    quoteRequests: 0,
    quoteSuccess: 0,
    quoteInventoryFail: 0,
    quoteOtherFail: 0,
    swapRequests: 0,
    latenciesMs: [],
    latencyIdx: 0,
  };
}

export function recordLatency(m: Metrics, ms: number): void {
  if (m.latenciesMs.length < LATENCY_RING_SIZE) {
    m.latenciesMs.push(ms);
  } else {
    m.latenciesMs[m.latencyIdx] = ms;
    m.latencyIdx = (m.latencyIdx + 1) % LATENCY_RING_SIZE;
  }
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function renderMetrics(m: Metrics): string {
  const sorted = [...m.latenciesMs].sort((a, b) => a - b);
  const lines = [
    `# HELP cipher_quote_requests_total Total /quote requests`,
    `# TYPE cipher_quote_requests_total counter`,
    `cipher_quote_requests_total ${m.quoteRequests}`,
    `cipher_quote_success_total ${m.quoteSuccess}`,
    `cipher_quote_inventory_fail_total ${m.quoteInventoryFail}`,
    `cipher_quote_other_fail_total ${m.quoteOtherFail}`,
    `cipher_swap_requests_total ${m.swapRequests}`,
    `# HELP cipher_quote_latency_ms /quote latency percentiles`,
    `# TYPE cipher_quote_latency_ms summary`,
    `cipher_quote_latency_ms{quantile="0.5"} ${percentile(sorted, 50)}`,
    `cipher_quote_latency_ms{quantile="0.95"} ${percentile(sorted, 95)}`,
    `cipher_quote_latency_ms{quantile="0.99"} ${percentile(sorted, 99)}`,
    `cipher_quote_latency_samples ${sorted.length}`,
    ``,
  ];
  return lines.join("\n");
}
