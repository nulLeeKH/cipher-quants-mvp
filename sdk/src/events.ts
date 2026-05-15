import {
  AnchorProvider,
  BorshCoder,
  EventParser,
  Program,
} from "@coral-xyz/anchor";

import { Protocol } from "./idl/protocol.js";
import { IDL, PROGRAM_ID } from "./program.js";

// ============================================================================
// Event names (PascalCase, taken directly from the IDL)
// ============================================================================
export type ProtocolEventName =
  | "PoolInitialized"
  | "OracleUpdated"
  | "SwapExecuted"
  | "PoolPausedChanged"
  | "OracleSignerRotated"
  | "AdminRotated"
  | "InventoryWithdrawn"
  | "QuoteMarkerClosed";

/** Decoded event with typed name + raw data (any-shaped since IDL → JS coercion). */
export interface DecodedEvent<TName extends ProtocolEventName = ProtocolEventName> {
  name: TName;
  data: any;
}

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
 */
export function parseEventsFromLogs(logs: string[]): DecodedEvent[] {
  const parser = new EventParser(PROGRAM_ID, new BorshCoder(IDL));
  const out: DecodedEvent[] = [];
  for (const ev of parser.parseLogs(logs)) {
    out.push({ name: ev.name as ProtocolEventName, data: ev.data });
  }
  return out;
}

/**
 * Listener-based event subscription. Returns the listener ID for `removeEventListener`.
 *
 * Usage:
 *   const id = program.addEventListener("SwapExecuted", (data, slot, sig) => {...});
 *   await program.removeEventListener(id);
 *
 * Note: thin wrapper around anchor.program.addEventListener (WebSocket-based).
 */
export function subscribeEvent<TName extends ProtocolEventName>(
  program: Program<Protocol>,
  name: TName,
  callback: (data: any, slot: number, signature: string) => void
): number {
  return program.addEventListener(name as any, callback);
}

export async function unsubscribeEvent(
  program: Program<Protocol>,
  listenerId: number
): Promise<void> {
  await program.removeEventListener(listenerId);
}
