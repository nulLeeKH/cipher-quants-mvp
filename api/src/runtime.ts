// ============================================================================
// API runtime dependency bundle
// ============================================================================
// Explicitly lists the dependencies wired by server.ts and consumed by HTTP
// handlers/services. SDK modules stay `any` for now because the CommonJS build
// is dynamically required; tightening those types is a separate refactor.

import type { Connection, Keypair, PublicKey } from "@solana/web3.js";

import type { ApiConfig } from "./config.ts";
import type { Metrics } from "./metrics.ts";
import type { QuoteStore } from "./quote_store.ts";
import type { SlidingWindowRateLimiter } from "./rate_limit.ts";

export type ResolvedApiConfig = ApiConfig & {
  baseMint: PublicKey;
  quoteMint: PublicKey;
};

export interface ApiRuntime {
  config: ResolvedApiConfig;
  connection: Connection;
  // deno-lint-ignore no-explicit-any
  program: any;
  quoteSigner: Keypair;
  metrics: Metrics;
  quoteStore: QuoteStore;
  rateLimiter: SlidingWindowRateLimiter;
  // deno-lint-ignore no-explicit-any
  sdk: any;
  // deno-lint-ignore no-explicit-any
  sdkAccounts: any;
  // deno-lint-ignore no-explicit-any
  sdkInstructions: any;
}
