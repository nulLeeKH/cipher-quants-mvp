// ============================================================================
// Oracle worker shared state
// ============================================================================
// State shared between the oracle worker and the RFQ webhook *within the same
// process*. See docs/OPERATIONS.md §4.4 (single-writer nonce) and §5.3
// (webhook rejection policy).

import type { Keypair, PublicKey } from "@solana/web3.js";
import type { PriceTick } from "../sources/types.ts";

export type Mode = "A" | "B" | "C";

export interface PoolContext {
  poolState: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  /** PoolState.bump (CPI signer seed) */
  bump: number;
  /** Current admin (for rotation tracking) */
  admin: PublicKey;
}

export interface OracleSharedState {
  pool: PoolContext;
  /** Hot key used by the oracle worker; also used to sign RFQ quotes. */
  oracleSigner: Keypair;
  /** In-memory counter of the most recent nonce successfully pushed on-chain. */
  lastPushedNonce: bigint;
  /** Last fair_value pushed on-chain (referenced for RFQ price decisions). */
  lastPushedFairValue: bigint;
  /** Last spread pushed */
  lastPushedSpreadBps: number;
  /** Last TTL pushed (0=Mode C, 1=Mode A, 3=Mode B) */
  lastPushedTtl: number;
  /** Current mode */
  currentMode: Mode;
  /** Last successful push timestamp (ms) */
  lastPushAt: number;
  /** Latest price tick (for webhook quote synthesis) */
  latestTick: PriceTick;
  /** "About to enter Active" signal (ms epoch) — the webhook uses it to decide
   *  whether to reject quotes during a mode transition. */
  upgradeImminentUntil: number;
}

export function createOracleSharedState(
  pool: PoolContext,
  oracleSigner: Keypair,
  initialNonce: bigint,
  initialTick: PriceTick
): OracleSharedState {
  return {
    pool,
    oracleSigner,
    lastPushedNonce: initialNonce,
    lastPushedFairValue: initialTick.fairValue,
    lastPushedSpreadBps: 20, // default
    lastPushedTtl: 0,        // start in Mode C
    currentMode: "C",
    lastPushAt: 0,
    latestTick: initialTick,
    upgradeImminentUntil: 0,
  };
}
