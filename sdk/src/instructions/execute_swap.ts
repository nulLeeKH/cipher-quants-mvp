import { BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { Protocol } from "../idl/protocol.js";

export type Side = "buy" | "sell";

/** Anchor IDL Side enum as a union-object (Borsh enum encoding). */
export type SideArg = { buy: Record<string, never> } | { sell: Record<string, never> };

export function sideToArg(side: Side): SideArg {
  return side === "buy" ? { buy: {} } : { sell: {} };
}

/**
 * Map (input_mint, output_mint) → Side for the given pool.
 *
 * Routers / aggregators (e.g. JupiterZ webhook) express a swap intent via
 * input/output mints, while our on-chain program is Buy/Sell-shaped. This
 * helper bridges the two.
 *
 * - input=quote, output=base → Buy (user buys base)
 * - input=base, output=quote → Sell (user sells base)
 *
 * Any other combination (e.g. a mint not in the pool) throws.
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
 * SignedQuote is forwarded straight into the Anchor instruction, so `direction`
 * uses the Anchor union-object form. SDK consumers create this via
 * `buildSignedQuoteWithVerifyIx`, which converts internally.
 */
export interface SignedQuoteArg {
  pool: PublicKey;
  user: PublicKey;
  direction: SideArg;
  inputAmount: BN;
  price: BN;
  expirySlot: BN;
  nonce: BN;
  signature: number[]; // 64 bytes
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
  program: Program<Protocol>,
  params: ExecuteSwapParams
): Promise<TransactionInstruction> {
  // RFQ-path consistency — if signedQuote is set but quoteNonceMarker is not,
  // the on-chain program errors cryptically. Catch the mistake at the SDK
  // entry point.
  if (params.signedQuote && !params.quoteNonceMarker) {
    throw new Error(
      "executeSwap: signedQuote provided without quoteNonceMarker. " +
        "Use executeSwapWithVerify() helper or derive the marker via deriveQuoteNonceMarker()."
    );
  }

  const directionArg = sideToArg(params.direction);
  // SignedQuoteArg.direction is already in SideArg union-object form
  // (buildSignedQuoteWithVerifyIx performs the conversion).
  const signedQuoteArg = params.signedQuote ?? null;

  // Anchor IDL-generated argument types use deeply-nested unions; passing our
  // typed SideArg / SignedQuoteArg matches at runtime but is too narrow for
  // Anchor's structural compare. We trust the runtime layout and accept the
  // structural cast (NOT a security guard — Borsh discriminants are tested in
  // tests/protocol.test.ts "Borsh parity").
  let builder = program.methods
    .executeSwap(
      params.inputAmount,
      directionArg as Parameters<typeof program.methods.executeSwap>[1],
      params.minOutput,
      signedQuoteArg as Parameters<typeof program.methods.executeSwap>[3]
    )
    .accountsPartial({
      user: params.user,
      poolState: params.poolState,
      baseVault: params.baseVault,
      quoteVault: params.quoteVault,
      userBaseAta: params.userBaseAta,
      userQuoteAta: params.userQuoteAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
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

  return await builder.instruction();
}
