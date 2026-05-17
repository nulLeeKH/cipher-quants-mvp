// ============================================================================
// BasisAdjustedSource — bridges "underlying" feeds to tokenized assets
// ============================================================================
// Pyth (and most public price feeds) publish the *underlying* asset price —
// the NYSE-listed equity, the native crypto. For tokenized representations
// (xStocks, wrapped assets, …) there is a basis between the underlying and
// the on-chain token: redemption costs, mint/redeem latency, off-hours
// drift, the issuer's premium/discount.
//
// This wrapper lets us assemble the pipeline
//
//   PythPriceSource  (underlying price)
//     └─► BasisAdjustedSource  (basis bps, configurable)
//           └─► keeper
//
// without changing either side. The basis is a single signed bps offset for
// now (positive = tokenized trades at a *premium* to underlying). When a
// dynamic basis feed becomes available (e.g. an on-chain oracle for the
// xStock token itself, or a Jupiter LP-derived implied price) replace this
// constant with a feed; the keeper code path is unchanged.
//
// `basisBps = 0` is a no-op; safe to wrap unconditionally if the operator
// wants the audit trail to show the wrapper was considered.

import type { PriceSource, PriceTick } from "./types.ts";

export interface BasisAdjustedSourceOpts {
  /**
   * Signed bps. fair_value_out = fair_value_in × (10_000 + basisBps) / 10_000.
   * Positive = tokenized > underlying. Bounded to ±5_000 (±50 %) to catch
   * config mistakes; legitimate basis is well within ±100 for a healthy pair.
   */
  basisBps: number;
}

const MAX_ABS_BASIS_BPS = 5_000;

export class BasisAdjustedSource implements PriceSource {
  readonly label: string;

  constructor(
    private inner: PriceSource,
    private opts: BasisAdjustedSourceOpts
  ) {
    if (!Number.isInteger(opts.basisBps)) {
      throw new Error("BasisAdjustedSource: basisBps must be an integer");
    }
    if (Math.abs(opts.basisBps) > MAX_ABS_BASIS_BPS) {
      throw new Error(
        `BasisAdjustedSource: |basisBps| must be ≤ ${MAX_ABS_BASIS_BPS}, got ${opts.basisBps}. ` +
          `If you really want this, raise the cap deliberately.`
      );
    }
    this.label = `${inner.label}+basis(${opts.basisBps}bps)`;
  }

  async current(): Promise<PriceTick> {
    const t = await this.inner.current();
    if (this.opts.basisBps === 0) return t;
    // Bigint arithmetic — preserves precision of the upstream fair_value.
    const factor = BigInt(10_000 + this.opts.basisBps);
    const fairValue = (t.fairValue * factor) / 10_000n;
    return { ...t, fairValue };
  }

  start(): Promise<() => void> {
    return this.inner.start();
  }
}
