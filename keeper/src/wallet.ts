import { Keypair } from "@solana/web3.js";

// ============================================================================
// Keypair loading
// ============================================================================
// docs/OPERATIONS.md §13.2 — In the PoC we load secret keys from `.env` or a
// JSON file. When migrating to managed keys (Turnkey / AWS KMS Ed25519), add a
// KeypairProvider interface here.

export interface KeypairProvider {
  /** Returns a Solana web3 Keypair (Ed25519). */
  getKeypair(): Promise<Keypair>;
  /** Provider identifier (used in logs). */
  readonly label: string;
}

/**
 * Solana CLI `solana-keygen new --outfile keypair.json` format
 * secretKey JSON array).
 */
export class JsonFileKeypairProvider implements KeypairProvider {
  constructor(private path: string) {}
  readonly label = "json-file";

  async getKeypair(): Promise<Keypair> {
    const text = await Deno.readTextFile(this.path);
    const arr = JSON.parse(text);
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error(
        `Invalid keypair file at ${this.path}: expected 64-byte JSON array, got length ${arr?.length}`
      );
    }
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
}

/**
 * Synchronous helper for cases that already have access to the secret material
 * (e.g. test fixtures). Prefer JsonFileKeypairProvider in production.
 */
export function loadKeypairFromFileSync(path: string): Keypair {
  const text = Deno.readTextFileSync(path);
  const arr = JSON.parse(text);
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}
