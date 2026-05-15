import { BN, Program } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

import { Protocol } from "./idl/protocol.js";
import { deriveQuoteNonceMarker } from "./accounts/index.js";
import {
  SIDE_BUY_TAG,
  SIDE_SELL_TAG,
} from "./constants/index.js";
import {
  createExecuteSwapIx,
  ExecuteSwapParams,
  Side,
  SignedQuoteArg,
} from "./instructions/execute_swap.js";

// ============================================================================
// SignedQuote canonical serialization (97 bytes)
// docs/SPECIFICATION.md §2.3
// ============================================================================
//
// Layout (Borsh, little-endian):
//   pool         (32 bytes Pubkey)
//   user         (32 bytes Pubkey)
//   direction    (1 byte: Buy=0, Sell=1)
//   input_amount (8 bytes u64 LE)
//   price        (8 bytes u64 LE)
//   expiry_slot  (8 bytes u64 LE)
//   nonce        (8 bytes u64 LE)
//
// Total: 32+32+1+8+8+8+8 = 97 bytes

export interface SignedQuoteMessage {
  pool: PublicKey;
  user: PublicKey;
  direction: Side;
  inputAmount: bigint;
  price: bigint;
  expirySlot: bigint;
  nonce: bigint;
}

export function serializeSignedQuoteMessage(
  msg: SignedQuoteMessage
): Buffer {
  const buf = Buffer.alloc(97);
  msg.pool.toBuffer().copy(buf, 0);
  msg.user.toBuffer().copy(buf, 32);
  buf[64] = msg.direction === "buy" ? SIDE_BUY_TAG : SIDE_SELL_TAG;
  buf.writeBigUInt64LE(msg.inputAmount, 65);
  buf.writeBigUInt64LE(msg.price, 73);
  buf.writeBigUInt64LE(msg.expirySlot, 81);
  buf.writeBigUInt64LE(msg.nonce, 89);
  return buf;
}

// ============================================================================
// Build a SignedQuote + the matching Ed25519 verify instruction
// ============================================================================

/**
 * Helper used by the RFQ webhook to sign a quote with the oracle key.
 * Returns:
 *   - `signedQuote`: argument for execute_swap's signed_quote_opt
 *   - `verifyIx`:    the ed25519 verify instruction that must be prepended
 *                    directly before execute_swap
 *   - `messageBytes`: canonical serialized bytes (debug aid)
 */
export function buildSignedQuoteWithVerifyIx(
  oracleSigner: Keypair,
  msg: SignedQuoteMessage
): {
  signedQuote: SignedQuoteArg;
  verifyIx: TransactionInstruction;
  messageBytes: Buffer;
} {
  const messageBytes = serializeSignedQuoteMessage(msg);

  // Ed25519Program.createInstructionWithPrivateKey internally signs + builds the verify ix.
  const verifyIx = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: oracleSigner.secretKey,
    message: messageBytes,
  });

  // verify ix data layout: [header(16) ... payload(pubkey+sig+msg)].
  // signature_offset is at bytes [2..4) as a u16 LE; extract the 64-byte signature.
  const sigOffset = verifyIx.data.readUInt16LE(2);
  const signature = verifyIx.data.subarray(sigOffset, sigOffset + 64);
  if (signature.length !== 64) {
    throw new Error(
      `expected 64-byte signature, got ${signature.length}`
    );
  }

  const signedQuote: SignedQuoteArg = {
    pool: msg.pool,
    user: msg.user,
    direction: msg.direction === "buy" ? { buy: {} } : { sell: {} },
    inputAmount: new BN(msg.inputAmount.toString()),
    price: new BN(msg.price.toString()),
    expirySlot: new BN(msg.expirySlot.toString()),
    nonce: new BN(msg.nonce.toString()),
    signature: Array.from(signature),
  };

  return { signedQuote, verifyIx, messageBytes: Buffer.from(messageBytes) };
}

// ============================================================================
// executeSwapWithVerify — RFQ path one-shot wrapper
// ============================================================================

export interface ExecuteSwapWithVerifyParams
  extends Omit<ExecuteSwapParams, "signedQuote" | "quoteNonceMarker"> {
  /** Pre-built signed quote (from buildSignedQuoteWithVerifyIx) */
  signedQuote: SignedQuoteArg;
  /** Matching ed25519 verify ix (from buildSignedQuoteWithVerifyIx) */
  verifyIx: TransactionInstruction;
}

/**
 * Wrapper for the RFQ path. Auto-derives the quote_nonce_marker PDA; the caller
 * just bundles the returned verify ix + swap ix into the same transaction.
 *
 * Returns: [verifyIx, swapIx] — add to the transaction in this order.
 */
export async function executeSwapWithVerify(
  program: Program<Protocol>,
  params: ExecuteSwapWithVerifyParams
): Promise<[TransactionInstruction, TransactionInstruction]> {
  const noncebi = BigInt(params.signedQuote.nonce.toString());
  const [quoteNonceMarker] = deriveQuoteNonceMarker(
    params.poolState,
    noncebi,
    program.programId
  );

  const swapIx = await createExecuteSwapIx(program, {
    ...params,
    signedQuote: params.signedQuote,
    quoteNonceMarker,
  });

  return [params.verifyIx, swapIx];
}
