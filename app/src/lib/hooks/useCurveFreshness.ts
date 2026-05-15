"use client";

import * as React from "react";
import { useConnection } from "@solana/wallet-adapter-react";

export interface FreshnessState {
  currentSlot: number | null;
  ageSlots: number | null;
  isFresh: boolean;
  ttl: number;
}

export function useCurveFreshness(
  lastOracleSlot: bigint | null,
  ttlSlots: number,
  pollMs: number = 1_500
): FreshnessState {
  const { connection } = useConnection();
  const [currentSlot, setCurrentSlot] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await connection.getSlot("confirmed");
        if (!cancelled) setCurrentSlot(s);
      } catch {
        /* ignore transient */
      }
    };
    void tick();
    const id = window.setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connection, pollMs]);

  const ageSlots =
    currentSlot != null && lastOracleSlot != null
      ? currentSlot - Number(lastOracleSlot)
      : null;
  const isFresh = ttlSlots > 0 && ageSlots != null && ageSlots <= ttlSlots;

  return { currentSlot, ageSlots, isFresh, ttl: ttlSlots };
}
