// ============================================================================
// PriceSource factory
// ============================================================================
// Picks the concrete PriceSource implementation at boot. Driven by env vars
// so the keeper can switch sources without code edits (TODO.md §1.4 — the
// data-source abstraction layer that ships from day one).
//
// Adding a new source:
//   1. Implement the PriceSource interface in sources/<name>.ts
//   2. Add a case to createPriceSource() below.
//   3. Document the env vars in keeper/.env.example.

import type { PriceSource } from "./types.ts";
import { MockPriceSource } from "./mock.ts";
import { PythPriceSource } from "./pyth.ts";

export type PriceSourceKind = "mock" | "pyth";

export interface PriceSourceConfig {
  kind: PriceSourceKind;
  /** Base mint decimals — used by adapters that convert human prices. */
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
}

export function createPriceSource(cfg: PriceSourceConfig): PriceSource {
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

export function parsePriceSourceKind(raw: string | undefined): PriceSourceKind {
  const v = (raw ?? "mock").trim().toLowerCase();
  if (v === "mock" || v === "pyth") return v;
  throw new Error(
    `PRICE_SOURCE must be one of: mock | pyth (got "${raw}")`
  );
}
