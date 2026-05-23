// ============================================================================
// /swap transaction assembly (pure, RPC-free)
// ============================================================================
// Lives standalone so the layout is unit-testable without spinning the api
// HTTP server or a validator. The HTTP handler in server.ts calls this with
// values it has already gathered (pending quote, fresh blockhash, built
// verify ix, etc.).
//
// Layout (must stay in sync with INTEGRATIONS.md §2.2):
//   [0] ComputeBudgetProgram.setComputeUnitLimit(SWAP_CU_LIMIT)
//   [1] createAssociatedTokenAccountIdempotent(user → user_base_ata)
//   [2] createAssociatedTokenAccountIdempotent(user → user_quote_ata)
//   [3] ed25519_verify_ix
//   [4] execute_swap_ix
// User wallet is the sole signer + fee payer. The MM's commitment is the
// ed25519 signature *inside* verify_ix.data, not a tx-level signature.

import { Buffer } from "node:buffer";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

/**
 * CU budget for the swap tx. Sized for the worst-case RFQ path with all
 * features active. Measured numbers (docs/PERFORMANCE.md, 2026-05-23):
 *   - execute_swap: 25,396 CU max observed across 12 samples (curve + RFQ).
 *   - ed25519 verify (Solana native precompile): ~10–30 kCU.
 *   - ATA idempotent × 2: ~150 CU when present, ~4 kCU each on first-time create.
 *   - ComputeBudget ix: ~150 CU.
 *   Total observed ceiling ≈ 65 kCU; with future inventory/vol-aware quoting
 *   bumping execute_swap toward its 200 kCU theoretical max, total ≈ 240 kCU.
 *   We pin 250 kCU as the cap so OOG never trips. The cap costs nothing if
 *   unused — only consumed CU counts toward the validator's tx accounting.
 */
export const SWAP_CU_LIMIT = 250_000;

export interface AssembleSwapTxParams {
  userPk: PublicKey;
  poolAddr: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  /** Pre-built ed25519 verify ix matching the MM's signed quote. */
  verifyIx: TransactionInstruction;
  /** Pre-built execute_swap ix (RFQ path, signedQuote attached, marker as
   *  remainingAccounts[0]). */
  swapIx: TransactionInstruction;
  recentBlockhash: string;
}

export interface AssembledSwapTx {
  /** Base64 unsigned `VersionedTransaction`. */
  txBase64: string;
  /** The 5 ixs in the order they were compiled (handy for tests/inspection). */
  instructions: TransactionInstruction[];
  /** ATAs derived from the user wallet (handy for callers that want to log them). */
  userBaseAta: PublicKey;
  userQuoteAta: PublicKey;
}

export function assembleSwapTx(p: AssembleSwapTxParams): AssembledSwapTx {
  const userBaseAta = getAssociatedTokenAddressSync(p.baseMint, p.userPk);
  const userQuoteAta = getAssociatedTokenAddressSync(p.quoteMint, p.userPk);

  const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: SWAP_CU_LIMIT,
  });
  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(
      p.userPk,
      userBaseAta,
      p.userPk,
      p.baseMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      p.userPk,
      userQuoteAta,
      p.userPk,
      p.quoteMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  ];
  const instructions = [cuLimitIx, ...ataIxs, p.verifyIx, p.swapIx];

  const txMsg = new TransactionMessage({
    payerKey: p.userPk,
    recentBlockhash: p.recentBlockhash,
    instructions,
  }).compileToV0Message();
  const vtx = new VersionedTransaction(txMsg);
  // VersionedTransaction pre-allocates one zero-filled 64-byte signature
  // placeholder per required signer; user replaces with their real signature
  // after deserialising. `serialize()` accepts zero placeholders.
  const serialized = vtx.serialize();
  const txBase64 = Buffer.from(serialized).toString("base64");

  return { txBase64, instructions, userBaseAta, userQuoteAta };
}
