// ============================================================================
// Linear-bps quote curve — TypeScript port (bit-for-bit with Rust)
// ============================================================================
// Bit-identical logic to programs/protocol/src/math/curve.rs.
// Used by the frontend to client-side simulate the "expected receive amount".
//
// All arithmetic uses bigint — mirrors Rust's u128/i128 intermediates.
// ============================================================================

import { BPS_DENOMINATOR, PRICE_SCALE } from "../constants/index.js";
import { Side } from "../instructions/execute_swap.js";

export interface CurveDepthParams {
  depthCoefBps: bigint;
  sizeUnit: bigint;
  maxDepthBps: bigint;
}

export interface CurveSkewParams {
  targetBaseBps: bigint;
  skewCoefBps: bigint;
  maxSkewOffsetBps: bigint;
}

export interface CurveInputs {
  fairValue: bigint;          // in PRICE_SCALE units
  spreadBps: bigint;
  depth: CurveDepthParams;
  skew: CurveSkewParams;
  reservesBase: bigint;       // vault.amount
  reservesQuote: bigint;
  inputAmount: bigint;        // ExactIn: Buy → quote units, Sell → base units
  direction: Side;
}

export interface CurveOutput {
  /** Execution price (quote per base, in PRICE_SCALE units) */
  price: bigint;
  /** Output amount in *output* token unit (Buy→base, Sell→quote), floor */
  outputAmount: bigint;
}

// ============================================================================
// Helpers (bigint, checked arithmetic)
// ============================================================================

function mulDivFloor(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom === 0n) throw new Error("MathError: division by zero");
  return (a * b) / denom;
}

function signedDiffBps(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom === 0n) throw new Error("MathError: division by zero");
  return ((a - b) * BPS_DENOMINATOR) / denom;
}

function clamp(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

// ============================================================================
// evaluate — chain code mirror
// ============================================================================

export function evaluateCurve(inputs: CurveInputs): bigint {
  const { fairValue, spreadBps, depth, skew, direction } = inputs;

  // [ExactIn unit conversion] depth_bps is always computed in base-equivalent
  const sizeBaseEquiv =
    direction === "buy"
      ? mulDivFloor(inputs.inputAmount, PRICE_SCALE, fairValue)
      : inputs.inputAmount;

  // 1) Inventory imbalance (signed bps, target - current)
  const currentBaseValue = mulDivFloor(inputs.reservesBase, fairValue, PRICE_SCALE);
  const totalValue = currentBaseValue + inputs.reservesQuote;

  let imbalanceBps = 0n;
  if (totalValue > 0n) {
    const targetBaseValue = mulDivFloor(totalValue, skew.targetBaseBps, BPS_DENOMINATOR);
    imbalanceBps = signedDiffBps(targetBaseValue, currentBaseValue, totalValue);
  }

  // 2) skew_offset_bps (clamped)
  const skewRaw = (imbalanceBps * skew.skewCoefBps) / BPS_DENOMINATOR;
  const skewOffsetBps = clamp(skewRaw, -skew.maxSkewOffsetBps, skew.maxSkewOffsetBps);

  // 3) depth_bps (linear in size_base_equiv, cap)
  const depthRaw = mulDivFloor(sizeBaseEquiv, depth.depthCoefBps, depth.sizeUnit);
  const depthBps = bigMin(depthRaw, depth.maxDepthBps);

  // 4) direction-aware composition
  const halfSpread = spreadBps / 2n;
  const totalBps =
    direction === "buy"
      ? skewOffsetBps + halfSpread + depthBps
      : skewOffsetBps - halfSpread - depthBps;

  const bpsFactor = BPS_DENOMINATOR + totalBps;
  if (bpsFactor <= 0n) {
    throw new Error("MathUnderflow: bpsFactor <= 0");
  }

  return mulDivFloor(fairValue, bpsFactor, BPS_DENOMINATOR);
}

/**
 * Full ExactIn simulate: returns price + output_amount (floor).
 * Called by the frontend to show users the expected receive amount.
 */
export function simulateSwap(inputs: CurveInputs): CurveOutput {
  const price = evaluateCurve(inputs);

  const outputAmount =
    inputs.direction === "buy"
      ? mulDivFloor(inputs.inputAmount, PRICE_SCALE, price)
      : mulDivFloor(inputs.inputAmount, price, PRICE_SCALE);

  return { price, outputAmount };
}
