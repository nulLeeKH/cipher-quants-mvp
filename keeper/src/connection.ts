import { Commitment, Connection } from "@solana/web3.js";

// ============================================================================
// RPC adapter abstraction
// ============================================================================
// docs/OPERATIONS.md §13.1 — A thin abstraction so the provider can be
// swapped at any time. PoC v0 uses Helius Developer RPC; in production we
// expect to switch between Helius Sender (Jito bundle), dedicated Triton, etc.

export interface RpcAdapter {
  /** Read/write connection for instructions */
  readonly connection: Connection;
  /** WebSocket connection for subscriptions (optional, falls back to HTTP polling) */
  readonly wsUrl?: string;
  /** Provider label for logging/metrics */
  readonly provider: string;
}

export function createRpcAdapter(opts: {
  rpcUrl: string;
  wsUrl?: string;
  provider: string;
  commitment?: Commitment;
}): RpcAdapter {
  const connection = new Connection(opts.rpcUrl, {
    commitment: opts.commitment ?? "confirmed",
    wsEndpoint: opts.wsUrl,
  });
  return {
    connection,
    wsUrl: opts.wsUrl,
    provider: opts.provider,
  };
}
