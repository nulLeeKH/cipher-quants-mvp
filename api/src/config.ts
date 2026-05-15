import "jsr:@std/dotenv/load";
import { PublicKey } from "@solana/web3.js";

// ============================================================================
// API Server Config
// ============================================================================
// 24/7 RFQ webhook + read-only on-chain queries.
// Currently *shares the oracle key with the keeper* — same quote-signing
// authority. Future work can split this into a dedicated quote_signer key.

export interface ApiConfig {
  rpcUrl: string;
  rpcWsUrl?: string;
  rpcProvider: string;

  /** RFQ quote ed25519 signer — either the keeper's oracle hot key or a separate quote_signer. */
  quoteSignerWalletPath: string;

  programIdOverride?: PublicKey;
  baseMint?: PublicKey;
  quoteMint?: PublicKey;

  /** HTTP server port */
  port: number;
  /** Quote expiry in slots; expirySlot = currentSlot + N. */
  quoteValidWindowSlots: number;

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
        `${home}/.config/solana/oracle.json` // PoC: same key as the keeper
      ),

    programIdOverride: envPubkey("PROGRAM_ID"),
    baseMint: envPubkey("BASE_MINT"),
    quoteMint: envPubkey("QUOTE_MINT"),

    port: parseInt(envOptional("API_PORT", "8080"), 10),
    quoteValidWindowSlots: parseInt(
      envOptional("QUOTE_VALID_WINDOW_SLOTS", "200"),
      10
    ),

    verbose:
      (args.verbose as boolean) || Deno.env.get("VERBOSE") === "true",
  };
}
