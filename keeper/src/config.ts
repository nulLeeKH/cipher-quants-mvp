import "jsr:@std/dotenv/load";
import { PublicKey } from "@solana/web3.js";

import { parsePriceSourceKind } from "./sources/factory.ts";

// ============================================================================
// Keeper Configuration
// ============================================================================
// docs/OPERATIONS.md §13.2 — In the PoC we load keypair paths / private keys
// from `.env`. Production should migrate to Turnkey or AWS KMS Ed25519.
//
// All variables are listed in `.env.example`; the real `.env` is blocked from
// commit via `.gitignore`.
// ============================================================================

export interface KeeperConfig {
  // ----- RPC -----
  rpcUrl: string;
  rpcWsUrl?: string;
  /** RPC provider tag (helius / quicknode / triton / public). For logging and metrics. */
  rpcProvider: string;

  // ----- Wallets -----
  /** Oracle worker key — calls update_oracle + ed25519-signs RFQ quotes. */
  oracleWalletPath: string;
  /** Admin key — used for pause/rotate/withdraw and similar ops. */
  adminWalletPath: string;
  /** Fee payer the keeper uses when transferring tokens (usually same as admin). */
  feePayerWalletPath: string;

  // ----- Protocol -----
  /** Optional override. Defaults to the SDK's PROGRAM_ID. */
  programIdOverride?: PublicKey;

  // ----- Pool target -----
  /** base/quote mints of the pool this keeper operates (single pair in v1). */
  baseMint?: PublicKey;
  quoteMint?: PublicKey;

  // ----- Price source (driven by PRICE_SOURCE env) -----
  /** `mock` (default) — random walk. `pyth` — Pyth Hermes REST adapter. */
  priceSource: "mock" | "pyth";
  /** 64-char hex feed id; required when priceSource = "pyth".
   *  See https://pyth.network/developers/price-feed-ids */
  pythFeedId?: string;
  /** Override the Hermes base URL (default https://hermes.pyth.network). */
  pythHermesUrl?: string;
  /** Source poll cadence (ms). Adapter default applies when unset. */
  priceSourcePollMs?: number;

  // ----- Oracle worker timing (ms) -----
  /** Mode A push interval (PoC default 200ms — OPERATIONS §1). */
  oracleModeAPushIntervalMs: number;
  /** Mode B threshold evaluation interval (PoC default 1s). */
  oracleModeBEvalIntervalMs: number;
  /** Mode C — never pushes; this is only the polling interval for mode detection. */
  oracleModeCPollIntervalMs: number;

  // ----- Cancel priority (compute unit price, microLamports / CU) -----
  // OPERATIONS §4.5 — Mode A must land before snipers for stale-quote defense
  // to hold. We set the priority fee via ComputeBudgetProgram.setComputeUnitPrice.
  // Jito tips are out of scope for the PoC (they require a separate bundle
  // endpoint).
  oracleModeAPriorityFeeMicrolamports: number;
  oracleModeBPriorityFeeMicrolamports: number;

  // ----- RFQ webhook -----
  /** HTTP server port (JupiterZ webhook) */
  webhookPort: number;
  /** Response-side quote TTL in slots; expirySlot = currentSlot + N. */
  quoteValidWindowSlots: number;

  // ----- Misc -----
  verbose: boolean;
}

function envRequired(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(`Error: ${name} environment variable is required.`);
    console.error(`  See keeper/.env.example for full configuration.`);
    Deno.exit(1);
  }
  return v;
}

function envOptional(name: string, fallback: string): string {
  return Deno.env.get(name) ?? fallback;
}

function envPubkey(name: string): PublicKey | undefined {
  const v = Deno.env.get(name);
  if (!v) return undefined;
  try {
    return new PublicKey(v);
  } catch {
    console.error(`Error: ${name} is not a valid Solana pubkey (${v})`);
    Deno.exit(1);
  }
}

export function loadConfig(args: Record<string, unknown>): KeeperConfig {
  const home = Deno.env.get("HOME") ?? "";
  const verbose =
    (args.verbose as boolean) || Deno.env.get("VERBOSE") === "true";

  return {
    rpcUrl: envRequired("RPC_URL"),
    rpcWsUrl: Deno.env.get("RPC_WS_URL"),
    rpcProvider: envOptional("RPC_PROVIDER", "unknown"),

    oracleWalletPath:
      (args.oracleWallet as string) ||
      envOptional("ORACLE_WALLET_PATH", `${home}/.config/solana/oracle.json`),
    adminWalletPath:
      (args.adminWallet as string) ||
      envOptional("ADMIN_WALLET_PATH", `${home}/.config/solana/admin.json`),
    feePayerWalletPath:
      (args.feePayerWallet as string) ||
      envOptional("FEE_PAYER_WALLET_PATH", `${home}/.config/solana/admin.json`),

    programIdOverride: envPubkey("PROGRAM_ID"),
    baseMint: envPubkey("BASE_MINT"),
    quoteMint: envPubkey("QUOTE_MINT"),

    priceSource: parsePriceSourceKind(Deno.env.get("PRICE_SOURCE")),
    pythFeedId: Deno.env.get("PYTH_FEED_ID"),
    pythHermesUrl: Deno.env.get("PYTH_HERMES_URL"),
    priceSourcePollMs: Deno.env.get("PRICE_SOURCE_POLL_MS")
      ? parseInt(Deno.env.get("PRICE_SOURCE_POLL_MS")!, 10)
      : undefined,

    oracleModeAPushIntervalMs: parseInt(
      envOptional("ORACLE_MODE_A_PUSH_INTERVAL_MS", "200"),
      10
    ),
    oracleModeBEvalIntervalMs: parseInt(
      envOptional("ORACLE_MODE_B_EVAL_INTERVAL_MS", "1000"),
      10
    ),
    oracleModeCPollIntervalMs: parseInt(
      envOptional("ORACLE_MODE_C_POLL_INTERVAL_MS", "30000"),
      10
    ),

    // Cancel priority fees, units: microLamports / CU.
    // Mode A=50k (≈10k lamports @ 200 CU), Mode B=5k (≈1k lamports). Tune
    // against network congestion once in production.
    oracleModeAPriorityFeeMicrolamports: parseInt(
      envOptional("ORACLE_MODE_A_PRIORITY_FEE_MICROLAMPORTS", "50000"),
      10
    ),
    oracleModeBPriorityFeeMicrolamports: parseInt(
      envOptional("ORACLE_MODE_B_PRIORITY_FEE_MICROLAMPORTS", "5000"),
      10
    ),

    webhookPort: parseInt(envOptional("WEBHOOK_PORT", "8080"), 10),
    quoteValidWindowSlots: parseInt(
      envOptional("QUOTE_VALID_WINDOW_SLOTS", "200"),
      10
    ),

    verbose,
  };
}
