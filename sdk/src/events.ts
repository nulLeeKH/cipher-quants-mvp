// ============================================================================
// Event log decoder
// ============================================================================
// Mirrors programs/protocol/src/events.rs. The Pinocchio-era program emits
// each event as one log line of the form
//
//   Program log: EVT:<base64>
//
// where the base64 payload is `[1-byte tag][Borsh body]`. We strip the
// `Program log: ` runtime prefix, the `EVT:` marker, decode base64, peel
// the tag, and Borsh-deserialize the remainder into the matching struct.

import type { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import { Reader } from "./borsh.js";
import { PROGRAM_ID, type AnchorProvider } from "./program.js";

// ----------------------------------------------------------------------------
// Event payload shapes (1:1 with programs/protocol/src/events.rs)
// ----------------------------------------------------------------------------

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

export interface AdminProposalCreatedData {
  pool: PublicKey;
  proposedBy: PublicKey;
  newAdmin: PublicKey;
  slot: BN;
}

export interface AdminProposalCancelledData {
  pool: PublicKey;
  admin: PublicKey;
  cancelledNewAdmin: PublicKey;
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
  AdminProposalCreated: AdminProposalCreatedData;
  AdminProposalCancelled: AdminProposalCancelledData;
}

export type ProtocolEventName = keyof ProtocolEventDataMap;

export type DecodedEvent = {
  [K in ProtocolEventName]: { name: K; data: ProtocolEventDataMap[K] };
}[ProtocolEventName];

// ----------------------------------------------------------------------------
// Base64 decoder (RFC 4648 alphabet, accepts padded and unpadded inputs)
// ----------------------------------------------------------------------------

const BASE64_TABLE: Int8Array = (() => {
  const t = new Int8Array(256).fill(-1);
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < a.length; i++) t[a.charCodeAt(i)] = i;
  // also accept URL-safe variants
  t["-".charCodeAt(0)] = 62;
  t["_".charCodeAt(0)] = 63;
  return t;
})();

function base64Decode(s: string): Uint8Array | null {
  // Drop padding.
  while (s.endsWith("=")) s = s.slice(0, -1);
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let oi = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = BASE64_TABLE[s.charCodeAt(i)];
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[oi++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, oi);
}

// ----------------------------------------------------------------------------
// Per-event decoders
// ----------------------------------------------------------------------------

const TAG_POOL_INITIALIZED = 0x01;
const TAG_ORACLE_UPDATED = 0x02;
const TAG_SWAP_EXECUTED = 0x03;
const TAG_POOL_PAUSED_CHANGED = 0x04;
const TAG_ORACLE_SIGNER_ROTATED = 0x05;
const TAG_ADMIN_ROTATED = 0x06;
const TAG_INVENTORY_WITHDRAWN = 0x07;
const TAG_QUOTE_MARKER_CLOSED = 0x08;
const TAG_ADMIN_PROPOSAL_CREATED = 0x09;
const TAG_ADMIN_PROPOSAL_CANCELLED = 0x0a;

