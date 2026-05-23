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
//   - Keeper        = oracle push (write to chain via update_oracle).
//   - API server    = quote response (read chain + ed25519-sign quotes).
//   - Hot keys are SPLIT on-chain: pool.authorized_oracle_signer (keeper) vs
//     pool.authorized_quote_signer (api server). PoC may reuse the same
//     keypair file; production sets QUOTE_SIGNER_WALLET_PATH to a distinct
//     keypair so a compromise of either box does not leak the other capability.

import { Buffer } from "node:buffer";
import { Hono } from "@hono/hono";
import {
  Keypair,
  Connection,
  PublicKey,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { createRequire } from "node:module";
import { bold, cyan, dim, red, yellow } from "@std/fmt/colors";

import type { ApiConfig } from "./config.ts";
import { computeFreshness } from "./freshness.ts";
import { assembleSwapTx } from "./swap_tx.ts";

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
  swapSuccess: number;
  swapDriftReject: number;
  swapInventoryReject: number;
  swapCurveFreshReject: number;
  swapExpiredReject: number;
  swapPausedReject: number;
  swapClientFail: number;
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
    swapSuccess: 0,
    swapDriftReject: 0,
    swapInventoryReject: 0,
    swapCurveFreshReject: 0,
    swapExpiredReject: 0,
    swapPausedReject: 0,
    swapClientFail: 0,
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
    `cipher_swap_success_total ${m.swapSuccess}`,
    `cipher_swap_drift_reject_total ${m.swapDriftReject}`,
    `cipher_swap_inventory_reject_total ${m.swapInventoryReject}`,
    `cipher_swap_curve_fresh_reject_total ${m.swapCurveFreshReject}`,
    `cipher_swap_expired_reject_total ${m.swapExpiredReject}`,
    `cipher_swap_paused_reject_total ${m.swapPausedReject}`,
    `cipher_swap_client_fail_total ${m.swapClientFail}`,
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
// deno-lint-ignore no-explicit-any
const sdkInstructions: any = require("../../sdk/dist/instructions/index.js");
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
  /** Quoted price in PRICE_SCALE units (raw_quote_per_raw_base × 1e6). */
  price: string;
  /** Pool's fair_value at quote time. Last-look at /swap compares against the
   *  current fair_value and rejects if drift exceeds MM_MAX_DRIFT_BPS.
   *
   *  No separate fee field is exposed: the MM's revenue is the spread
   *  embedded in `price` vs `fairValueAtQuote`. Consumers that want a
   *  bps-style fee for UI/routing comparison compute it themselves:
   *    feeBps = abs(price - fairValueAtQuote) * 10_000 / fairValueAtQuote
   *  That stays correct even when the RFQ pricing strategy moves past the
   *  simple half-spread model (inventory-aware, vol-aware, depth-aware,
   *  etc.) — `feeBps = spread/2` would silently lie under v1 strategies. */
  fairValueAtQuote: string;
  expirySlot: number;
}

interface SwapRequest {
  quoteId: string;
  userPubkey: string;
}

interface SwapResponse {
  quoteId: string;
  /** Base64-encoded unsigned `VersionedTransaction`. Layout:
   *    [setComputeUnitLimit(250k),
   *     createAssociatedTokenAccountIdempotent × 2 (base, quote),
   *     ed25519_verify_ix,
   *     execute_swap_ix]
   *  User wallet deserialises, signs, and sends. JupiterZ router treats this
   *  as the canonical `swapTransaction`. The MM does NOT sign the tx — its
   *  commitment is the ed25519 signature embedded in `verify_ix.data`. */
  tx: string;
  lastValidBlockHeight: number;
  /** Same data, broken out for callers that want to assemble their own
   *  transaction shell (FE swap UI, raw integrations). Optional for
   *  JupiterZ-style consumers. */
  components: {
    signedQuote: {
      pool: string;
      user: string;
      direction: number;
      inputAmount: string;
      price: string;
      expirySlot: string;
      nonce: string;
      signature: string;
    };
    verifyIxBase64: string;
    quoteNonceMarker: string;
  };
}

