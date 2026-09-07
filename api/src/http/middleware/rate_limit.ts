import type { Context, Next } from "@hono/hono";

import type { SlidingWindowRateLimiter } from "../../rate_limit.ts";

export interface RateLimitMiddlewareOpts {
  rateLimiter: SlidingWindowRateLimiter;
  windowMs: number;
  quoteLimit: number;
  defaultLimit: number;
}

function getClientKey(
  c: { req: { header(name: string): string | undefined } },
): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

export function createRateLimitMiddleware(opts: RateLimitMiddlewareOpts) {
  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;
    if (path === "/health" || path === "/metrics") {
      await next();
      return;
    }
    const limit = path === "/quote" ? opts.quoteLimit : opts.defaultLimit;
    if (opts.rateLimiter.isLimited(getClientKey(c), limit)) {
      return c.json(
        { error: "Too Many Requests", limit, windowMs: opts.windowMs },
        429,
        { "Retry-After": "1" },
      );
    }
    await next();
  };
}