function decodeBody(tag: number, body: Uint8Array): DecodedEvent | null {
  const r = new Reader(body);
  try {
    switch (tag) {
      case TAG_POOL_INITIALIZED:
        return {
          name: "PoolInitialized",
          data: {
            pool: r.pubkey(),
            admin: r.pubkey(),
            oracleSigner: r.pubkey(),
            baseMint: r.pubkey(),
            quoteMint: r.pubkey(),
            initialFairValue: r.u64(),
            initialSpreadBps: r.u16(),
            initialModeTtl: r.u8(),
            slot: r.u64(),
          },
        };
      case TAG_ORACLE_UPDATED:
        return {
          name: "OracleUpdated",
          data: {
            pool: r.pubkey(),
            oracleSigner: r.pubkey(),
            newFairValue: r.u64(),
            newSpreadBps: r.u16(),
            newNonce: r.u64(),
            newTtl: r.u8(),
            slot: r.u64(),
          },
        };
      case TAG_SWAP_EXECUTED:
        return {
          name: "SwapExecuted",
          data: {
            pool: r.pubkey(),
            user: r.pubkey(),
            direction: r.u8(),
            mode: r.u8(),
            inputAmount: r.u64(),
            outputAmount: r.u64(),
            executionPrice: r.u64(),
            quoteNonce: r.u64(),
            slot: r.u64(),
          },
        };
      case TAG_POOL_PAUSED_CHANGED:
        return {
          name: "PoolPausedChanged",
          data: {
            pool: r.pubkey(),
            admin: r.pubkey(),
            paused: r.u8() !== 0,
            slot: r.u64(),
          },
        };
      case TAG_ORACLE_SIGNER_ROTATED:
        return {
          name: "OracleSignerRotated",
          data: {
            pool: r.pubkey(),
            admin: r.pubkey(),
            previousSigner: r.pubkey(),
            newSigner: r.pubkey(),
            slot: r.u64(),
          },
        };
      case TAG_ADMIN_ROTATED:
        return {
          name: "AdminRotated",
          data: {
            pool: r.pubkey(),
            previousAdmin: r.pubkey(),
            newAdmin: r.pubkey(),
            slot: r.u64(),
          },
        };
      case TAG_INVENTORY_WITHDRAWN:
        return {
          name: "InventoryWithdrawn",
          data: {
            pool: r.pubkey(),
            admin: r.pubkey(),
            baseAmount: r.u64(),
            quoteAmount: r.u64(),
            slot: r.u64(),
          },
        };
      case TAG_QUOTE_MARKER_CLOSED:
        return {
          name: "QuoteMarkerClosed",
          data: {
            pool: r.pubkey(),
            closer: r.pubkey(),
            nonce: r.u64(),
            expirySlot: r.u64(),
            slot: r.u64(),
          },
        };
      case TAG_ADMIN_PROPOSAL_CREATED:
        return {
          name: "AdminProposalCreated",
          data: {
            pool: r.pubkey(),
            proposedBy: r.pubkey(),
            newAdmin: r.pubkey(),
            slot: r.u64(),
          },
        };
      case TAG_ADMIN_PROPOSAL_CANCELLED:
        return {
          name: "AdminProposalCancelled",
          data: {
            pool: r.pubkey(),
            admin: r.pubkey(),
            cancelledNewAdmin: r.pubkey(),
            slot: r.u64(),
          },
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Decode a single log line into a DecodedEvent. Returns `null` for any line
 * that is not an event (or whose tag is unknown).
 */
export function decodeEventLog(rawLine: string): DecodedEvent | null {
  let line = rawLine;
  if (line.startsWith("Program log: ")) line = line.slice("Program log: ".length);
  else if (line.startsWith("Program data: ")) line = line.slice("Program data: ".length);
  if (!line.startsWith("EVT:")) return null;
  const encoded = line.slice("EVT:".length).trim();
  const payload = base64Decode(encoded);
  if (!payload || payload.length < 1) return null;
  const tag = payload[0];
  return decodeBody(tag, payload.subarray(1));
}

// ----------------------------------------------------------------------------
// Convenience: walk an entire transaction's logs
// ----------------------------------------------------------------------------

export function parseEventsFromLogs(logs: string[]): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const l of logs) {
    const ev = decodeEventLog(l);
    if (ev) out.push(ev);
  }
  return out;
}

/**
 * Fetch a confirmed transaction and parse all events from its logs. Accepts
 * either a connection or an AnchorProvider (back-compat with Anchor-era).
 */
export async function parseEventsFromTx(
  source: Connection | AnchorProvider,
  signature: string
): Promise<DecodedEvent[]> {
  const connection: Connection =
    "connection" in source ? (source as AnchorProvider).connection : source;
  await connection.confirmTransaction(signature, "confirmed");
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta?.logMessages) return [];
  return parseEventsFromLogs(tx.meta.logMessages);
}

/** Subscribe to a specific event type. Returns the listener id. */
export function subscribeEvent<TName extends ProtocolEventName>(
  target: {
    addEventListener: (
      name: TName,
      cb: (data: unknown, slot: number, sig: string) => void
    ) => number;
    removeEventListener: (id: number) => Promise<void>;
  },
  name: TName,
  callback: (
    data: ProtocolEventDataMap[TName],
    slot: number,
    signature: string
  ) => void
): number {
  return target.addEventListener(name, (data, slot, sig) =>
    callback(data as ProtocolEventDataMap[TName], slot, sig)
  );
}

export async function unsubscribeEvent(
  target: { removeEventListener: (id: number) => Promise<void> },
  listenerId: number
): Promise<void> {
  await target.removeEventListener(listenerId);
}

export { PROGRAM_ID };
