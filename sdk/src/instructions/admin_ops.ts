import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { Protocol } from "../idl/protocol.js";

// ============================================================================
// set_paused — SPECIFICATION §3.4
// ============================================================================

export async function createSetPausedIx(
  program: Program<Protocol>,
  params: { admin: PublicKey; poolState: PublicKey; paused: boolean }
): Promise<TransactionInstruction> {
  return await program.methods
    .setPaused(params.paused)
    .accountsPartial({ admin: params.admin, poolState: params.poolState })
    .instruction();
}

// ============================================================================
// rotate_oracle_signer — SPECIFICATION §3.5
// ============================================================================

export async function createRotateOracleSignerIx(
  program: Program<Protocol>,
  params: {
    admin: PublicKey;
    poolState: PublicKey;
    newAuthorizedOracleSigner: PublicKey;
  }
): Promise<TransactionInstruction> {
  return await program.methods
    .rotateOracleSigner(params.newAuthorizedOracleSigner)
    .accountsPartial({ admin: params.admin, poolState: params.poolState })
    .instruction();
}

// ============================================================================
// rotate_admin — SPECIFICATION §3.7
// ============================================================================

export async function createRotateAdminIx(
  program: Program<Protocol>,
  params: { admin: PublicKey; poolState: PublicKey; newAdmin: PublicKey }
): Promise<TransactionInstruction> {
  return await program.methods
    .rotateAdmin(params.newAdmin)
    .accountsPartial({ admin: params.admin, poolState: params.poolState })
    .instruction();
}

// ============================================================================
// admin_withdraw_inventory — SPECIFICATION §3.6
// ============================================================================

export interface AdminWithdrawParams {
  admin: PublicKey;
  poolState: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  adminBaseAta: PublicKey;
  adminQuoteAta: PublicKey;
  withdrawBaseAmount: BN;
  withdrawQuoteAmount: BN;
}

export async function createAdminWithdrawInventoryIx(
  program: Program<Protocol>,
  params: AdminWithdrawParams
): Promise<TransactionInstruction> {
  return await program.methods
    .adminWithdrawInventory(
      params.withdrawBaseAmount,
      params.withdrawQuoteAmount
    )
    .accountsPartial({
      admin: params.admin,
      poolState: params.poolState,
      baseVault: params.baseVault,
      quoteVault: params.quoteVault,
      adminBaseAta: params.adminBaseAta,
      adminQuoteAta: params.adminQuoteAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

// ============================================================================
// close_expired_nonce — SPECIFICATION §3.8
// ============================================================================

export async function createCloseExpiredNonceIx(
  program: Program<Protocol>,
  params: {
    closer: PublicKey;
    poolState: PublicKey;
    quoteNonceMarker: PublicKey;
  }
): Promise<TransactionInstruction> {
  return await program.methods
    .closeExpiredNonce()
    .accountsPartial({
      closer: params.closer,
      poolState: params.poolState,
      quoteNonceMarker: params.quoteNonceMarker,
    })
    .instruction();
}
