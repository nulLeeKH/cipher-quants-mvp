import type { Context } from "@hono/hono";

import type { ApiRuntime } from "../../runtime.ts";

export function tokensHandler(runtime: ApiRuntime) {
  return (c: Context) =>
    c.json({
      tokens: [
        {
          address: runtime.config.baseMint!.toBase58(),
          symbol: runtime.config.baseSymbol,
          decimals: runtime.config.baseDecimals,
        },
        {
          address: runtime.config.quoteMint!.toBase58(),
          symbol: runtime.config.quoteSymbol,
          decimals: runtime.config.quoteDecimals,
        },
      ],
    });
}
