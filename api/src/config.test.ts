import { assertEquals, assertExists } from "jsr:@std/assert@1";

import { loadConfig } from "./config.ts";

// Snapshot/restore the env to keep tests isolated; envRequired calls
// Deno.exit on missing values so each test must provide RPC_URL.
const ENV_KEYS = [
  "RPC_URL",
  "RPC_PROVIDER",
  "RPC_WS_URL",
  "QUOTE_SIGNER_WALLET_PATH",
  "PROGRAM_ID",
  "BASE_MINT",
  "QUOTE_MINT",
  "API_PORT",
  "QUOTE_VALID_WINDOW_SLOTS",
  "MM_MAX_DRIFT_BPS",
  "BASE_SYMBOL",
  "BASE_DECIMALS",
  "QUOTE_SYMBOL",
  "QUOTE_DECIMALS",
  "METRICS_AUTH_TOKEN",
  "VERBOSE",
];

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prev[k] = Deno.env.get(k);
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

Deno.test("loadConfig — minimal env (RPC_URL only) supplies defaults", () => {
  const cfg = withEnv({ RPC_URL: "http://127.0.0.1:8899" }, () => loadConfig({}));
  assertEquals(cfg.rpcUrl, "http://127.0.0.1:8899");
  assertEquals(cfg.rpcProvider, "unknown");
  assertEquals(cfg.port, 8080);
  assertEquals(cfg.quoteValidWindowSlots, 200);
  assertEquals(cfg.mmMaxDriftBps, 50); // 0.5% — JupiterZ last-look threshold
  assertEquals(cfg.baseSymbol, "BASE");
  assertEquals(cfg.baseDecimals, 6);
  assertEquals(cfg.quoteSymbol, "QUOTE");
  assertEquals(cfg.quoteDecimals, 6);
  assertEquals(cfg.verbose, false);
  assertEquals(cfg.metricsAuthToken, undefined); // fail-closed default
});

Deno.test("loadConfig — token metadata env overrides", () => {
  const cfg = withEnv(
    {
      RPC_URL: "x",
      BASE_SYMBOL: "xTSLA",
      BASE_DECIMALS: "8",
      QUOTE_SYMBOL: "USDC",
      QUOTE_DECIMALS: "6",
    },
    () => loadConfig({}),
  );
  assertEquals(cfg.baseSymbol, "xTSLA");
  assertEquals(cfg.baseDecimals, 8);
  assertEquals(cfg.quoteSymbol, "USDC");
});

Deno.test("loadConfig — CLI arg overrides QUOTE_SIGNER_WALLET_PATH env", () => {
  const cfg = withEnv(
    {
      RPC_URL: "x",
      QUOTE_SIGNER_WALLET_PATH: "/env/oracle.json",
    },
    () => loadConfig({ quoteSignerWallet: "/cli/oracle.json" }),
  );
  assertEquals(cfg.quoteSignerWalletPath, "/cli/oracle.json");
});

Deno.test("loadConfig — METRICS_AUTH_TOKEN populates when set", () => {
  const cfg = withEnv(
    { RPC_URL: "x", METRICS_AUTH_TOKEN: "secret123" },
    () => loadConfig({}),
  );
  assertEquals(cfg.metricsAuthToken, "secret123");
});

Deno.test("loadConfig — pubkey env vars parse to PublicKey", () => {
  const cfg = withEnv(
    {
      RPC_URL: "x",
      PROGRAM_ID: "3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy",
      BASE_MINT: "So11111111111111111111111111111111111111112",
    },
    () => loadConfig({}),
  );
  assertExists(cfg.programIdOverride);
  assertExists(cfg.baseMint);
  assertEquals(
    cfg.programIdOverride!.toBase58(),
    "3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy",
  );
});

Deno.test("loadConfig — port and TTL overrides", () => {
  const cfg = withEnv(
    {
      RPC_URL: "x",
      API_PORT: "9090",
      QUOTE_VALID_WINDOW_SLOTS: "400",
    },
    () => loadConfig({}),
  );
  assertEquals(cfg.port, 9090);
  assertEquals(cfg.quoteValidWindowSlots, 400);
});

Deno.test("loadConfig — MM_MAX_DRIFT_BPS override", () => {
  const cfg = withEnv(
    { RPC_URL: "x", MM_MAX_DRIFT_BPS: "120" },
    () => loadConfig({}),
  );
  assertEquals(cfg.mmMaxDriftBps, 120);
});

Deno.test("loadConfig — verbose flips on env or CLI", () => {
  assertEquals(
    withEnv({ RPC_URL: "x", VERBOSE: "true" }, () => loadConfig({})).verbose,
    true,
  );
  assertEquals(
    withEnv({ RPC_URL: "x" }, () => loadConfig({ verbose: true })).verbose,
    true,
  );
  assertEquals(
    withEnv({ RPC_URL: "x" }, () => loadConfig({})).verbose,
    false,
  );
});
