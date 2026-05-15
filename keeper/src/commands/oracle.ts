import { bold, cyan, dim, red } from "@std/fmt/colors";
import { createRequire } from "node:module";

import type { KeeperConfig } from "../config.ts";
import type { KeeperProgram } from "../program.ts";
import { JsonFileKeypairProvider } from "../wallet.ts";
import { MockPriceSource } from "../sources/mock.ts";
import { createOracleSharedState } from "../oracle/state.ts";
import { startOracleWorker } from "../oracle/worker.ts";

const require = createRequire(import.meta.url);
const sdkAccounts = require("../../../sdk/dist/accounts/index.js") as any;

// ============================================================================
// `keeper oracle` — start oracle worker loop
// ============================================================================
// PoC: MockPriceSource (random walk). Real data sources (Finnhub, Pyth, ...)
// are tracked in TODO.md §1 — wire up the concrete PriceSource implementation
// right before entering Stage 1.

export async function runOracle(
  config: KeeperConfig,
  program: KeeperProgram
): Promise<void> {
  if (!config.baseMint || !config.quoteMint) {
    console.error(red("BASE_MINT and QUOTE_MINT env vars required"));
    Deno.exit(1);
  }

  console.log(bold(cyan("Oracle worker")));

  // Load oracle signer (same as program payer in this command path)
  const oracleProvider = new JsonFileKeypairProvider(config.oracleWalletPath);
  const oracleSigner = await oracleProvider.getKeypair();
  console.log(dim(`  Oracle signer: ${oracleSigner.publicKey.toBase58()}`));

  // Fetch current PoolState (initial nonce)
  const { address: poolState, state: pool } = await sdkAccounts.fetchPoolState(
    program.program,
    config.baseMint,
    config.quoteMint
  );
  console.log(dim(`  Pool:          ${poolState.toBase58()}`));
  console.log(dim(`  Initial nonce: ${pool.oracleNonce.toString()}`));

  // PriceSource — mock for PoC
  const source = new MockPriceSource({
    basePrice: BigInt(pool.fairValue.toString()) || 100_000_000n,
    stepBps: 5,
    tickIntervalMs: 200,
    spikeProb: 0.01,
    spikeMagnitudeBps: 50,
  });

  const initialTick = await source.current();

  const [baseVault] = sdkAccounts.deriveVault(
    poolState,
    config.baseMint,
    program.programId
  );
  const [quoteVault] = sdkAccounts.deriveVault(
    poolState,
    config.quoteMint,
    program.programId
  );

  const state = createOracleSharedState(
    {
      poolState,
      baseMint: config.baseMint,
      quoteMint: config.quoteMint,
      baseVault,
      quoteVault,
      bump: pool.bump,
      admin: pool.admin,
    },
    oracleSigner,
    BigInt(pool.oracleNonce.toString()),
    initialTick
  );

  const handle = await startOracleWorker({
    config,
    program,
    source,
    state,
    baseSpreadBps: pool.spreadBps || 20,
    depthParams: pool.depthCurveParams,
    skewParams: pool.inventorySkewParams,
  });

  console.log(bold(cyan("  Running. Ctrl+C to stop.")));
  console.log(dim(`    Mode A push: every ${config.oracleModeAPushIntervalMs}ms`));
  console.log(dim(`    Mode B eval: every ${config.oracleModeBEvalIntervalMs}ms`));

  // Graceful shutdown
  const cleanup = async () => {
    console.log(dim("\n  Shutting down..."));
    await handle.stop();
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", cleanup);
  Deno.addSignalListener("SIGTERM", cleanup);

  // Keep alive
  await new Promise(() => {});
}
