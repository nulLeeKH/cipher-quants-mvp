// ============================================================================
// RFQ webhook server (JupiterZ-compatible)
// ============================================================================
// docs/OPERATIONS.md §5 — /quote /swap /tokens.
//
// Responsibilities:
//   - Runs 24/7 (especially responsible for RFQ responses during Mode C).
//   - Reads on-chain `pool_state` (fair_value, spread, depth, skew, paused, ttl).
//   - Returns ed25519-signed quotes for user quote requests.
//   - Handles requests from the frontend and the Jupiter router.
//
// Separation from the keeper:
//   - Keeper = oracle push (write to chain)
//   - API server = quote response (read chain + sign)
//   - Both currently hold the oracle hot key (future split: dedicated quote_signer).

import { Buffer } from "node:buffer";
import { Hono } from "@hono/hono";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";
import { bold, cyan, dim, red, yellow } from "@std/fmt/colors";

import type { ApiConfig } from "./config.ts";

// ============================================================================
// Lightweight in-memory metrics (Stage 2: replace with Prometheus exporter)
// ============================================================================
// OPERATIONS §5.2 — RFQ webhook p95 ≤ 250ms is a Stage 2 → 3 entry gate. Without
// measurement we can't verify the gate. Ring buffer of 1024 samples tracks
// p50/p95/p99; memory footprint < 64KB.

const LATENCY_RING_SIZE = 1024;
const SLOW_WARN_MS = 250;

interface Metrics {
  quoteRequests: number;
  quoteSuccess: number;
  quoteInventoryFail: number;
  quoteOtherFail: number;
  swapRequests: number;
  latenciesMs: number[]; // ring buffer
  latencyIdx: number;
}

function newMetrics(): Metrics {
  return {
    quoteRequests: 0,
    quoteSuccess: 0,
    quoteInventoryFail: 0,
    quoteOtherFail: 0,
    swapRequests: 0,
    latenciesMs: [],
    latencyIdx: 0,
  };
}

