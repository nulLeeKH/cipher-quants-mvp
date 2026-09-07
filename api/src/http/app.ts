import { Hono } from "@hono/hono";

import type { ApiRuntime } from "../runtime.ts";
import { createRateLimitMiddleware } from "./middleware/rate_limit.ts";
import { healthHandler } from "./handlers/health.ts";
import { metricsHandler } from "./handlers/metrics.ts";
import { tokensHandler } from "./handlers/tokens.ts";
import { freshnessHandler } from "./handlers/freshness.ts";
import { quoteHandler } from "./handlers/quote.ts";
import { swapHandler } from "./handlers/swap.ts";

const RATE_WINDOW_MS = 1_000;

export function createApiApp(runtime: ApiRuntime): Hono {
  const app = new Hono();
  const quoteLimit = Number(Deno.env.get("RATE_LIMIT_QUOTE_PER_SEC") ?? "30");
  const defaultLimit = Number(
    Deno.env.get("RATE_LIMIT_DEFAULT_PER_SEC") ?? "60",
  );

  app.use(
    "*",
    createRateLimitMiddleware({
      rateLimiter: runtime.rateLimiter,
      windowMs: RATE_WINDOW_MS,
      quoteLimit,
      defaultLimit,
    }),
  );

  app.get("/health", healthHandler);
  app.get("/metrics", metricsHandler(runtime));
  app.get("/tokens", tokensHandler(runtime));
  app.get("/freshness", freshnessHandler(runtime));
  app.post("/quote", quoteHandler(runtime));
  app.post("/swap", swapHandler(runtime));

  return app;
}
