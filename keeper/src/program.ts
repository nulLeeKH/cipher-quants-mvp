import { Keypair, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";

import { AnchorProvider, Wallet } from "./anchor.ts";
import type { RpcAdapter } from "./connection.ts";

const require = createRequire(import.meta.url);
// The SDK ships as CommonJS. We use createRequire to bypass Deno's strict
// file-path ESM resolution.
// deno-lint-ignore no-explicit-any
const sdk: any = require("../../sdk/dist/index.js");
const { createProgram: sdkCreateProgram, PROGRAM_ID } = sdk;

// ============================================================================
// Program builder
// ============================================================================
// The SDK constructs a typed Program instance from a Pinocchio-era dispatcher
// shim. The keeper uses it for every instruction (oracle push, admin ops, ...).

// deno-lint-ignore no-explicit-any
export interface KeeperProgram {
  provider: any;
  // deno-lint-ignore no-explicit-any
  program: any;
  programId: PublicKey;
}

export function buildProgram(
  rpc: RpcAdapter,
  payerKeypair: Keypair,
  programIdOverride?: PublicKey
): KeeperProgram {
  const wallet = new Wallet(payerKeypair);
  const provider = new AnchorProvider(rpc.connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  const program = sdkCreateProgram(provider);
  return {
    provider,
    program,
    programId: programIdOverride ?? PROGRAM_ID,
  };
}
