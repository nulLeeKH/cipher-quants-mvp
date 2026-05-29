import type { Context } from "@hono/hono";

import { computeFreshness } from "../../freshness.ts";
import type { ApiRuntime } from "../../runtime.ts";

export function freshnessHandler(runtime: ApiRuntime) {
  return async (c: Context) => {
    try {
      const { state: pool } = await runtime.sdkAccounts.fetchPoolState(
        runtime.program,
        runtime.config.baseMint!,
        runtime.config.quoteMint!,
      );
      const currentSlot = await runtime.connection.getSlot();
      return c.json(
        computeFreshness({
          lastOracleUpdateSlot: pool.lastOracleUpdateSlot.toNumber(),
          currentModeTtl: pool.currentModeTtl as number,
          paused: pool.paused,
          currentSlot,
        }),
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  };
}
