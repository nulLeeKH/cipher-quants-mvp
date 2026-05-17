import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";

import { type Program, type SideArg, sideToArg } from "../program.js";

export type Side = "buy" | "sell";

export { sideToArg };
export type { SideArg };

/**
 * Map (input_mint, output_mint) → Side for the given pool.
 *
 * Routers / aggregators (e.g. JupiterZ webhook) express a swap intent via
 * input/output mints, while our on-chain program is Buy/Sell-shaped. This
 * helper bridges the two.
 *
 * - input=quote, output=base → Buy (user buys base)
 * - input=base, output=quote → Sell (user sells base)
 */
export function directionFromMints(
  inputMint: PublicKey,
  outputMint: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey
): Side {
  if (inputMint.equals(quoteMint) && outputMint.equals(baseMint)) return "buy";
  if (inputMint.equals(baseMint) && outputMint.equals(quoteMint)) return "sell";
  throw new Error(
    `Mints do not match pool: input=${inputMint.toBase58()}, ` +
      `output=${outputMint.toBase58()}, base=${baseMint.toBase58()}, ` +
      `quote=${quoteMint.toBase58()}`
  );
}

/**
 * Signed RFQ quote argument forwarded into `execute_swap`. SDK consumers
 * create this via `buildSignedQuoteWithVerifyIx`.
 */
export interface SignedQuoteArg {
  pool: PublicKey;
  user: PublicKey;
  direction: SideArg | Side;
  inputAmount: BN;
  price: BN;
  expirySlot: BN;
  nonce: BN;
  signature: number[] | Uint8Array; // 64 bytes
}

export interface ExecuteSwapParams {
  user: PublicKey;
  poolState: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  userBaseAta: PublicKey;
  userQuoteAta: PublicKey;
  inputAmount: BN;
  direction: Side;
  minOutput: BN;
  /** Optional. Attach a signed quote to take the RFQ path. */
  signedQuote?: SignedQuoteArg | null;
  /** quote_nonce_marker PDA, passed as remaining_accounts[0] on the RFQ path.
   *  Leave undefined on the curve path. */
  quoteNonceMarker?: PublicKey;
}

/**
 * SPECIFICATION §3.3 — execute_swap (raw instruction builder).
 *
 * For the RFQ path:
 *   - Provide both signedQuote + quoteNonceMarker.
 *   - **You MUST prepend the Ed25519 verify instruction directly before this
 *     ix** (use `executeSwapWithVerify` for the safe path).
 *
 * For the curve path, leave both undefined/null.
 */
export async function createExecuteSwapIx(
  program: Program,
  params: ExecuteSwapParams
): Promise<TransactionInstruction> {
  if (params.signedQuote && !params.quoteNonceMarker) {
    throw new Error(
      "executeSwap: signedQuote provided without quoteNonceMarker. " +
        "Use executeSwapWithVerify() helper or derive the marker via deriveQuoteNonceMarker()."
    );
  }

  let builder = program.methods
    .executeSwap(
      params.inputAmount,
      params.direction,
      params.minOutput,
      params.signedQuote ?? null
    )
    .accountsPartial({
      user: params.user,
      poolState: params.poolState,
      baseVault: params.baseVault,
      quoteVault: params.quoteVault,
      userBaseAta: params.userBaseAta,
      userQuoteAta: params.userQuoteAta,
    });

  if (params.quoteNonceMarker) {
    builder = builder.remainingAccounts([
      {
        pubkey: params.quoteNonceMarker,
        isSigner: false,
        isWritable: true,
      },
    ]);
  }

  return builder.instruction();
}
