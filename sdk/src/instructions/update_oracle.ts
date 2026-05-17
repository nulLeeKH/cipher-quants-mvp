import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";

import { type Program } from "../program.js";
import { DepthParams, SkewParams } from "./init_pool.js";

export interface UpdateOracleParams {
  oracleSigner: PublicKey;
  poolState: PublicKey;
  newFairValue: BN;
  newSpreadBps: number;
  newDepthParams: DepthParams;
  newSkewParams: SkewParams;
  newNonce: BN;
  newTtl: number;
}

/**
 * SPECIFICATION §3.2 — update_oracle
 * The keeper updates oracle pricing parameters. Monotonic nonce is enforced on-chain.
 */
export async function createUpdateOracleIx(
  program: Program,
  params: UpdateOracleParams
): Promise<TransactionInstruction> {
  return program.methods
    .updateOracle(
      params.newFairValue,
      params.newSpreadBps,
      params.newDepthParams,
      params.newSkewParams,
      params.newNonce,
      params.newTtl
    )
    .accountsPartial({
      oracleSigner: params.oracleSigner,
      poolState: params.poolState,
    })
    .instruction();
}
