// ============================================================================
// PriceSource factory
// ============================================================================
// Composes a PriceSource pipeline from environment-driven config.
// TODO.md §1.4 — the data-source abstraction layer that ships from day one.
//
// Pipeline shape:
//
//   inner = primary source (mock | pyth)
//     └─► (optional) wrapped with FailoverPriceSource if a fallback is set
//           └─► (optional) wrapped with BasisAdjustedSource if BASIS_BPS != 0
//                 └─► what the keeper consumes
//
// Adding a new adapter:
//   1. Implement the PriceSource interface in sources/<name>.ts
//   2. Add a case to createPrimarySource() below.
//   3. Document its env vars in keeper/.env.example.

import type { PriceSource } from "./types.ts";
import { MockPriceSource } from "./mock.ts";
import { PythPriceSource, type PythQuoteKind } from "./pyth.ts";
import { BasisAdjustedSource } from "./basis.ts";
import { FailoverPriceSource } from "./failover.ts";

export type PriceSourceKind = "mock" | "pyth";

export interface PriceSourceConfig {
  kind: PriceSourceKind;
  /** Base mint decimals — adapters that convert human prices need them. */
  baseDecimals: number;
  quoteDecimals: number;
  /** Poll cadence (ms). Adapter-specific defaults apply when unset. */
  pollIntervalMs?: number;

  // ----- mock options -----
  mockBasePrice?: bigint;
  mockStepBps?: number;
  mockSpikeProb?: number;
  mockSpikeMagnitudeBps?: number;

  // ----- pyth options -----
  pythFeedId?: string;
  pythHermesUrl?: string;
  /** `"sse"` (default) or `"poll"`. */
  pythTransport?: "sse" | "poll";
  /** `"spot"` (default) or `"ema"` for smoother price. */
  pythQuoteKind?: PythQuoteKind;
  /** Tick goes stale after this many seconds. Default 60. */
  pythMaxStalenessSec?: number;

  // ----- wrappers -----
  /** Optional fallback source. Composed via FailoverPriceSource. */
  fallback?: PriceSourceConfig;
  /** Signed bps for underlying→tokenized adjustment. Default 0 (no-op). */
  basisAdjustmentBps?: number;
}

function createPrimarySource(cfg: PriceSourceConfig): PriceSource {
  switch (cfg.kind) {
    case "pyth": {
      if (!cfg.pythFeedId) {
        throw new Error(
          "PRICE_SOURCE=pyth requires PYTH_FEED_ID (64-char hex). " +
            "See https://pyth.network/developers/price-feed-ids."
        );
      }
      return new PythPriceSource({
        feedId: cfg.pythFeedId,
        baseDecimals: cfg.baseDecimals,
        quoteDecimals: cfg.quoteDecimals,
        pollIntervalMs: cfg.pollIntervalMs,
        hermesUrl: cfg.pythHermesUrl,
        transport: cfg.pythTransport,
        quoteKind: cfg.pythQuoteKind,
        maxStalenessSec: cfg.pythMaxStalenessSec,
      });
    }
    case "mock":
    default: {
      return new MockPriceSource({
        basePrice: cfg.mockBasePrice ?? 100_000_000n,
        stepBps: cfg.mockStepBps ?? 5,
        tickIntervalMs: cfg.pollIntervalMs ?? 200,
        spikeProb: cfg.mockSpikeProb ?? 0.01,
        spikeMagnitudeBps: cfg.mockSpikeMagnitudeBps ?? 50,
      });
    }
  }
}

export function createPriceSource(cfg: PriceSourceConfig): PriceSource {
  let source: PriceSource = createPrimarySource(cfg);

  // Fallback wrapper (only if explicitly configured).
  if (cfg.fallback) {
    const fallback = createPriceSource(cfg.fallback);
    source = new FailoverPriceSource([source, fallback]);
  }

  // Basis adjustment (only if non-zero).
  if (cfg.basisAdjustmentBps && cfg.basisAdjustmentBps !== 0) {
    source = new BasisAdjustedSource(source, { basisBps: cfg.basisAdjustmentBps });
  }

  return source;
}

// Env-string parsers — treat both `undefined` and empty / whitespace as
// "use the default". A user who writes `PRICE_SOURCE=` in their .env
// almost certainly means "default" rather than "fail".
function normalise(raw: string | undefined, fallback: string): string {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "" ? fallback : v;
}

export function parsePriceSourceKind(raw: string | undefined): PriceSourceKind {
  const v = normalise(raw, "mock");
  if (v === "mock" || v === "pyth") return v;
  throw new Error(`PRICE_SOURCE must be one of: mock | pyth (got "${raw}")`);
}

export function parsePythQuoteKind(raw: string | undefined): PythQuoteKind {
  const v = normalise(raw, "spot");
  if (v === "spot" || v === "ema") return v;
  throw new Error(`PYTH_QUOTE_KIND must be one of: spot | ema (got "${raw}")`);
}

export function parsePythTransport(raw: string | undefined): "sse" | "poll" {
  const v = normalise(raw, "sse");
  if (v === "sse" || v === "poll") return v;
  throw new Error(`PYTH_TRANSPORT must be one of: sse | poll (got "${raw}")`);
}
