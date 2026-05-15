"use client";

import * as React from "react";
import { PublicKey } from "@solana/web3.js";
import {
  fetchPoolState,
  derivePoolState,
  type PoolStateView,
} from "@solana-boilerplate/sdk";

import { useProgram } from "@/components/providers/program";

export interface PoolStateResult {
  loading: boolean;
  error: string | null;
  pool: PoolStateView | null;
  poolAddress: PublicKey | null;
  refresh: () => Promise<void>;
}

export function usePoolState(
  baseMint: PublicKey | null,
  quoteMint: PublicKey | null,
  pollIntervalMs: number = 4_000
): PoolStateResult {
  const { readonlyProgram } = useProgram();
  const [pool, setPool] = React.useState<PoolStateView | null>(null);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);

  const poolAddress = React.useMemo<PublicKey | null>(() => {
    if (!baseMint || !quoteMint) return null;
    const [addr] = derivePoolState(baseMint, quoteMint, readonlyProgram.programId);
    return addr;
  }, [baseMint, quoteMint, readonlyProgram.programId]);

  const refresh = React.useCallback(async () => {
    if (!baseMint || !quoteMint) {
      setPool(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const view = await fetchPoolState(readonlyProgram, baseMint, quoteMint);
      setPool(view);
    } catch (e: any) {
      setError(e?.message ?? "Failed to fetch pool state");
      setPool(null);
    } finally {
      setLoading(false);
    }
  }, [readonlyProgram, baseMint, quoteMint]);

  React.useEffect(() => {
    void refresh();
    if (pollIntervalMs <= 0) return;
    const id = window.setInterval(() => {
      void refresh();
    }, pollIntervalMs);
    return () => window.clearInterval(id);
  }, [refresh, pollIntervalMs]);

  return { loading, error, pool, poolAddress, refresh };
}
