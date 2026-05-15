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
): Uint8Array {
  const buf = new Uint8Array(97);
  buf.set(msg.pool.toBuffer(), 0); // 32
  buf.set(msg.user.toBuffer(), 32); // 32
  buf[64] = msg.direction === "buy" ? SIDE_BUY_TAG : SIDE_SELL_TAG;
  const view = new DataView(buf.buffer);
  view.setBigUint64(65, msg.inputAmount, true); // little-endian
  view.setBigUint64(73, msg.price, true);
  view.setBigUint64(81, msg.expirySlot, true);
  view.setBigUint64(89, msg.nonce, true);
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
  messageBytes: Uint8Array;
} {
  const messageBytes = serializeSignedQuoteMessage(msg);

  // Ed25519Program.createInstructionWithPrivateKey internally signs + builds the verify ix.
  const verifyIx = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: oracleSigner.secretKey,
    message: messageBytes,
  });

  // verify ix data layout: [header(16) ... payload(pubkey+sig+msg)].
  // signature_offset is at bytes [2..4) as a u16 LE; extract the 64-byte signature.
  // Handles both Buffer and Uint8Array via DataView so we stay cross-runtime safe.
  const dataU8: Uint8Array =
    verifyIx.data instanceof Uint8Array
      ? verifyIx.data
      : new Uint8Array(verifyIx.data as ArrayBuffer);
  const sigOffset = new DataView(
    dataU8.buffer,
    dataU8.byteOffset,
    dataU8.byteLength
  ).getUint16(2, true);
  const signature = dataU8.subarray(sigOffset, sigOffset + 64);
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

  return { signedQuote, verifyIx, messageBytes };
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