function recordLatency(m: Metrics, ms: number): void {
  if (m.latenciesMs.length < LATENCY_RING_SIZE) {
    m.latenciesMs.push(ms);
  } else {
    m.latenciesMs[m.latencyIdx] = ms;
    m.latencyIdx = (m.latencyIdx + 1) % LATENCY_RING_SIZE;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function renderMetrics(m: Metrics): string {
  const sorted = [...m.latenciesMs].sort((a, b) => a - b);
  const lines = [
    `# HELP cipher_quote_requests_total Total /quote requests`,
    `# TYPE cipher_quote_requests_total counter`,
    `cipher_quote_requests_total ${m.quoteRequests}`,
    `cipher_quote_success_total ${m.quoteSuccess}`,
    `cipher_quote_inventory_fail_total ${m.quoteInventoryFail}`,
    `cipher_quote_other_fail_total ${m.quoteOtherFail}`,
    `cipher_swap_requests_total ${m.swapRequests}`,
    `# HELP cipher_quote_latency_ms /quote latency percentiles`,
    `# TYPE cipher_quote_latency_ms summary`,
    `cipher_quote_latency_ms{quantile="0.5"} ${percentile(sorted, 50)}`,
    `cipher_quote_latency_ms{quantile="0.95"} ${percentile(sorted, 95)}`,
    `cipher_quote_latency_ms{quantile="0.99"} ${percentile(sorted, 99)}`,
    `cipher_quote_latency_samples ${sorted.length}`,
    ``,
  ];
  return lines.join("\n");
}

// Load SDK via CommonJS require to bypass Deno's strict ESM resolution.
// The SDK now ships its own AnchorProvider / Wallet shim built on the
// Pinocchio dispatch — no @coral-xyz/anchor runtime dep anymore.
const require = createRequire(import.meta.url);
// deno-lint-ignore no-explicit-any
const sdk: any = require("../../sdk/dist/index.js");
// deno-lint-ignore no-explicit-any
const sdkAccounts: any = require("../../sdk/dist/accounts/index.js");
const { AnchorProvider, Wallet } = sdk;

// ============================================================================
// Request / Response schemas (JupiterZ-compatible simple v0)
// ============================================================================
// Align with the full JupiterZ spec at Stage 2 entry; verify via the
// jup-ag/rfq-webhook-toolkit integration tests at that point.

interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  userPubkey: string;
}

interface QuoteResponse {
  quoteId: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  expirySlot: number;
  signedQuote: any;
  verifyIxBase64: string;
  quoteNonceMarker: string;
}

interface SwapRequest {
  quoteId: string;
  userPubkey: string;
}

// ============================================================================

export interface ApiServerHandle {
  stop(): Promise<void>;
}

export async function startApiServer(
  config: ApiConfig
): Promise<ApiServerHandle> {
  if (!config.baseMint || !config.quoteMint) {
    console.error(red("BASE_MINT and QUOTE_MINT env vars required"));
    Deno.exit(1);
  }

  // Load quote signer keypair
  const text = await Deno.readTextFile(config.quoteSignerWalletPath);
  const secretArr = JSON.parse(text);
  const quoteSigner = Keypair.fromSecretKey(Uint8Array.from(secretArr));
  console.log(
    dim(`  Quote signer:  ${quoteSigner.publicKey.toBase58()} (loaded)`)
  );

  // Anchor provider + SDK program
  const connection = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: config.rpcWsUrl,
  });
  const wallet = new Wallet(quoteSigner);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = sdk.createProgram(provider);
  const programId = config.programIdOverride ?? sdk.PROGRAM_ID;

  console.log(dim(`  Program:       ${programId.toBase58()}`));
  console.log(dim(`  Base mint:     ${config.baseMint.toBase58()}`));
  console.log(dim(`  Quote mint:    ${config.quoteMint.toBase58()}`));

  // ──────────────────────────────────────────────────────────────────────
  // Quote cache (in-memory). Replace with Redis or a dedicated store at Stage 2.
  //
  // Bounded by both size (LRU-style) and TTL — without these, a long-running
  // process leaks ~432MB/day at 10qps. Eviction happens lazily on every set,
  // plus a periodic sweep clears anything stale even if traffic stops.
  const QUOTE_CACHE_MAX_ENTRIES = 10_000;
  const QUOTE_CACHE_TTL_MS = 5 * 60_000; // 5 min — well past any quoteValidWindowSlots * 400ms
  interface CachedQuote { resp: QuoteResponse; expiresAtMs: number }
  const quoteCache = new Map<string, CachedQuote>();
  function cacheSet(key: string, resp: QuoteResponse): void {
    const expiresAtMs = Date.now() + QUOTE_CACHE_TTL_MS;
    // LRU semantics: deletion + re-insert places the entry at the tail.
    quoteCache.delete(key);
    quoteCache.set(key, { resp, expiresAtMs });
    // Evict from the front while over capacity (Map iteration order = insertion).
    while (quoteCache.size > QUOTE_CACHE_MAX_ENTRIES) {
      const oldest = quoteCache.keys().next().value;
      if (oldest === undefined) break;
      quoteCache.delete(oldest);
    }
  }
  function cacheGet(key: string): QuoteResponse | undefined {
    const entry = quoteCache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs < Date.now()) {
      quoteCache.delete(key);
      return undefined;
    }
    return entry.resp;
  }
  // Background sweep — runs every minute and drops expired entries even when
  // traffic is idle. Cleared on server shutdown.
  const cacheSweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of quoteCache) {
      if (v.expiresAtMs < now) quoteCache.delete(k);
    }
  }, 60_000);

  const metrics = newMetrics();

  // ──────────────────────────────────────────────────────────────────────
  // Per-IP rate limiter (sliding window, in-memory).
  // ──────────────────────────────────────────────────────────────────────
  // Protects the RPC backend from a single client hammering /quote (which
  // calls fetchPoolState + fetchVaultBalances). At Stage 2 swap to Redis or
  // an upstream limit at the reverse proxy.
  //
  // Window = 1s. Default cap = 30 req/s per IP for /quote, 60 for everything
  // else. Both are env-tunable.
  const RATE_WINDOW_MS = 1_000;
  const RATE_LIMIT_QUOTE = Number(Deno.env.get("RATE_LIMIT_QUOTE_PER_SEC") ?? "30");
  const RATE_LIMIT_DEFAULT = Number(Deno.env.get("RATE_LIMIT_DEFAULT_PER_SEC") ?? "60");
  interface RateState { hits: number[]; }
  const rateBuckets = new Map<string, RateState>();
  function getClientKey(c: { req: { header(name: string): string | undefined } }): string {
    return (
      c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
      c.req.header("x-real-ip") ||
      "unknown"
    );
  }
  function isLimited(key: string, limit: number): boolean {
    const now = Date.now();
    const state = rateBuckets.get(key) ?? { hits: [] };
    // Drop stale hits (sliding window)
    while (state.hits.length > 0 && state.hits[0] < now - RATE_WINDOW_MS) {
      state.hits.shift();
    }
    if (state.hits.length >= limit) {
      rateBuckets.set(key, state);
      return true;
    }
    state.hits.push(now);
    rateBuckets.set(key, state);
    return false;
  }
  // Periodic cleanup so the Map doesn't grow unbounded with one-shot IPs.
  const rateSweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateBuckets) {
      const fresh = v.hits.filter((t) => t >= now - RATE_WINDOW_MS);
      if (fresh.length === 0) rateBuckets.delete(k);
      else rateBuckets.set(k, { hits: fresh });
    }
  }, 60_000);

  // Nonce generation: 8-byte crypto random. Date.now+Math.random can collide
  // within the same millisecond, which would cause legitimate quotes to be
  // rejected by the PDA seed marker; the low entropy is also attacker-
  // predictable. On-chain replay defense lives in quote_nonce_marker, but
  // uniqueness at issuance must be guaranteed independently.
  function nextQuoteNonce(): bigint {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    return new DataView(buf.buffer).getBigUint64(0, true /* LE: matches the on-chain seed byte order */);
  }

  const app = new Hono();

  // Rate-limit middleware. /health is exempt (so external healthcheckers don't
  // get throttled). /metrics is already auth-gated.
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === "/health" || path === "/metrics") return next();
    const limit = path === "/quote" ? RATE_LIMIT_QUOTE : RATE_LIMIT_DEFAULT;
    if (isLimited(getClientKey(c), limit)) {
      return c.json(
        { error: "Too Many Requests", limit, windowMs: RATE_WINDOW_MS },
        429,
        { "Retry-After": "1" }
      );
    }
    return next();
  });

  app.get("/health", (c) => c.text("ok"));

  // /metrics is fail-closed: requires METRICS_AUTH_TOKEN to be configured AND
  // a matching `Authorization: Bearer <token>` header on the request. Counters
  // / latency percentiles can reveal traffic shape + inventory state, so we
  // refuse to leak them publicly.
  app.get("/metrics", (c) => {
    const expected = config.metricsAuthToken;
    if (!expected) {
      return c.text(
        "/metrics is disabled (set METRICS_AUTH_TOKEN to enable)\n",
        503
      );
    }
    const got = c.req.header("authorization") ?? "";
    const provided = got.startsWith("Bearer ") ? got.slice("Bearer ".length) : "";
    if (provided !== expected) {
      return c.text("unauthorized\n", 401);
    }
    return c.text(renderMetrics(metrics), 200, {
      "Content-Type": "text/plain; version=0.0.4",
    });
  });

  app.get("/tokens", (c) =>
    c.json({
      tokens: [
        { mint: config.baseMint!.toBase58(), name: "base", decimals: 6 },
        { mint: config.quoteMint!.toBase58(), name: "quote", decimals: 6 },
      ],
    })
  );

  app.post("/quote", async (c) => {
    const t0 = performance.now();
    metrics.quoteRequests += 1;
    let body: QuoteRequest;
    try {
      body = await c.req.json();
    } catch {
      metrics.quoteOtherFail += 1;
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    try {
      const inputMint = new PublicKey(body.inputMint);
      const outputMint = new PublicKey(body.outputMint);
      const userPk = new PublicKey(body.userPubkey);
      const inAmount = BigInt(body.inAmount);
      if (inAmount <= 0n) return c.json({ error: "inAmount must be > 0" }, 400);

      const direction = sdk.directionFromMints(
        inputMint,
        outputMint,
        config.baseMint!,
        config.quoteMint!
      ) as "buy" | "sell";

      // Read on-chain pool state (24/7 fresh)
      const { address: poolAddr, state: pool } = await sdkAccounts.fetchPoolState(
        program,
        config.baseMint!,
        config.quoteMint!
      );

      if (pool.paused) {
        return c.json({ error: "Pool is paused" }, 503);
      }

      // OPERATIONS §3.1: when the curve is fresh, the quote is ignored on-chain,
      // so it's more efficient for the API server to *reject* during that window
      // (the user trades directly via the curve path instead).
      const currentSlot = await connection.getSlot();
      const curveAge = currentSlot - pool.lastOracleUpdateSlot.toNumber();
      const curveFresh = pool.currentModeTtl > 0 && curveAge <= pool.currentModeTtl;
      if (curveFresh) {
        return c.json(
          {
            error:
              "Curve is fresh — use direct execute_swap (curve path) instead",
          },
          404
        );
      }

      // Quote price = fair_value × spread (simple v0; depth/skew come in v1).
      const fairValue = BigInt(pool.fairValue.toString());
      const halfBps = BigInt(Math.floor(pool.spreadBps / 2));
      const price =
        direction === "buy"
          ? (fairValue * (10_000n + halfBps)) / 10_000n
          : (fairValue * (10_000n - halfBps)) / 10_000n;
      const PRICE_SCALE = sdk.PRICE_SCALE as bigint;
      const outAmount =
        direction === "buy"
          ? (inAmount * PRICE_SCALE) / price
          : (inAmount * price) / PRICE_SCALE;

      // Inventory check — the vault must hold enough of the output token to
      // satisfy outAmount. Without this, the user's tx would fail on-chain with
      // InsufficientReserves (user pays fee + burns nonce); pre-rejecting here
      // protects the fill-rate SLA.
      const balances = await sdkAccounts.fetchVaultBalances(
        program,
        poolAddr,
        config.baseMint!,
        config.quoteMint!
      );
      const availableOut =
        direction === "buy" ? balances.baseAmount : balances.quoteAmount;
      if (availableOut < outAmount) {
        metrics.quoteInventoryFail += 1;
        recordLatency(metrics, performance.now() - t0);
        return c.json(
          {
            error: "Insufficient inventory",
            requested: outAmount.toString(),
            available: availableOut.toString(),
            side: direction === "buy" ? "base" : "quote",
          },
          503
        );
      }

      // Build signed quote
      const expirySlot = BigInt(currentSlot + config.quoteValidWindowSlots);
      const nonce = nextQuoteNonce();
      const built = sdk.buildSignedQuoteWithVerifyIx(quoteSigner, {
        pool: poolAddr,
        user: userPk,
        direction,
        inputAmount: inAmount,
        price,
        expirySlot,
        nonce,
      });

      const [marker] = sdkAccounts.deriveQuoteNonceMarker(
        poolAddr,
        nonce,
        program.programId
      );

      const quoteId = nonce.toString();
      const resp: QuoteResponse = {
        quoteId,
        inputMint: body.inputMint,
        outputMint: body.outputMint,
        inAmount: inAmount.toString(),
        outAmount: outAmount.toString(),
        expirySlot: Number(expirySlot),
        signedQuote: {
          pool: built.signedQuote.pool.toBase58(),
          user: built.signedQuote.user.toBase58(),
          direction: built.signedQuote.direction,
          inputAmount: built.signedQuote.inputAmount.toString(),
          price: built.signedQuote.price.toString(),
          expirySlot: built.signedQuote.expirySlot.toString(),
          nonce: built.signedQuote.nonce.toString(),
          signature: built.signedQuote.signature,
        },
        verifyIxBase64: Buffer.from(built.verifyIx.data).toString("base64"),
        quoteNonceMarker: marker.toBase58(),
      };
      cacheSet(quoteId, resp);

      metrics.quoteSuccess += 1;
      const latencyMs = performance.now() - t0;
      recordLatency(metrics, latencyMs);
      if (latencyMs > SLOW_WARN_MS) {
        console.warn(
          yellow(
            `  [/quote] slow: ${latencyMs.toFixed(1)}ms > ${SLOW_WARN_MS}ms (OPERATIONS §5.2 gate)`
          )
        );
      } else if (config.verbose) {
        console.log(
          dim(
            `  [/quote] dir=${direction} price=${price} out=${outAmount} nonce=${nonce} (${latencyMs.toFixed(1)}ms)`
          )
        );
      }
      return c.json(resp);
    } catch (err) {
      metrics.quoteOtherFail += 1;
      recordLatency(metrics, performance.now() - t0);
      console.error(red(`  [/quote] ${(err as Error).message}`));
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/swap", async (c) => {
    metrics.swapRequests += 1;
    let body: SwapRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const cached = cacheGet(body.quoteId);
    if (!cached) return c.json({ error: "Unknown or expired quoteId" }, 404);

    return c.json({
      quoteId: cached.quoteId,
      signedQuote: cached.signedQuote,
      verifyIxBase64: cached.verifyIxBase64,
      quoteNonceMarker: cached.quoteNonceMarker,
      message:
        "Client must build tx: [verifyIx, executeSwap(signedQuote, marker)]",
    });
  });

  const server = Deno.serve({ port: config.port }, app.fetch);
  console.log(
    bold(cyan(`  RFQ webhook listening on http://0.0.0.0:${config.port}`))
  );

  return {
    async stop() {
      clearInterval(cacheSweep);
      clearInterval(rateSweep);
      await server.shutdown();
    },
  };
}
