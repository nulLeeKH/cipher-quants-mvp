import { Keypair, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";

import { AnchorProvider, Wallet } from "./anchor.ts";
import type { Protocol } from "@cipher-quants/sdk";

const require = createRequire(import.meta.url);
// The SDK ships as CommonJS. We use createRequire to bypass Deno's strict
// file-path ESM resolution.
const sdk = require("../../sdk/dist/index.js") as {
  createProgram: (provider: typeof AnchorProvider.prototype) => any;
  PROGRAM_ID: PublicKey;
};
const { createProgram: sdkCreateProgram, PROGRAM_ID } = sdk;

import type { RpcAdapter } from "./connection.ts";

// ============================================================================
// Anchor Provider + Program builder
// ============================================================================
// The SDK constructs a typed Program<Protocol>. The keeper uses that Program
// for every instruction (oracle update, RFQ webhook swap tx, admin ops, ...).

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
