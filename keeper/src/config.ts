import "jsr:@std/dotenv/load";

// ============================================================================
// Keeper Configuration
// ============================================================================
// Loads configuration from environment variables and CLI arguments.
// Add protocol-specific config values as your keeper grows.
// ============================================================================

export interface KeeperConfig {
  rpcUrl: string;
  walletPath: string;
  verbose: boolean;
  // Add interval configs:
  // checkIntervalMs: number;
  // pollIntervalMs: number;
}

export function loadConfig(args: Record<string, unknown>): KeeperConfig {
  const rpcUrl = Deno.env.get("RPC_URL");
  if (!rpcUrl) {
    console.error("Error: RPC_URL environment variable is required.");
    console.error("  Set it: export RPC_URL=https://api.devnet.solana.com");
    Deno.exit(1);
  }

  const walletPath =
    (args.wallet as string) ||
    Deno.env.get("WALLET_PATH") ||
    `${Deno.env.get("HOME")}/.config/solana/id.json`;

  const verbose =
    (args.verbose as boolean) ||
    Deno.env.get("VERBOSE") === "true";

  return {
    rpcUrl,
    walletPath,
    verbose,
  };
}
