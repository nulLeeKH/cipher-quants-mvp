import type { Context } from "@hono/hono";

import { dim, red, yellow } from "@std/fmt/colors";

import type { ApiRuntime } from "../../runtime.ts";
import { createSwap } from "../../services/swap_service.ts";
import type { SwapRequest } from "../contracts.ts";

const SLOW_WARN_MS = 250;

export function swapHandler(runtime: ApiRuntime) {
  return async (c: Context) => {
    const t0 = performance.now();
    runtime.metrics.swapRequests += 1;
    let body: SwapRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    try {
      const result = await createSwap(runtime, body);
      const latencyMs = performance.now() - t0;

      if (result.status === 200 && result.log) {
        if (latencyMs > SLOW_WARN_MS) {
          console.warn(
            yellow(
              `  [/swap] slow: ${
                latencyMs.toFixed(1)
              }ms > ${SLOW_WARN_MS}ms (OPERATIONS §5.2 gate)`,
            ),
          );
        } else if (runtime.config.verbose) {
          console.log(
            dim(
              `  [/swap] quoteId=${result.log.quoteId} signed (${
                latencyMs.toFixed(1)
              }ms)`,
            ),
          );
        }
      }

      return c.json(result.body, result.status);
    } catch (err) {
      console.error(red(`  [/swap] ${(err as Error).message}`));
      return c.json({ error: (err as Error).message }, 500);
    }
  };
}
