import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

import { Protocol } from "../idl/protocol.js";
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

function fillReserved(params: any, size: number): any {
  return { ...params, reserved: params.reserved ?? Array(size).fill(0) };
}

/**
 * SPECIFICATION §3.2 — update_oracle
 * The keeper updates oracle pricing parameters. Monotonic nonce is enforced on-chain.
 */
export async function createUpdateOracleIx(
  program: Program<Protocol>,
  params: UpdateOracleParams
): Promise<TransactionInstruction> {
  return await program.methods
    .updateOracle(
      params.newFairValue,
      params.newSpreadBps,
      fillReserved(params.newDepthParams, 6) as any,
      fillReserved(params.newSkewParams, 10) as any,
      params.newNonce,
      params.newTtl
    )
    .accountsPartial({
      oracleSigner: params.oracleSigner,
      poolState: params.poolState,
    })
    .instruction();
}
