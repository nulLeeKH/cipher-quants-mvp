import { BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { Protocol } from "../idl/protocol.js";
import { derivePoolState, deriveVault } from "../accounts/index.js";

export interface DepthParams {
  depthCoefBps: number;
  sizeUnit: BN;
  maxDepthBps: number;
  reserved?: number[]; // 6 bytes, default zero-fill
}

export interface SkewParams {
  targetBaseBps: number;
  skewCoefBps: number;
  maxSkewOffsetBps: number;
  reserved?: number[]; // 10 bytes, default zero-fill
}

export interface InitPoolParams {
  admin: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  authorizedOracleSigner: PublicKey;
  initialFairValue: BN;
  initialSpreadBps: number;
  initialDepthParams: DepthParams;
  initialSkewParams: SkewParams;
  initialModeTtl: number;
}

function fillReserved(
  params: DepthParams | SkewParams,
  size: number
): any {
  return {
    ...params,
    reserved: params.reserved ?? Array(size).fill(0),
  };
}

/**
 * SPECIFICATION §3.1 — init_pool
 */
export async function createInitPoolIx(
  program: Program<Protocol>,
  params: InitPoolParams
): Promise<TransactionInstruction> {
  const [poolState] = derivePoolState(
    params.baseMint,
    params.quoteMint,
    program.programId
  );
  const [baseVault] = deriveVault(
    poolState,
    params.baseMint,
    program.programId
  );
  const [quoteVault] = deriveVault(
    poolState,
    params.quoteMint,
    program.programId
  );

  return await program.methods
    .initPool(
      params.authorizedOracleSigner,
      params.initialFairValue,
      params.initialSpreadBps,
      fillReserved(params.initialDepthParams, 6) as any,
      fillReserved(params.initialSkewParams, 10) as any,
      params.initialModeTtl
    )
    .accountsPartial({
      admin: params.admin,
      poolState,
      baseMint: params.baseMint,
      quoteMint: params.quoteMint,
      baseVault,
      quoteVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
}