/** Internal cache shape. Holds everything needed to sign at /swap time
 *  without re-deriving the quote. The MM does not commit until /swap. */
interface PendingQuote {
  quoteId: string;
  poolAddr: PublicKey;
  userPk: PublicKey;
  direction: "buy" | "sell";
  inAmount: bigint;
  outAmount: bigint;
  price: bigint;
  fairValueAtQuote: bigint;
  expirySlot: bigint;
  nonce: bigint;
  marker: PublicKey;
  /** Same TTL clock used by the cache sweeper. */
  expiresAtMs: number;
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
  const quoteCache = new Map<string, PendingQuote>();
  function cacheSet(pending: PendingQuote): void {
    // LRU semantics: deletion + re-insert places the entry at the tail.
    quoteCache.delete(pending.quoteId);
    quoteCache.set(pending.quoteId, pending);
    // Evict from the front while over capacity (Map iteration order = insertion).
    while (quoteCache.size > QUOTE_CACHE_MAX_ENTRIES) {
      const oldest = quoteCache.keys().next().value;
      if (oldest === undefined) break;
      quoteCache.delete(oldest);
    }
  }
  function cacheGet(key: string): PendingQuote | undefined {
    const entry = quoteCache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs < Date.now()) {
      quoteCache.delete(key);
      return undefined;
    }
    return entry;
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

  // JupiterZ /tokens — array of supported mint addresses. Spec accepts either
  // a raw array of mint strings or an array of `{address, symbol, decimals}`.
  // Use the richer object shape so partner UIs can render without an extra
  // mint-metadata lookup.
  app.get("/tokens", (c) =>
    c.json({
      tokens: [
        {
          address: config.baseMint!.toBase58(),
          symbol: config.baseSymbol,
          decimals: config.baseDecimals,
        },
        {
          address: config.quoteMint!.toBase58(),
          symbol: config.quoteSymbol,
          decimals: config.quoteDecimals,
        },
      ],
    })
  );

