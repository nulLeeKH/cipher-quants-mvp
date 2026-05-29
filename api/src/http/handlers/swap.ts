import type { Context } from "@hono/hono";

import { dim, red, yellow } from "@std/fmt/colors";

import type { Metrics } from "../../metrics.ts";
import type { ApiRuntime } from "../../runtime.ts";
import { createSwap, type SwapMetric } from "../../services/swap_service.ts";
import type { SwapRequest } from "../contracts.ts";

const SLOW_WARN_MS = 250;

function recordSwapMetric(metrics: Metrics, metric: SwapMetric | undefined) {
  switch (metric) {
    case "clientFail":
      metrics.swapClientFail += 1;
      break;
    case "pausedReject":
      metrics.swapPausedReject += 1;
      break;
    case "expiredReject":
      metrics.swapExpiredReject += 1;
      break;
    case "curveFreshReject":
      metrics.swapCurveFreshReject += 1;
      break;
    case "driftReject":
      metrics.swapDriftReject += 1;
      break;
    case "inventoryReject":
      metrics.swapInventoryReject += 1;
      break;
    case "success":
      metrics.swapSuccess += 1;
      break;
    case undefined:
      break;
  }
}

export function swapHandler(runtime: ApiRuntime) {
  const swapDeps = {
    config: runtime.config,
    connection: runtime.connection,
    program: runtime.program,
    quoteSigner: runtime.quoteSigner,
    quoteStore: runtime.quoteStore,
    sdk: runtime.sdk,
    sdkAccounts: runtime.sdkAccounts,
    sdkInstructions: runtime.sdkInstructions,
  };

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
      const result = await createSwap(swapDeps, body);
      recordSwapMetric(runtime.metrics, result.metric);
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
