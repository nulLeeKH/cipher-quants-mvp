// Pyth HTTP integration tests against an ephemeral local server. These hit
// `start()` end-to-end so the URL construction, headers, response handling,
// SSE framing, and abort-on-stop wiring are all exercised.
//
// Pure unit tests for the helpers live in pyth.test.ts.

import { assertEquals, assertExists } from "jsr:@std/assert@1";

import { PythPriceSource } from "./pyth.ts";

const FEED_ID =
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

function mockBody(price: string, expo = -8, conf = "1000000", publishTime = Math.floor(Date.now() / 1000)) {
  const field = { price, conf, expo, publish_time: publishTime };
  return {
    binary: { encoding: "hex", data: [] },
    parsed: [{ id: FEED_ID, price: field, ema_price: field }],
  };
}

async function withMockHermes(
  handler: (req: Request) => Response | Promise<Response>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  // Random port; Deno picks one for us when we use 0.
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, signal: ac.signal, onListen: () => {} }, handler);
  // @ts-expect-error: Deno.serve returns a server with addr accessible
  const addr = server.addr;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(baseUrl);
  } finally {
    ac.abort();
    await server.finished.catch(() => {});
  }
}

// ────────────────────────────────────────────────────────────────────────────
// REST polling transport
// ────────────────────────────────────────────────────────────────────────────

Deno.test("PythPriceSource POLL — initial fetch populates current()", async () => {
  let hits = 0;
  const handler = (req: Request) => {
    hits++;
    const url = new URL(req.url);
    // URL contract: /v2/updates/price/latest?ids[]=<feedId>
    assertEquals(url.pathname, "/v2/updates/price/latest");
    assertEquals(url.searchParams.getAll("ids[]")[0], FEED_ID);
    assertEquals(req.headers.get("accept"), "application/json");
    return Response.json(mockBody("10000000000")); // $100 at expo -8
  };

  await withMockHermes(handler, async (base) => {
    const src = new PythPriceSource({
      feedId: FEED_ID,
      baseDecimals: 6,
      quoteDecimals: 6,
      hermesUrl: base,
      transport: "poll",
      pollIntervalMs: 1_000_000, // effectively never polls after start
    });
    const stop = await src.start();
    try {
      const tick = await src.current();
      assertEquals(tick.fairValue, 100_000_000n); // $100 × 1e6
      assertEquals(tick.status, "fresh");
      assertEquals(hits, 1); // start() does exactly one initial fetch
    } finally {
      stop();
    }
  });
});

Deno.test("PythPriceSource POLL — periodic refresh updates current()", async () => {
  const prices = ["10000000000", "10100000000"]; // $100 → $101
  let i = 0;
  const handler = () => Response.json(mockBody(prices[Math.min(i++, prices.length - 1)]));

  await withMockHermes(handler, async (base) => {
    const src = new PythPriceSource({
      feedId: FEED_ID,
      baseDecimals: 6,
      quoteDecimals: 6,
      hermesUrl: base,
      transport: "poll",
      pollIntervalMs: 30,
    });
    const stop = await src.start();
    try {
      const first = await src.current();
      assertEquals(first.fairValue, 100_000_000n);
      // Wait long enough for at least one follow-up poll.
      await new Promise((r) => setTimeout(r, 120));
      const second = await src.current();
      assertEquals(second.fairValue, 101_000_000n);
    } finally {
      stop();
    }
  });
});

Deno.test("PythPriceSource POLL — propagates HTTP errors at boot", async () => {
  const handler = () => new Response("server fire", { status: 500 });
  await withMockHermes(handler, async (base) => {
    const src = new PythPriceSource({
      feedId: FEED_ID,
      baseDecimals: 6,
      quoteDecimals: 6,
      hermesUrl: base,
      transport: "poll",
    });
    let threw = false;
    try {
      await src.start();
    } catch (e) {
      threw = true;
      assertEquals((e as Error).message.includes("HTTP 500"), true);
    }
    assertEquals(threw, true, "start() must throw on initial fetch failure");
  });
});

Deno.test("PythPriceSource POLL — stop() halts further polling", async () => {
  let hits = 0;
  const handler = () => {
    hits++;
    return Response.json(mockBody("100"));
  };
  await withMockHermes(handler, async (base) => {
    const src = new PythPriceSource({
      feedId: FEED_ID,
      baseDecimals: 6,
      quoteDecimals: 6,
      hermesUrl: base,
      transport: "poll",
      pollIntervalMs: 20,
    });
    const stop = await src.start();
    await new Promise((r) => setTimeout(r, 70));
    const hitsAfterRun = hits;
    stop();
    await new Promise((r) => setTimeout(r, 80));
    // No new fetches should have arrived after stop().
    assertEquals(hits, hitsAfterRun);
  });
});

