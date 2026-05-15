import { PublicKey } from "@solana/web3.js";

const baseEnv = process.env.NEXT_PUBLIC_BASE_MINT;
const quoteEnv = process.env.NEXT_PUBLIC_QUOTE_MINT;

export interface PoolConfig {
  baseMint: PublicKey | null;
  quoteMint: PublicKey | null;
}

function tryPk(s: string | undefined): PublicKey | null {
  if (!s || s.length === 0) return null;
  try {
    return new PublicKey(s);
  } catch {
    return null;
  }
}

export const POOL_CONFIG: PoolConfig = {
  baseMint: tryPk(baseEnv),
  quoteMint: tryPk(quoteEnv),
};

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";
