import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";

import { derivePoolState, deriveVault } from "../accounts/index.js";
import { type Program } from "../program.js";

export interface DepthParams {
  depthCoefBps: number;
  sizeUnit: BN;
  maxDepthBps: number;
  /** Legacy slot for Anchor-era callers. Ignored — Borsh writes zeros itself. */
  reserved?: number[];
}

export interface SkewParams {
  targetBaseBps: number;
  skewCoefBps: number;
  maxSkewOffsetBps: number;
  /** Legacy slot for Anchor-era callers. Ignored — Borsh writes zeros itself. */
  reserved?: number[];
}

export interface InitPoolParams {
  admin: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  authorizedOracleSigner: PublicKey;
  /** Initial RFQ quote ed25519 signer. Required and must be non-zero. A
   *  distinct keypair from `authorizedOracleSigner` halves the blast radius
   *  of either hot key being compromised. PoC may pass the same key for
   *  convenience but production deployments MUST split. Rotated via
   *  `rotate_quote_signer`. */
  authorizedQuoteSigner: PublicKey;
  initialFairValue: BN;
  initialSpreadBps: number;
  initialDepthParams: DepthParams;
  initialSkewParams: SkewParams;
  initialModeTtl: number;
}

/**
 * SPECIFICATION §3.1 — init_pool
 */
export async function createInitPoolIx(
  program: Program,
  params: InitPoolParams
): Promise<TransactionInstruction> {
  const [poolState] = derivePoolState(
    params.baseMint,
    params.quoteMint,
    program.programId
  );
  const [baseVault] = deriveVault(poolState, params.baseMint, program.programId);
  const [quoteVault] = deriveVault(
    poolState,
    params.quoteMint,
    program.programId
  );

  return program.methods
    .initPool(
      params.authorizedOracleSigner,
      params.authorizedQuoteSigner,
      params.initialFairValue,
      params.initialSpreadBps,
      params.initialDepthParams,
      params.initialSkewParams,
      params.initialModeTtl
    )
    .accountsPartial({
      admin: params.admin,
      poolState,
      baseMint: params.baseMint,
      quoteMint: params.quoteMint,
      baseVault,
      quoteVault,
    })
    .instruction();
}
