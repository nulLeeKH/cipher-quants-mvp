import { assertEquals, assertExists } from "jsr:@std/assert@1";

import { loadConfig } from "./config.ts";

// loadConfig calls Deno.exit on missing required vars, so each test must
// supply a complete env snapshot. We snapshot+restore the env between tests
// to keep them isolated.

const ENV_KEYS = [
  "RPC_URL",
  "RPC_PROVIDER",
  "RPC_WS_URL",
  "ORACLE_WALLET_PATH",
  "ADMIN_WALLET_PATH",
  "FEE_PAYER_WALLET_PATH",
  "PROGRAM_ID",
  "BASE_MINT",
  "QUOTE_MINT",
  "PRICE_SOURCE",
  "PYTH_FEED_ID",
  "PYTH_HERMES_URL",
  "PYTH_TRANSPORT",
  "PYTH_QUOTE_KIND",
  "PYTH_MAX_STALENESS_SEC",
  "PRICE_SOURCE_POLL_MS",
  "BASIS_ADJUSTMENT_BPS",
  "ORACLE_MODE_A_PUSH_INTERVAL_MS",
  "ORACLE_MODE_B_EVAL_INTERVAL_MS",
  "ORACLE_MODE_C_POLL_INTERVAL_MS",
  "ORACLE_MODE_A_PRIORITY_FEE_MICROLAMPORTS",
  "ORACLE_MODE_B_PRIORITY_FEE_MICROLAMPORTS",
  "WEBHOOK_PORT",
  "QUOTE_VALID_WINDOW_SLOTS",
  "VERBOSE",
];

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prev[k] = Deno.env.get(k);
  // Wipe → set
  for (const k of ENV_KEYS) Deno.env.delete(k);
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) Deno.env.set(k, v);
  }
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      const v = prev[k];
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("loadConfig — minimal required (RPC_URL only) populates sensible defaults", () => {
  const cfg = withEnv({ RPC_URL: "http://127.0.0.1:8899" }, () => loadConfig({}));
  assertEquals(cfg.rpcUrl, "http://127.0.0.1:8899");
  assertEquals(cfg.rpcProvider, "unknown");
  assertEquals(cfg.priceSource, "mock");
  assertEquals(cfg.pythTransport, "sse");
  assertEquals(cfg.pythQuoteKind, "spot");
  assertEquals(cfg.basisAdjustmentBps, 0);
  assertEquals(cfg.oracleModeAPushIntervalMs, 200);
  assertEquals(cfg.oracleModeBEvalIntervalMs, 1000);
  assertEquals(cfg.oracleModeCPollIntervalMs, 30_000);
  assertEquals(cfg.oracleModeAPriorityFeeMicrolamports, 50_000);
  assertEquals(cfg.oracleModeBPriorityFeeMicrolamports, 5_000);
  assertEquals(cfg.webhookPort, 8080);
  assertEquals(cfg.quoteValidWindowSlots, 200);
  assertEquals(cfg.verbose, false);
});

Deno.test("loadConfig — wallet path CLI args override env", () => {
  const cfg = withEnv(
    {
      RPC_URL: "http://127.0.0.1:8899",
      ORACLE_WALLET_PATH: "/env/oracle.json",
    },
    () =>
      loadConfig({
        oracleWallet: "/cli/oracle.json",
        adminWallet: "/cli/admin.json",
        feePayerWallet: "/cli/payer.json",
      }),
  );
  assertEquals(cfg.oracleWalletPath, "/cli/oracle.json");
  assertEquals(cfg.adminWalletPath, "/cli/admin.json");
  assertEquals(cfg.feePayerWalletPath, "/cli/payer.json");
});

Deno.test("loadConfig — PROGRAM_ID env parses to PublicKey", () => {
  const cfg = withEnv(
    {
      RPC_URL: "http://127.0.0.1:8899",
      PROGRAM_ID: "3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy",
    },
    () => loadConfig({}),
  );
  assertExists(cfg.programIdOverride);
  assertEquals(
    cfg.programIdOverride!.toBase58(),
    "3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy",
  );
});

Deno.test("loadConfig — PYTH options propagate when PRICE_SOURCE=pyth", () => {
  const feed = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
  const cfg = withEnv(
    {
      RPC_URL: "http://127.0.0.1:8899",
      PRICE_SOURCE: "pyth",
      PYTH_FEED_ID: feed,
      PYTH_TRANSPORT: "poll",
      PYTH_QUOTE_KIND: "ema",
      PYTH_MAX_STALENESS_SEC: "30",
      PRICE_SOURCE_POLL_MS: "500",
      BASIS_ADJUSTMENT_BPS: "-15",
    },
    () => loadConfig({}),
  );
  assertEquals(cfg.priceSource, "pyth");
  assertEquals(cfg.pythFeedId, feed);
  assertEquals(cfg.pythTransport, "poll");
  assertEquals(cfg.pythQuoteKind, "ema");
  assertEquals(cfg.pythMaxStalenessSec, 30);
  assertEquals(cfg.priceSourcePollMs, 500);
  assertEquals(cfg.basisAdjustmentBps, -15);
});

Deno.test("loadConfig — empty PRICE_SOURCE env falls back to default 'mock'", () => {
  const cfg = withEnv(
    { RPC_URL: "http://127.0.0.1:8899", PRICE_SOURCE: "" },
    () => loadConfig({}),
  );
  assertEquals(cfg.priceSource, "mock");
});

Deno.test("loadConfig — verbose toggles from env or args", () => {
  const cfg1 = withEnv(
    { RPC_URL: "x", VERBOSE: "true" },
    () => loadConfig({}),
  );
  assertEquals(cfg1.verbose, true);
  const cfg2 = withEnv({ RPC_URL: "x" }, () => loadConfig({ verbose: true }));
  assertEquals(cfg2.verbose, true);
  const cfg3 = withEnv({ RPC_URL: "x" }, () => loadConfig({}));
  assertEquals(cfg3.verbose, false);
});
