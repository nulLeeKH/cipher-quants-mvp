import { type KeeperConfig } from "./config.ts";

// ============================================================================
// Keeper Service Loop
// ============================================================================
// Main service that watches on-chain state and triggers actions.
//
// Typical keeper responsibilities:
//   - Crank: Call permissionless instructions on a schedule
//   - Watch: Monitor price feeds, account state changes
//   - Settle: Finalize expired markets/positions
//   - Index: Track events for off-chain queries
//
// Pattern:
//   1. Connect to RPC + load program
//   2. Discover active accounts/markets
//   3. Enter main loop: check state → act if needed → sleep → repeat
//   4. Handle errors gracefully (retry with backoff)
// ============================================================================

export async function startService(config: KeeperConfig): Promise<void> {
  console.log("Initializing keeper service...");

  // TODO: Setup
  // const connection = new Connection(config.rpcUrl, "confirmed");
  // const wallet = loadWallet(config.walletPath);
  // const program = createProgram(connection, wallet);

  // Main loop
  while (true) {
    try {
      // TODO: Your keeper logic here
      // 1. Fetch current on-chain state
      // 2. Check if any action is needed
      // 3. Submit transactions if needed

      if (config.verbose) {
        console.log(`[${new Date().toISOString()}] Heartbeat — no action needed`);
      }
    } catch (err) {
      console.error("Error in keeper loop:", err);
      // Don't crash on transient errors
    }

    // Wait before next check
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}
