import type { Context } from "@hono/hono";

export function healthHandler(c: Context) {
  return c.text("ok");
}
