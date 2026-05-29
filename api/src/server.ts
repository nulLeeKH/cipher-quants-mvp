// ============================================================================
// RFQ webhook server bootstrap (JupiterZ-compatible)
// ============================================================================
// docs/OPERATIONS.md §5 — /quote /swap /tokens.
//
// Responsibilities kept here:
//   - Validate runtime config needed by every endpoint.
//   - Load quote signer keypair.
//   - Wire Solana/SDK/runtime dependencies.
//   - Start and stop Deno.serve.
//
// HTTP routing lives under http/, and RFQ business logic lives under services/.
// Separation from the keeper remains unchanged:
//   - Keeper     = oracle push (write to chain via update_oracle).
//   - API server = quote response (read chain + ed25519-sign quotes).

import { createRequire } from "node:module";

import { Connection, Keypair } from "@solana/web3.js";
import { bold, cyan, dim, red } from "@std/fmt/colors";

import type { ApiConfig } from "./config.ts";
import { createApiApp } from "./http/app.ts";
import { newMetrics } from "./metrics.ts";
import { createQuoteStore } from "./quote_store.ts";
import { createSlidingWindowRateLimiter } from "./rate_limit.ts";
import type { ApiRuntime } from "./runtime.ts";

// Load SDK via CommonJS require to bypass Deno's strict ESM resolution.
// The SDK now ships its own AnchorProvider / Wallet shim built on the
// Pinocchio dispatch — no @coral-xyz/anchor runtime dep anymore.
const require = createRequire(import.meta.url);
// deno-lint-ignore no-explicit-any
const sdk: any = require("../../sdk/dist/index.js");
// deno-lint-ignore no-explicit-any
const sdkAccounts: any = require("../../sdk/dist/accounts/index.js");
// deno-lint-ignore no-explicit-any
const sdkInstructions: any = require("../../sdk/dist/instructions/index.js");
const { AnchorProvider, Wallet } = sdk;

export interface ApiServerHandle {
  stop(): Promise<void>;
}

export async function startApiServer(
  config: ApiConfig,
): Promise<ApiServerHandle> {
  if (!config.baseMint || !config.quoteMint) {
    console.error(red("BASE_MINT and QUOTE_MINT env vars required"));
    Deno.exit(1);
  }

  // Load quote signer keypair.
  const text = await Deno.readTextFile(config.quoteSignerWalletPath);
  const secretArr = JSON.parse(text);
  const quoteSigner = Keypair.fromSecretKey(Uint8Array.from(secretArr));
  console.log(
    dim(`  Quote signer:  ${quoteSigner.publicKey.toBase58()} (loaded)`),
  );

  // Anchor provider + SDK program.
  const connection = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: config.rpcWsUrl,
  });
  const wallet = new Wallet(quoteSigner);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = sdk.createProgram(provider);
  const programId = config.programIdOverride ?? sdk.PROGRAM_ID;

  console.log(dim(`  Program:       ${programId.toBase58()}`));
  console.log(dim(`  Base mint:     ${config.baseMint.toBase58()}`));
  console.log(dim(`  Quote mint:    ${config.quoteMint.toBase58()}`));

  const metrics = newMetrics();
  const quoteStore = createQuoteStore();
  const rateLimiter = createSlidingWindowRateLimiter({
    windowMs: 1_000,
    cleanupIntervalMs: 60_000,
  });

  const runtime: ApiRuntime = {
    config,
    connection,
    program,
    quoteSigner,
    metrics,
    quoteStore,
    rateLimiter,
    sdk,
    sdkAccounts,
    sdkInstructions,
  };

  const app = createApiApp(runtime);
  const server = Deno.serve({ port: config.port }, app.fetch);
  console.log(
    bold(cyan(`  RFQ webhook listening on http://0.0.0.0:${config.port}`)),
  );

  return {
    async stop() {
      quoteStore.stop();
      rateLimiter.stop();
      await server.shutdown();
    },
  };
}
