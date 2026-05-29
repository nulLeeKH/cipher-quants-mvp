import type { Context } from "@hono/hono";

import { renderMetrics } from "../../metrics.ts";
import type { ApiRuntime } from "../../runtime.ts";

export function metricsHandler(runtime: ApiRuntime) {
  return (c: Context) => {
    const expected = runtime.config.metricsAuthToken;
    if (!expected) {
      return c.text(
        "/metrics is disabled (set METRICS_AUTH_TOKEN to enable)\n",
        503,
      );
    }
    const got = c.req.header("authorization") ?? "";
    const provided = got.startsWith("Bearer ")
      ? got.slice("Bearer ".length)
      : "";
    if (provided !== expected) {
      return c.text("unauthorized\n", 401);
    }
    return c.text(renderMetrics(runtime.metrics), 200, {
      "Content-Type": "text/plain; version=0.0.4",
    });
  };
}