  // /freshness — Metis-side routing signal. Metis only sends curve-path swaps
  // when the curve is fresh; otherwise it should skip our pool and let
  // JupiterZ pick the RFQ path. Cheap pool-state read, no signing.
  app.get("/freshness", async (c) => {
    try {
      const { state: pool } = await sdkAccounts.fetchPoolState(
        program,
        config.baseMint!,
        config.quoteMint!
      );
      const currentSlot = await connection.getSlot();
      return c.json(
        computeFreshness({
          lastOracleUpdateSlot: pool.lastOracleUpdateSlot.toNumber(),
          currentModeTtl: pool.currentModeTtl as number,
          paused: pool.paused,
          currentSlot,
        })
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

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
      // (the user trades directly via the curve path instead). Reuse the same
      // pure helper that backs `/freshness` so the two endpoints can't drift.
      const currentSlot = await connection.getSlot();
      const freshness = computeFreshness({
        lastOracleUpdateSlot: pool.lastOracleUpdateSlot.toNumber(),
        currentModeTtl: pool.currentModeTtl as number,
        paused: pool.paused,
        currentSlot,
      });
      if (freshness.fresh) {
        // 409 Conflict: the request is well-formed, but the pool's current
        // state (fresh curve) makes the RFQ path the wrong choice. 404 was
        // misleading — the endpoint exists; the caller should switch paths.
        return c.json(
          {
            error:
              "Curve is fresh — use direct execute_swap (curve path) instead",
          },
          409
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

      // Reserve nonce + derive marker. MM does NOT sign here — signing is
      // deferred to /swap so the MM retains a last-look reject point
      // (JupiterZ-style; see docs/OPERATIONS.md §5.4).
      const expirySlot = BigInt(currentSlot + config.quoteValidWindowSlots);
      const nonce = nextQuoteNonce();
      const [marker] = sdkAccounts.deriveQuoteNonceMarker(
        poolAddr,
        nonce,
        program.programId
      );

      const quoteId = nonce.toString();
      const pending: PendingQuote = {
        quoteId,
        poolAddr,
        userPk,
        direction,
        inAmount,
        outAmount,
        price,
        fairValueAtQuote: fairValue,
        expirySlot,
        nonce,
        marker,
        expiresAtMs: Date.now() + QUOTE_CACHE_TTL_MS,
      };
      cacheSet(pending);

      const resp: QuoteResponse = {
        quoteId,
        inputMint: body.inputMint,
        outputMint: body.outputMint,
        inAmount: inAmount.toString(),
        outAmount: outAmount.toString(),
        price: price.toString(),
        fairValueAtQuote: fairValue.toString(),
        expirySlot: Number(expirySlot),
      };

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
    const t0 = performance.now();
    metrics.swapRequests += 1;
    let body: SwapRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const pending = cacheGet(body.quoteId);
    if (!pending) {
      metrics.swapClientFail += 1;
      return c.json({ error: "Unknown or expired quoteId" }, 404);
    }

    // The userPubkey on /swap must match the userPubkey baked into /quote.
    // Without this check a leaked quoteId could be redeemed by anyone.
    try {
      const requester = new PublicKey(body.userPubkey);
      if (!requester.equals(pending.userPk)) {
        metrics.swapClientFail += 1;
        return c.json(
          { error: "userPubkey does not match the quote's bound user" },
          403
        );
      }
    } catch {
      metrics.swapClientFail += 1;
      return c.json({ error: "Invalid userPubkey" }, 400);
    }

    // ─── Last-look (Maker-side reject gate) ─────────────────────────────
    // Re-read on-chain state at /swap time and compare against quote-time
    // assumptions. JupiterZ requires the MM to either return a settlement
    // payload or reject (4xx) — never silently commit. The MM's signed
    // ed25519 message is the commitment, so we delay signing until every
    // check below passes.
    try {
      const { state: pool } = await sdkAccounts.fetchPoolState(
        program,
        config.baseMint!,
        config.quoteMint!
      );

      if (pool.paused) {
        metrics.swapPausedReject += 1;
        return c.json({ error: "Pool is paused" }, 503);
      }

      const currentSlot = await connection.getSlot();
      if (BigInt(currentSlot) >= pending.expirySlot) {
        // 410 Gone is the right shape for "this once-valid resource is past
        // its TTL" — the caller should request a new quote.
        metrics.swapExpiredReject += 1;
        return c.json({ error: "Quote expired" }, 410);
      }

      const freshness = computeFreshness({
        lastOracleUpdateSlot: pool.lastOracleUpdateSlot.toNumber(),
        currentModeTtl: pool.currentModeTtl as number,
        paused: pool.paused,
        currentSlot,
      });
      if (freshness.fresh) {
        metrics.swapCurveFreshReject += 1;
        return c.json(
          { error: "Curve became fresh — use direct execute_swap (curve path)" },
          409
        );
      }

      // Price drift check. abs(now - then) * 10_000 / then > MM_MAX_DRIFT_BPS.
      // CEIL division — flooring would under-report drift and let the MM
      // accept quotes that are just past the threshold (against the
      // protocol). Stricter rejection biases in the protocol's favour.
      const fairValueNow = BigInt(pool.fairValue.toString());
      const drift = fairValueNow > pending.fairValueAtQuote
        ? fairValueNow - pending.fairValueAtQuote
        : pending.fairValueAtQuote - fairValueNow;
      const driftBps =
        (drift * 10_000n + pending.fairValueAtQuote - 1n) / pending.fairValueAtQuote;
      if (driftBps > BigInt(config.mmMaxDriftBps)) {
        metrics.swapDriftReject += 1;
        return c.json(
          {
            error: "Price drift exceeded last-look threshold",
            driftBps: driftBps.toString(),
            maxBps: config.mmMaxDriftBps,
          },
          409
        );
      }

      // Inventory recheck — vault may have drained between /quote and /swap.
      const balances = await sdkAccounts.fetchVaultBalances(
        program,
        pending.poolAddr,
        config.baseMint!,
        config.quoteMint!
      );
      const availableOut =
        pending.direction === "buy" ? balances.baseAmount : balances.quoteAmount;
      if (availableOut < pending.outAmount) {
        metrics.swapInventoryReject += 1;
        return c.json(
          {
            error: "Inventory underflow at swap time",
            requested: pending.outAmount.toString(),
            available: availableOut.toString(),
            side: pending.direction === "buy" ? "base" : "quote",
          },
          503
        );
      }

      // All last-look checks passed — sign now.
      const built = sdk.buildSignedQuoteWithVerifyIx(quoteSigner, {
        pool: pending.poolAddr,
        user: pending.userPk,
        direction: pending.direction,
        inputAmount: pending.inAmount,
        price: pending.price,
        expirySlot: pending.expirySlot,
        nonce: pending.nonce,
      });

      const baseVault = sdkAccounts.deriveVault(
        pending.poolAddr,
        config.baseMint!,
        program.programId
      )[0];
      const quoteVault = sdkAccounts.deriveVault(
        pending.poolAddr,
        config.quoteMint!,
        program.programId
      )[0];
      // Single canonical derivation of user ATAs — feeds createExecuteSwapIx
      // and assembleSwapTx (which re-derives identically via the same
      // getAssociatedTokenAddressSync).
      const userBaseAta = getAssociatedTokenAddressSync(
        config.baseMint!,
        pending.userPk
      );
      const userQuoteAta = getAssociatedTokenAddressSync(
        config.quoteMint!,
        pending.userPk
      );

      const swapIx = await sdkInstructions.createExecuteSwapIx(program, {
        user: pending.userPk,
        poolState: pending.poolAddr,
        baseVault,
        quoteVault,
        userBaseAta,
        userQuoteAta,
        inputAmount: new BN(pending.inAmount.toString()),
        direction: pending.direction,
        minOutput: new BN(pending.outAmount.toString()),
        signedQuote: built.signedQuote,
        quoteNonceMarker: pending.marker,
      });

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
        "confirmed"
      );

      const assembled = assembleSwapTx({
        userPk: pending.userPk,
        poolAddr: pending.poolAddr,
        baseMint: config.baseMint!,
        quoteMint: config.quoteMint!,
        baseVault,
        quoteVault,
        verifyIx: built.verifyIx,
        swapIx,
        recentBlockhash: blockhash,
      });
      const txBase64 = assembled.txBase64;

      // Single-use semantics: a successful /swap consumes the quote. A second
      // call must request a fresh /quote (and a fresh nonce, which prevents
      // a parallel attempt from racing the first one through execute_swap).
      quoteCache.delete(pending.quoteId);
      metrics.swapSuccess += 1;

      const resp: SwapResponse = {
        quoteId: pending.quoteId,
        tx: txBase64,
        lastValidBlockHeight,
        components: {
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
          quoteNonceMarker: pending.marker.toBase58(),
        },
      };

      const latencyMs = performance.now() - t0;
      if (latencyMs > SLOW_WARN_MS) {
        console.warn(
          yellow(
            `  [/swap] slow: ${latencyMs.toFixed(1)}ms > ${SLOW_WARN_MS}ms (OPERATIONS §5.2 gate)`
          )
        );
      } else if (config.verbose) {
        console.log(
          dim(
            `  [/swap] quoteId=${pending.quoteId} signed (${latencyMs.toFixed(1)}ms)`
          )
        );
      }
      return c.json(resp);
    } catch (err) {
      console.error(red(`  [/swap] ${(err as Error).message}`));
      return c.json({ error: (err as Error).message }, 500);
    }
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
