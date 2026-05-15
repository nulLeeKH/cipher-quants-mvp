import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { Protocol } from "./idl/protocol.js";
import IDL_JSON from "./idl/protocol.json";

/**
 * IDL as a frozen object. Re-export for callers that need raw schema
 * (e.g. EventParser, custom decoders).
 */
export const IDL = IDL_JSON as unknown as Idl;

/**
 * Protocol program ID (from declare_id! in lib.rs, mirrored in IDL).
 */
export const PROGRAM_ID = new PublicKey(IDL_JSON.address);

/**
 * Re-export the typed Protocol interface so callers can write
 * `Program<Protocol>` without importing from the IDL directly.
 */
export type { Protocol };

/**
 * Build a typed Anchor Program instance.
 *
 * Usage:
 *   const provider = AnchorProvider.env();
 *   const program = createProgram(provider);
 *   await program.methods.initPool(...).accountsPartial({...}).rpc();
 */
export function createProgram(provider: AnchorProvider): Program<Protocol> {
  return new Program<Protocol>(IDL_JSON as unknown as Protocol, provider);
}
