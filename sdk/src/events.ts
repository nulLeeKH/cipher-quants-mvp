import {
  AnchorProvider,
  BN,
  BorshCoder,
  EventParser,
  Program,
} from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";

import { Protocol } from "./idl/protocol.js";
import { IDL, PROGRAM_ID } from "./program.js";

// ============================================================================
// Event payload shapes — mirror of programs/protocol/src/events.rs
// ============================================================================
// Field names: snake_case → camelCase per Anchor IDL convention.
// u64 → BN, Pubkey → PublicKey, u8/u16/bool → number/boolean.
//
// Keep in sync with events.rs when adding fields. The discriminated union
// below uses these per-name types so consumers get autocomplete + type-checked
// field access instead of `any`.

export interface PoolInitializedData {
  pool: PublicKey;
  admin: PublicKey;
  oracleSigner: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  initialFairValue: BN;
  initialSpreadBps: number;
  initialModeTtl: number;
  slot: BN;
}

export interface OracleUpdatedData {
  pool: PublicKey;
  oracleSigner: PublicKey;
  newFairValue: BN;
  newSpreadBps: number;
  newNonce: BN;
  newTtl: number;
  slot: BN;
}

export interface SwapExecutedData {
  pool: PublicKey;
  user: PublicKey;
  /** 0 = Buy, 1 = Sell */
  direction: number;
  /** 0 = curve path, 1 = RFQ path */
  mode: number;
  inputAmount: BN;
  outputAmount: BN;
  executionPrice: BN;
  /** Nonzero only on the RFQ path; the curve path always emits 0. */
  quoteNonce: BN;
  slot: BN;
}

export interface PoolPausedChangedData {
  pool: PublicKey;
  admin: PublicKey;
  paused: boolean;
  slot: BN;
}

export interface OracleSignerRotatedData {
  pool: PublicKey;
  admin: PublicKey;
  previousSigner: PublicKey;
  newSigner: PublicKey;
  slot: BN;
}

export interface AdminRotatedData {
  pool: PublicKey;
  previousAdmin: PublicKey;
  newAdmin: PublicKey;
  slot: BN;
}

export interface InventoryWithdrawnData {
  pool: PublicKey;
  admin: PublicKey;
  baseAmount: BN;
  quoteAmount: BN;
  slot: BN;
}

export interface QuoteMarkerClosedData {
  pool: PublicKey;
  closer: PublicKey;
  nonce: BN;
  expirySlot: BN;
  slot: BN;
}

export interface ProtocolEventDataMap {
  PoolInitialized: PoolInitializedData;
  OracleUpdated: OracleUpdatedData;
  SwapExecuted: SwapExecutedData;
  PoolPausedChanged: PoolPausedChangedData;
  OracleSignerRotated: OracleSignerRotatedData;
  AdminRotated: AdminRotatedData;
  InventoryWithdrawn: InventoryWithdrawnData;
  QuoteMarkerClosed: QuoteMarkerClosedData;
}

export type ProtocolEventName = keyof ProtocolEventDataMap;

/**
 * Decoded event. When narrowed by `name`, `data` is inferred as the correct
 * payload type (no more `any`).
 *
 *   const ev: DecodedEvent = ...;
 *   if (ev.name === "SwapExecuted") {
 *     ev.data.executionPrice.toString(); // BN, type-checked
 *   }
 */
export type DecodedEvent =
  | { name: "PoolInitialized"; data: PoolInitializedData }
  | { name: "OracleUpdated"; data: OracleUpdatedData }
  | { name: "SwapExecuted"; data: SwapExecutedData }
  | { name: "PoolPausedChanged"; data: PoolPausedChangedData }
  | { name: "OracleSignerRotated"; data: OracleSignerRotatedData }
  | { name: "AdminRotated"; data: AdminRotatedData }
  | { name: "InventoryWithdrawn"; data: InventoryWithdrawnData }
  | { name: "QuoteMarkerClosed"; data: QuoteMarkerClosedData };

// ============================================================================
// Parse Anchor events from a confirmed transaction
// ============================================================================

/**
 * Fetch a confirmed transaction and parse all Anchor events from its logs.
 *
 * Usage:
 *   const events = await parseEventsFromTx(provider, signature);
 *   const swap = events.find(e => e.name === "SwapExecuted");
 */
export async function parseEventsFromTx(
  provider: AnchorProvider,
  signature: string
): Promise<DecodedEvent[]> {
  await provider.connection.confirmTransaction(signature, "confirmed");
  const tx = await provider.connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta?.logMessages) return [];
  return parseEventsFromLogs(tx.meta.logMessages);
}

/**
 * Parse events from raw log messages (e.g. WebSocket logsSubscribe payload).
 *
 * Unknown event names are dropped (forward-compat with newer program versions).
 */
export function parseEventsFromLogs(logs: string[]): DecodedEvent[] {
  const parser = new EventParser(PROGRAM_ID, new BorshCoder(IDL));
  const known = new Set<ProtocolEventName>([
    "PoolInitialized",
    "OracleUpdated",
    "SwapExecuted",
    "PoolPausedChanged",
    "OracleSignerRotated",
    "AdminRotated",
    "InventoryWithdrawn",
    "QuoteMarkerClosed",
  ]);
  const out: DecodedEvent[] = [];
  for (const ev of parser.parseLogs(logs)) {
    if (!known.has(ev.name as ProtocolEventName)) continue;
    // Anchor decodes into the same field shapes (camelCase) as our payload
    // interfaces — assert that here. Runtime shape comes from BorshCoder
    // applied to the IDL, which is generated from the on-chain types.
    out.push({ name: ev.name, data: ev.data } as DecodedEvent);
  }
  return out;
}

/**
 * Listener-based event subscription. Returns the listener ID for `removeEventListener`.
 * Callback `data` is typed to the matching event payload.
 */
export function subscribeEvent<TName extends ProtocolEventName>(
  program: Program<Protocol>,
  name: TName,
  callback: (
    data: ProtocolEventDataMap[TName],
    slot: number,
    signature: string
  ) => void
): number {
  // deno-lint-ignore no-explicit-any
  return program.addEventListener(name as any, callback as any);
}

export async function unsubscribeEvent(
  program: Program<Protocol>,
  listenerId: number
): Promise<void> {
  await program.removeEventListener(listenerId);
}