Deno.test("PythPriceSource POLL — stale publish_time flips status to 'stale' on read", async () => {
  // publish_time 5 minutes in the past, threshold 60 s.
  const stalePt = Math.floor(Date.now() / 1000) - 300;
  const handler = () => Response.json(mockBody("10000000000", -8, "1000000", stalePt));

  await withMockHermes(handler, async (base) => {
    const src = new PythPriceSource({
      feedId: FEED_ID,
      baseDecimals: 6,
      quoteDecimals: 6,
      hermesUrl: base,
      transport: "poll",
      pollIntervalMs: 1_000_000,
      maxStalenessSec: 60,
    });
    const stop = await src.start();
    try {
      const tick = await src.current();
      assertEquals(tick.status, "stale");
    } finally {
      stop();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SSE transport
// ────────────────────────────────────────────────────────────────────────────

function sseHandler(events: string[], opts?: { delayMs?: number; staleOpen?: boolean }) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/v2/updates/price/stream") {
      // Verify SSE Accept header.
      assertEquals(req.headers.get("accept"), "text/event-stream");
      assertEquals(url.searchParams.getAll("ids[]")[0], FEED_ID);
      const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          const enc = new TextEncoder();
          for (const ev of events) {
            ctrl.enqueue(enc.encode(`data: ${ev}\n\n`));
            if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
          }
          if (!opts?.staleOpen) ctrl.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    // The class does an initial REST fetch before opening SSE; mock that too.
    return Response.json(mockBody("10000000000"));
  };
}

Deno.test("PythPriceSource SSE — receives streamed price updates", async () => {
  const evt1 = JSON.stringify(mockBody("10000000000")); // $100
  const evt2 = JSON.stringify(mockBody("11000000000")); // $110
  const handler = sseHandler([evt1, evt2], { delayMs: 5, staleOpen: true });

  await withMockHermes(handler, async (base) => {
    const src = new PythPriceSource({
      feedId: FEED_ID,
      baseDecimals: 6,
      quoteDecimals: 6,
      hermesUrl: base,
      transport: "sse",
    });
    const stop = await src.start();
    try {
      // Allow the stream loop to drain both events.
      await new Promise((r) => setTimeout(r, 80));
      const tick = await src.current();
      // Last event was $110.
      assertEquals(tick.fairValue, 110_000_000n);
      assertEquals(tick.status, "fresh");
    } finally {
      stop();
    }
  });
});

Deno.test("PythPriceSource SSE — chunked events are reassembled across reads", async () => {
  // Split a single complete event across two writes.
  const full = JSON.stringify(mockBody("9876543210"));
  const half = `data: ${full.slice(0, 20)}`;
  const tail = `${full.slice(20)}\n\n`;
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/v2/updates/price/stream") {
      const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          const enc = new TextEncoder();
          ctrl.enqueue(enc.encode(half));
          await new Promise((r) => setTimeout(r, 10));
          ctrl.enqueue(enc.encode(tail));
          ctrl.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json(mockBody("100"));
  };

  await withMockHermes(handler, async (base) => {
    const src = new PythPriceSource({
      feedId: FEED_ID,
      baseDecimals: 6,
      quoteDecimals: 6,
      hermesUrl: base,
      transport: "sse",
    });
    const stop = await src.start();
    try {
      await new Promise((r) => setTimeout(r, 100));
      const tick = await src.current();
      // 9876543210 × 10^(-8+6-6+6) = 9876543210 × 10^-2 = 98765432 (floor)
      assertEquals(tick.fairValue, 98_765_432n);
    } finally {
      stop();
    }
  });
});

Deno.test("PythPriceSource SSE — reconnects after server closes the stream", async () => {
  let connects = 0;
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/v2/updates/price/stream") {
      connects++;
      // Send one event then close immediately to force a reconnect.
      const evt = JSON.stringify(mockBody(connects === 1 ? "100" : "200"));
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode(`data: ${evt}\n\n`));
          ctrl.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json(mockBody("0"));
  };

  await withMockHermes(handler, async (base) => {
    const src = new PythPriceSource({
      feedId: FEED_ID,
      baseDecimals: 6,
      quoteDecimals: 6,
      hermesUrl: base,
      transport: "sse",
    });
    const stop = await src.start();
    try {
      // 500ms backoff after the first disconnect → wait > 600ms for reconnect.
      await new Promise((r) => setTimeout(r, 800));
      assertEquals(connects >= 2, true, `expected ≥2 connects, got ${connects}`);
    } finally {
      stop();
    }
  });
});

Deno.test("PythPriceSource SSE — stop() during streaming exits the loop cleanly", async () => {
  const handler = sseHandler([JSON.stringify(mockBody("100"))], {
    delayMs: 0,
    staleOpen: true, // server keeps connection open forever
  });
  await withMockHermes(handler, async (base) => {
    const src = new PythPriceSource({
      feedId: FEED_ID,
      baseDecimals: 6,
      quoteDecimals: 6,
      hermesUrl: base,
      transport: "sse",
    });
    const stop = await src.start();
    await new Promise((r) => setTimeout(r, 50));
    stop();
    // Give the loop a beat to actually unwind; no leak should remain that
    // keeps the test from terminating.
    await new Promise((r) => setTimeout(r, 50));
    const tick = await src.current();
    assertExists(tick);
  });
});
