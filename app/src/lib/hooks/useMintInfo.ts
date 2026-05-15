"use client";

import * as React from "react";
import { PublicKey } from "@solana/web3.js";
import { getMint, type Mint } from "@solana/spl-token";
import { useConnection } from "@solana/wallet-adapter-react";

// Module-level cache: mint pubkey base58 → decimals. Mint decimals are
// immutable post-init, so we can cache aggressively. Other fields (supply,
// mintAuthority) refresh per call.
const decimalsCache = new Map<string, number>();

export interface MintInfo {
  mint: PublicKey;
  decimals: number;
}

export interface MintInfoState {
  base: MintInfo | null;
  quote: MintInfo | null;
  loading: boolean;
  error: string | null;
}

export function useMintInfo(
  base: PublicKey | null,
  quote: PublicKey | null
): MintInfoState {
  const { connection } = useConnection();
  const [state, setState] = React.useState<MintInfoState>({
    base: null,
    quote: null,
    loading: false,
    error: null,
  });

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!base && !quote) {
        setState({ base: null, quote: null, loading: false, error: null });
        return;
      }
      setState((s) => ({ ...s, loading: true, error: null }));

      async function loadOne(pk: PublicKey | null): Promise<MintInfo | null> {
        if (!pk) return null;
        const key = pk.toBase58();
        const cached = decimalsCache.get(key);
        if (cached !== undefined) return { mint: pk, decimals: cached };
        try {
          const info: Mint = await getMint(connection, pk);
          decimalsCache.set(key, info.decimals);
          return { mint: pk, decimals: info.decimals };
        } catch (e) {
          throw new Error(`Failed to fetch mint ${key}: ${(e as Error).message}`);
        }
      }

      try {
        const [b, q] = await Promise.all([loadOne(base), loadOne(quote)]);
        if (cancelled) return;
        setState({ base: b, quote: q, loading: false, error: null });
      } catch (e: any) {
        if (cancelled) return;
        setState({ base: null, quote: null, loading: false, error: e.message });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [connection, base?.toBase58(), quote?.toBase58()]);

  return state;
}
