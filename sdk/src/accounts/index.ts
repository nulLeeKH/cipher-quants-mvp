// ============================================================================
// PDA Derivation + Account Fetch Helpers
// ============================================================================
// Mirror seeds defined in programs/protocol/src/constants.rs.
// Keep in sync with docs/ARCHITECTURE.md §5.
// ============================================================================

import { PublicKey } from "@solana/web3.js";

import {
  POOL_SEED,
  VAULT_SEED,
  QUOTE_USED_SEED,
  ADMIN_PROPOSAL_SEED,
} from "../constants/index.js";
import {
  PROGRAM_ID,
  type Program,
  derivePoolStatePda,
  deriveVaultPda,
  deriveAdminProposalPda,
} from "../program.js";
import { type PoolStateData } from "../borsh.js";

/**
 * PoolState PDA. Seeds: [b"pool", base_mint, quote_mint].
 * Invariant: base_mint < quote_mint (lexicographic).
 */
export function derivePoolState(
  baseMint: PublicKey,
  quoteMint: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return derivePoolStatePda(baseMint, quoteMint, programId);
}

/**
 * Pool vault PDA. Seeds: [b"vault", pool_state, mint].
 * Used for both base_vault and quote_vault.
 */
export function deriveVault(
  poolState: PublicKey,
  mint: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return deriveVaultPda(poolState, mint, programId);
}

/**
 * QuoteNonceMarker PDA. Seeds: [b"quote_used", pool_state, nonce_le_bytes].
 * Used as the RFQ replay marker. Once initialized, the same nonce cannot be reused.
 */
export function deriveQuoteNonceMarker(
  poolState: PublicKey,
  nonce: bigint,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  const nonceBuf = new Uint8Array(8);
  new DataView(nonceBuf.buffer).setBigUint64(0, nonce, true /* little-endian */);
  return PublicKey.findProgramAddressSync(
    [QUOTE_USED_SEED, poolState.toBuffer(), nonceBuf],
    programId
  );
}

/**
 * AdminRotationProposal PDA. Seeds: [b"admin_proposal", pool_state].
 */
export function deriveAdminProposal(
  poolState: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return deriveAdminProposalPda(poolState, programId);
}

// Re-export so older callers that imported the seed constants from `accounts/`
// don't need to update their import paths.
export { POOL_SEED, VAULT_SEED, QUOTE_USED_SEED, ADMIN_PROPOSAL_SEED };

/**
 * Sort two mints lexicographically. Returns [base, quote] where base < quote.
 * Required by init_pool's MintsNotSorted invariant.
 *
 * Cross-runtime safe — does NOT depend on Node.js `Buffer.compare`. Works in
 * browser (Next.js), Deno (keeper / api), and Node.
 */
export function sortMints(
  mintA: PublicKey,
  mintB: PublicKey
): [PublicKey, PublicKey] {
  const a = mintA.toBytes();
  const b = mintB.toBytes();
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? [mintA, mintB] : [mintB, mintA];
    }
  }
  return [mintA, mintB]; // equal — Pubkey collision, caller should reject via InvalidMintPair on-chain
}

// ============================================================================
// Fetch helpers
// ============================================================================

export interface PoolStateView {
  /** PDA address */
  address: PublicKey;
  /** Decoded PoolState. */
  state: PoolStateData;
}

/**
 * Derive + fetch PoolState in one call. Primary entry point for the frontend.
 *
 * @throws If account is not initialized.
 */
export async function fetchPoolState(
  program: Program,
  baseMint: PublicKey,
  quoteMint: PublicKey
): Promise<PoolStateView> {
  const [address] = derivePoolState(baseMint, quoteMint, program.programId);
  const state = await program.account.poolState.fetch(address);
  return { address, state };
}

/**
 * Fetch raw vault balances (base/quote). Used by the frontend before calling simulateSwap.
 */
export async function fetchVaultBalances(
  program: Program,
  poolState: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey
): Promise<{ baseAmount: bigint; quoteAmount: bigint }> {
  const [baseVault] = deriveVault(poolState, baseMint, program.programId);
  const [quoteVault] = deriveVault(poolState, quoteMint, program.programId);

  const conn = program.provider.connection;
  const [baseAcc, quoteAcc] = await Promise.all([
    conn.getTokenAccountBalance(baseVault),
    conn.getTokenAccountBalance(quoteVault),
  ]);
  return {
    baseAmount: BigInt(baseAcc.value.amount),
    quoteAmount: BigInt(quoteAcc.value.amount),
  };
}
