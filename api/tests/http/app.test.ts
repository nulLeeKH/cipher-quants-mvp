import { assertEquals } from "@std/assert";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import type { ApiConfig } from "../../src/config.ts";
import { newMetrics } from "../../src/metrics.ts";
import { createQuoteStore } from "../../src/quote_store.ts";
import { createSlidingWindowRateLimiter } from "../../src/rate_limit.ts";
import type { ApiRuntime, ResolvedApiConfig } from "../../src/runtime.ts";
import { createApiApp } from "../../src/http/app.ts";

function runtime(overrides: Partial<ApiConfig> = {}): ApiRuntime {
  const baseMint = new PublicKey("So11111111111111111111111111111111111111112");
  const quoteMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  const config: ResolvedApiConfig = {
    rpcUrl: "http://127.0.0.1:8899",
    rpcProvider: "test",
    quoteSignerWalletPath: "/tmp/quote.json",
    baseMint,
    quoteMint,
    baseSymbol: "BASE",
    baseDecimals: 6,
    quoteSymbol: "QUOTE",
    quoteDecimals: 6,
    port: 8080,
    quoteValidWindowSlots: 200,
    mmMaxDriftBps: 50,
    verbose: false,
    ...overrides,
  };
  return {
    config,
    connection: new Connection(config.rpcUrl),
    program: {},
    quoteSigner: Keypair.generate(),
    metrics: newMetrics(),
    quoteStore: createQuoteStore({ sweepIntervalMs: 0 }),
    rateLimiter: createSlidingWindowRateLimiter({
      windowMs: 1_000,
      cleanupIntervalMs: 0,
    }),
    sdk: {},
    sdkAccounts: {},
    sdkInstructions: {},
  };
}

Deno.test("createApiApp — /health returns ok", async () => {
  const rt = runtime();
  const app = createApiApp(rt);
  const res = await app.request("/health");
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");
  rt.quoteStore.stop();
  rt.rateLimiter.stop();
});

Deno.test("createApiApp — /tokens returns configured token metadata", async () => {
  const rt = runtime({ baseSymbol: "xTSLA", quoteSymbol: "USDC" });
  const app = createApiApp(rt);
  const res = await app.request("/tokens");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.tokens[0].symbol, "xTSLA");
  assertEquals(body.tokens[1].symbol, "USDC");
  rt.quoteStore.stop();
  rt.rateLimiter.stop();
});

Deno.test("createApiApp — /metrics is fail-closed when token unset", async () => {
  const rt = runtime();
  const app = createApiApp(rt);
  const res = await app.request("/metrics");
  assertEquals(res.status, 503);
  assertEquals(
    await res.text(),
    "/metrics is disabled (set METRICS_AUTH_TOKEN to enable)\n",
  );
  rt.quoteStore.stop();
  rt.rateLimiter.stop();
});

Deno.test("createApiApp — /metrics requires bearer token when enabled", async () => {
  const rt = runtime({ metricsAuthToken: "secret" });
  const app = createApiApp(rt);
  const denied = await app.request("/metrics", {
    headers: { authorization: "Bearer wrong" },
  });
  assertEquals(denied.status, 401);
  const allowed = await app.request("/metrics", {
    headers: { authorization: "Bearer secret" },
  });
  assertEquals(allowed.status, 200);
  rt.quoteStore.stop();
  rt.rateLimiter.stop();
});
