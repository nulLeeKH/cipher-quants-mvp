import type { Context } from "@hono/hono";

import { dim, red, yellow } from "@std/fmt/colors";

import { recordLatency } from "../../metrics.ts";
import type { ApiRuntime } from "../../runtime.ts";
import { createQuote } from "../../services/quote_service.ts";
import type { QuoteRequest } from "../contracts.ts";

const SLOW_WARN_MS = 250;

export function quoteHandler(runtime: ApiRuntime) {
  return async (c: Context) => {
    const t0 = performance.now();
    runtime.metrics.quoteRequests += 1;
    let body: QuoteRequest;
    try {
      body = await c.req.json();
    } catch {
      runtime.metrics.quoteOtherFail += 1;
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    try {
      const result = await createQuote(runtime, body);
      const latencyMs = performance.now() - t0;

      if (result.metric === "inventory") {
        runtime.metrics.quoteInventoryFail += 1;
      }
      if (result.metric === "success") runtime.metrics.quoteSuccess += 1;
      if (result.recordLatency) recordLatency(runtime.metrics, latencyMs);

      if (result.status === 200 && result.log) {
        if (latencyMs > SLOW_WARN_MS) {
          console.warn(
            yellow(
              `  [/quote] slow: ${
                latencyMs.toFixed(1)
              }ms > ${SLOW_WARN_MS}ms (OPERATIONS §5.2 gate)`,
            ),
          );
        } else if (runtime.config.verbose) {
          console.log(
            dim(
              `  [/quote] dir=${result.log.direction} price=${result.log.price} out=${result.log.outAmount} nonce=${result.log.nonce} (${
                latencyMs.toFixed(1)
              }ms)`,
            ),
          );
        }
      }

      return c.json(result.body, result.status);
    } catch (err) {
      runtime.metrics.quoteOtherFail += 1;
      recordLatency(runtime.metrics, performance.now() - t0);
      console.error(red(`  [/quote] ${(err as Error).message}`));
      return c.json({ error: (err as Error).message }, 500);
    }
  };
}
