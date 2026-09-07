import type { Context } from "@hono/hono";

import type { ApiRuntime } from "../../runtime.ts";
import { getFreshness } from "../../services/freshness_service.ts";

export function freshnessHandler(runtime: ApiRuntime) {
  const freshnessDeps = {
    connection: runtime.connection,
    program: runtime.program,
    sdkAccounts: runtime.sdkAccounts,
    baseMint: runtime.config.baseMint,
    quoteMint: runtime.config.quoteMint,
  };

  return async (c: Context) => {
    try {
      return c.json(await getFreshness(freshnessDeps));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  };
}
