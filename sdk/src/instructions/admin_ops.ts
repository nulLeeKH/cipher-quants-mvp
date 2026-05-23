import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";

import { type Program } from "../program.js";
import { deriveAdminProposal } from "../accounts/index.js";

// ============================================================================
// set_paused — SPECIFICATION §3.4
// ============================================================================

export async function createSetPausedIx(
  program: Program,
  params: { admin: PublicKey; poolState: PublicKey; paused: boolean }
): Promise<TransactionInstruction> {
  return program.methods
    .setPaused(params.paused)
    .accountsPartial({ admin: params.admin, poolState: params.poolState })
    .instruction();
}

// ============================================================================
// rotate_oracle_signer — SPECIFICATION §3.5
// ============================================================================

export async function createRotateOracleSignerIx(
  program: Program,
  params: {
    admin: PublicKey;
    poolState: PublicKey;
    newAuthorizedOracleSigner: PublicKey;
  }
): Promise<TransactionInstruction> {
  return program.methods
    .rotateOracleSigner(params.newAuthorizedOracleSigner)
    .accountsPartial({ admin: params.admin, poolState: params.poolState })
    .instruction();
}

// ============================================================================
// rotate_quote_signer — SPECIFICATION §3.12
// ============================================================================

export async function createRotateQuoteSignerIx(
  program: Program,
  params: {
    admin: PublicKey;
    poolState: PublicKey;
    newAuthorizedQuoteSigner: PublicKey;
  }
): Promise<TransactionInstruction> {
  return program.methods
    .rotateQuoteSigner(params.newAuthorizedQuoteSigner)
    .accountsPartial({ admin: params.admin, poolState: params.poolState })
    .instruction();
}

// ============================================================================
// rotate_admin (single-step) — SPECIFICATION §3.7
// ============================================================================

export async function createRotateAdminIx(
  program: Program,
  params: { admin: PublicKey; poolState: PublicKey; newAdmin: PublicKey }
): Promise<TransactionInstruction> {
  return program.methods
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
  program: Program,
  params: AdminWithdrawParams
): Promise<TransactionInstruction> {
  return program.methods
    .adminWithdrawInventory(params.withdrawBaseAmount, params.withdrawQuoteAmount)
    .accountsPartial({
      admin: params.admin,
      poolState: params.poolState,
      baseVault: params.baseVault,
      quoteVault: params.quoteVault,
      adminBaseAta: params.adminBaseAta,
      adminQuoteAta: params.adminQuoteAta,
    })
    .instruction();
}

// ============================================================================
// close_expired_nonce — SPECIFICATION §3.8
// ============================================================================

export async function createCloseExpiredNonceIx(
  program: Program,
  params: {
    closer: PublicKey;
    poolState: PublicKey;
    quoteNonceMarker: PublicKey;
  }
): Promise<TransactionInstruction> {
  return program.methods
    .closeExpiredNonce()
    .accountsPartial({
      closer: params.closer,
      poolState: params.poolState,
      quoteNonceMarker: params.quoteNonceMarker,
    })
    .instruction();
}

// ============================================================================
// propose_admin / accept_admin / cancel_admin_proposal — SPECIFICATION §3.9–§3.11
// ============================================================================

export async function createProposeAdminIx(
  program: Program,
  params: { admin: PublicKey; poolState: PublicKey; newAdmin: PublicKey }
): Promise<TransactionInstruction> {
  const [adminProposal] = deriveAdminProposal(params.poolState, program.programId);
  return program.methods
    .proposeAdmin(params.newAdmin)
    .accountsPartial({
      admin: params.admin,
      poolState: params.poolState,
      adminProposal,
    })
    .instruction();
}

export async function createAcceptAdminIx(
  program: Program,
  params: { newAdmin: PublicKey; poolState: PublicKey }
): Promise<TransactionInstruction> {
  const [adminProposal] = deriveAdminProposal(params.poolState, program.programId);
  return program.methods
    .acceptAdmin()
    .accountsPartial({
      newAdmin: params.newAdmin,
      poolState: params.poolState,
      adminProposal,
    })
    .instruction();
}

export async function createCancelAdminProposalIx(
  program: Program,
  params: { admin: PublicKey; poolState: PublicKey }
): Promise<TransactionInstruction> {
  const [adminProposal] = deriveAdminProposal(params.poolState, program.programId);
  return program.methods
    .cancelAdminProposal()
    .accountsPartial({
      admin: params.admin,
      poolState: params.poolState,
      adminProposal,
    })
    .instruction();
}
