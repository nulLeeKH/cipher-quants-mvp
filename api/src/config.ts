import "jsr:@std/dotenv/load";
import { PublicKey } from "@solana/web3.js";

// ============================================================================
// API Server Config
// ============================================================================
// 24/7 RFQ webhook + read-only on-chain queries.
// pool.authorized_quote_signer is a distinct on-chain field from
// pool.authorized_oracle_signer (see SPECIFICATION §2.1). The two keys may
// reuse the same keypair file for PoC convenience, but production MUST
// split — set QUOTE_SIGNER_WALLET_PATH to a separate keypair.

export interface ApiConfig {
  rpcUrl: string;
  rpcWsUrl?: string;
  rpcProvider: string;

  /** RFQ quote ed25519 signer — either the keeper's oracle hot key or a separate quote_signer. */
  quoteSignerWalletPath: string;

  programIdOverride?: PublicKey;
  baseMint?: PublicKey;
  quoteMint?: PublicKey;

  /** Token metadata for GET /tokens. Decimals MUST match the on-chain mint
   *  (or downstream UIs will render quantities wrong). Symbols are
   *  informational; aggregator UIs use them when no separate token-list
   *  lookup is available. */
  baseSymbol: string;
  baseDecimals: number;
  quoteSymbol: string;
  quoteDecimals: number;

  /** HTTP server port */
  port: number;
  /** Quote expiry in slots; expirySlot = currentSlot + N. */
  quoteValidWindowSlots: number;

  /** Last-look reject threshold (bps). At /swap time, if
   *  |fair_value_now - fair_value_at_quote| / fair_value_at_quote exceeds this,
   *  the MM rejects (409 PriceDrift). Default 50 (0.5%). */
  mmMaxDriftBps: number;

  /** Bearer token required on /metrics. If unset, the endpoint refuses to serve
   *  (fail-closed). Set via METRICS_AUTH_TOKEN env var. */
  metricsAuthToken?: string;

  verbose: boolean;
}

function envRequired(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(`Error: ${name} env var required.`);
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
    console.error(`Error: ${name} not a valid pubkey`);
    Deno.exit(1);
  }
}

export function loadConfig(args: Record<string, unknown>): ApiConfig {
  const home = Deno.env.get("HOME") ?? "";
  return {
    rpcUrl: envRequired("RPC_URL"),
    rpcWsUrl: Deno.env.get("RPC_WS_URL"),
    rpcProvider: envOptional("RPC_PROVIDER", "unknown"),

    quoteSignerWalletPath:
      (args.quoteSignerWallet as string) ||
      envOptional(
        "QUOTE_SIGNER_WALLET_PATH",
        // Default fallback only — production MUST set QUOTE_SIGNER_WALLET_PATH
        // to a keypair distinct from the keeper's oracle.json so the on-chain
        // authorized_quote_signer / authorized_oracle_signer split is real.
        `${home}/.config/solana/oracle.json`
      ),

    programIdOverride: envPubkey("PROGRAM_ID"),
    baseMint: envPubkey("BASE_MINT"),
    quoteMint: envPubkey("QUOTE_MINT"),

    baseSymbol: envOptional("BASE_SYMBOL", "BASE"),
    baseDecimals: parseInt(envOptional("BASE_DECIMALS", "6"), 10),
    quoteSymbol: envOptional("QUOTE_SYMBOL", "QUOTE"),
    quoteDecimals: parseInt(envOptional("QUOTE_DECIMALS", "6"), 10),

    port: parseInt(envOptional("API_PORT", "8080"), 10),
    quoteValidWindowSlots: parseInt(
      envOptional("QUOTE_VALID_WINDOW_SLOTS", "200"),
      10
    ),
    mmMaxDriftBps: parseInt(envOptional("MM_MAX_DRIFT_BPS", "50"), 10),

    metricsAuthToken: Deno.env.get("METRICS_AUTH_TOKEN"),

    verbose:
      (args.verbose as boolean) || Deno.env.get("VERBOSE") === "true",
  };
}
