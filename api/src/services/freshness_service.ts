import type { Connection, PublicKey } from "@solana/web3.js";

import { computeFreshness, type Freshness } from "../freshness.ts";

interface SlotLike {
  toNumber(): number;
}

interface PoolFreshnessState {
  lastOracleUpdateSlot: SlotLike;
  currentModeTtl: number;
  paused: boolean;
}

export interface FreshnessServiceDeps {
  connection: Pick<Connection, "getSlot">;
  program: unknown;
  sdkAccounts: {
    fetchPoolState(
      program: unknown,
      baseMint: PublicKey,
      quoteMint: PublicKey,
    ): Promise<{ state: PoolFreshnessState }>;
  };
  baseMint: PublicKey;
  quoteMint: PublicKey;
}

export async function getFreshness(
  deps: FreshnessServiceDeps,
): Promise<Freshness> {
  const { state: pool } = await deps.sdkAccounts.fetchPoolState(
    deps.program,
    deps.baseMint,
    deps.quoteMint,
  );
  const currentSlot = await deps.connection.getSlot();
  return computeFreshness({
    lastOracleUpdateSlot: pool.lastOracleUpdateSlot.toNumber(),
    currentModeTtl: pool.currentModeTtl,
    paused: pool.paused,
    currentSlot,
  });
}
