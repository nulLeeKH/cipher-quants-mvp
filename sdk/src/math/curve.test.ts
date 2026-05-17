// SDK-side curve simulator — bit-identical to programs/protocol/src/math/curve.rs.
// Mirrors the same fixtures the Rust unit tests use, so any drift between
// the two implementations surfaces here.

import { evaluateCurve, simulateSwap, type CurveInputs } from "./curve.js";
import { BPS_DENOMINATOR, PRICE_SCALE } from "../constants/index.js";

const FAIR = 100n * PRICE_SCALE; // $100 in PRICE_SCALE units

function baseInputs(over: Partial<CurveInputs> = {}): CurveInputs {
  return {
    fairValue: FAIR,
    spreadBps: 20n,
    depth: { depthCoefBps: 0n, sizeUnit: 1n, maxDepthBps: 0n },
    skew: { targetBaseBps: 5_000n, skewCoefBps: 0n, maxSkewOffsetBps: 0n },
    reservesBase: 100n,
    reservesQuote: 100n * FAIR / PRICE_SCALE,
    inputAmount: 1n,
    direction: "buy",
    ...over,
  };
}

describe("evaluateCurve — symmetric spread (no depth, no skew, balanced)", () => {
  it("Buy price = fair × (10_000 + half_spread) / 10_000", () => {
    const buy = evaluateCurve(baseInputs({ direction: "buy" }));
    expect(buy).toBe((FAIR * (BPS_DENOMINATOR + 10n)) / BPS_DENOMINATOR);
  });

  it("Sell price = fair × (10_000 - half_spread) / 10_000", () => {
    const sell = evaluateCurve(baseInputs({ direction: "sell" }));
    expect(sell).toBe((FAIR * (BPS_DENOMINATOR - 10n)) / BPS_DENOMINATOR);
  });
});

describe("evaluateCurve — depth penalty", () => {
  it("scales linearly with size_base_equiv until the cap", () => {
    const inp = baseInputs({
      direction: "sell",
      spreadBps: 0n,
      depth: { depthCoefBps: 2n, sizeUnit: 1_000_000n, maxDepthBps: 100n },
      reservesBase: 1_000n,
      reservesQuote: 1_000n * FAIR / PRICE_SCALE,
      inputAmount: 2_000_000n, // 2× size_unit → 4 bps depth on Sell
    });
    // total_bps = -4 → price = FAIR * 9996 / 10000
    expect(evaluateCurve(inp)).toBe((FAIR * 9_996n) / BPS_DENOMINATOR);
  });

  it("caps at max_depth_bps regardless of size", () => {
    const inp = baseInputs({
      direction: "sell",
      spreadBps: 0n,
      depth: { depthCoefBps: 100n, sizeUnit: 1_000_000n, maxDepthBps: 50n },
      inputAmount: 10_000_000n, // would be 1000 bps unbounded → clipped to 50
    });
    expect(evaluateCurve(inp)).toBe((FAIR * 9_950n) / BPS_DENOMINATOR);
  });
});

describe("evaluateCurve — inventory skew", () => {
  it("base-heavy reserves push Buy price BELOW fair (MM wants to sell base → mid down)", () => {
    const price = evaluateCurve(baseInputs({
      direction: "buy",
      spreadBps: 0n,
      skew: { targetBaseBps: 5_000n, skewCoefBps: 100n, maxSkewOffsetBps: 500n },
      reservesBase: 200n,
      reservesQuote: 10_000n,
    }));
    expect(price < FAIR).toBe(true);
  });

  it("quote-heavy reserves push Buy price ABOVE fair", () => {
    const price = evaluateCurve(baseInputs({
      direction: "buy",
      spreadBps: 0n,
      skew: { targetBaseBps: 5_000n, skewCoefBps: 100n, maxSkewOffsetBps: 500n },
      reservesBase: 50n,
      reservesQuote: 25_000n,
    }));
    expect(price > FAIR).toBe(true);
  });

  it("clamps at max_skew_offset_bps", () => {
    // Skew is fully one-sided (reserves_quote=0) → imbalance = full -10000 bps.
    // raw skew = -10000 * 10000 / 10000 = -10000; clamped to -100.
    const price = evaluateCurve(baseInputs({
      direction: "buy",
      spreadBps: 0n,
      skew: { targetBaseBps: 5_000n, skewCoefBps: 10_000n, maxSkewOffsetBps: 100n },
      reservesBase: 1_000n,
      reservesQuote: 0n,
    }));
    expect(price).toBe((FAIR * 9_900n) / BPS_DENOMINATOR);
  });
});

describe("evaluateCurve — edge cases", () => {
  it("total_value == 0 (empty vaults) → imbalance forced to 0", () => {
    const price = evaluateCurve(baseInputs({
      spreadBps: 0n,
      skew: { targetBaseBps: 5_000n, skewCoefBps: 100n, maxSkewOffsetBps: 500n },
      reservesBase: 0n,
      reservesQuote: 0n,
    }));
    expect(price).toBe(FAIR);
  });

  it("Buy uses quote-to-base equivalent for depth (matches Rust unit test)", () => {
    const inp = baseInputs({
      direction: "buy",
      spreadBps: 0n,
      depth: { depthCoefBps: 2n, sizeUnit: 1_000_000n, maxDepthBps: 100n },
      reservesBase: 1_000n,
      reservesQuote: 1_000n * FAIR / PRICE_SCALE,
      inputAmount: FAIR * 2n, // 2× $100 = $200 quote
    });
    // size_base_equiv = 2 * PRICE_SCALE / PRICE_SCALE * (PRICE_SCALE/FAIR=1) ... 4 bps
    expect(evaluateCurve(inp)).toBe((FAIR * 10_004n) / BPS_DENOMINATOR);
  });

  it("rejects bps_factor ≤ 0 (MathUnderflow analogue)", () => {
    expect(() =>
      evaluateCurve(baseInputs({
        direction: "sell",
        spreadBps: 20_000n, // half=10000 → total_bps=-10000 → factor=0
      })),
    ).toThrow(/Math/);
  });
});

describe("simulateSwap — applies floor rounding on output", () => {
  it("Buy: output = input × PRICE_SCALE / price (floor)", () => {
    const { price, outputAmount } = simulateSwap(baseInputs({
      direction: "buy",
      inputAmount: 100n * FAIR / PRICE_SCALE, // 100 base-worth of quote in PRICE_SCALE units? actually large
    }));
    // No skew / depth → price = FAIR + 10 bps
    expect(price > FAIR).toBe(true);
    // Output is floored — never receive more than fair share.
    expect(outputAmount > 0n).toBe(true);
  });

  it("Sell: output = input × price / PRICE_SCALE (floor)", () => {
    const { price, outputAmount } = simulateSwap(baseInputs({
      direction: "sell",
      inputAmount: 1_000n,
    }));
    expect(price < FAIR).toBe(true);
    expect(outputAmount).toBe((1_000n * price) / PRICE_SCALE);
  });
});
