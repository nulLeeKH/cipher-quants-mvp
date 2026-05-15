use anchor_lang::prelude::*;

use crate::constants::{BPS_DENOMINATOR, PRICE_SCALE};
use crate::error::ErrorCode;
use crate::state::{DepthParams, Side, SkewParams};

// ============================================================================
// Linear-bps quote curve evaluate
// ============================================================================
// docs/SPECIFICATION.md §2.2 — variant of the Drift v3 reservation price.
//
//   size_base_equiv = (Buy)  input_amount * PRICE_SCALE / fair_value
//                     (Sell) input_amount
//
//   imbalance_bps = (target_base_value - current_base_value) * 10_000 / total_value
//                   ↑ +ve = quote-heavy (base shortfall; MM wants to buy base → mid up)
//                   ↑ -ve = base-heavy  (base surplus;   MM wants to sell base → mid down)
//
//   skew_offset_bps = clamp(imbalance_bps * skew_coef_bps / 10_000, ±max_skew_offset_bps)
//   depth_bps       = min(size_base_equiv * depth_coef_bps / size_unit, max_depth_bps)
//
//   total_bps = (Buy)  skew_offset + half_spread + depth_bps
//               (Sell) skew_offset - half_spread - depth_bps
//
//   price = fair_value * (10_000 + total_bps) / 10_000
//
// Price-calc invariant (compile-time assertion in constants.rs):
//   |total_bps| < BPS_DENOMINATOR  →  (10_000 + total_bps) > 0
// ============================================================================

pub fn evaluate(
    fair_value: u64,
    spread_bps: u16,
    depth: &DepthParams,
    skew: &SkewParams,
    reserves_base: u64,
    reserves_quote: u64,
    input_amount: u64,
    direction: Side,
) -> Result<u64> {
    // [ExactIn unit conversion] depth_bps is always computed in base-equivalent.
    let size_base_equiv = match direction {
        Side::Buy => mul_div_floor(input_amount, PRICE_SCALE, fair_value)?,
        Side::Sell => input_amount,
    };

    // 1) Normalize inventory imbalance as signed bps.
    //    base-heavy (surplus)  → imbalance < 0
    //    quote-heavy (shortfall) → imbalance > 0
    //    If total_value == 0 (right after init, or empty vaults), force imbalance = 0.
    let current_base_value = mul_div_floor(reserves_base, fair_value, PRICE_SCALE)?;
    let total_value = current_base_value
        .checked_add(reserves_quote)
        .ok_or(ErrorCode::MathOverflow)?;

    let imbalance_bps: i64 = if total_value == 0 {
        0
    } else {
        let target_base_value =
            mul_div_floor(total_value, skew.target_base_bps as u64, BPS_DENOMINATOR)?;
        // (target - current) * BPS_DENOMINATOR / total_value, signed.
        signed_diff_bps(target_base_value, current_base_value, total_value)?
    };

    // 2) skew_offset_bps (clamp by max_skew_offset_bps)
    let skew_offset_bps = {
        let raw = (imbalance_bps as i128)
            .checked_mul(skew.skew_coef_bps as i128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOMINATOR as i128)
            .ok_or(ErrorCode::MathError)?;
        let cap = skew.max_skew_offset_bps as i128;
        raw.clamp(-cap, cap) as i64
    };

    // 3) depth_bps (linear, cap)
    let depth_bps_raw =
        mul_div_floor(size_base_equiv, depth.depth_coef_bps as u64, depth.size_unit)?;
    let depth_bps = depth_bps_raw.min(depth.max_depth_bps as u64) as i64;

    // 4) direction-aware composition
    let half_spread = (spread_bps as i64) / 2;
    let total_bps: i64 = match direction {
        Side::Buy => skew_offset_bps
            .checked_add(half_spread)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_add(depth_bps)
            .ok_or(ErrorCode::MathOverflow)?,
        Side::Sell => skew_offset_bps
            .checked_sub(half_spread)
            .ok_or(ErrorCode::MathUnderflow)?
            .checked_sub(depth_bps)
            .ok_or(ErrorCode::MathUnderflow)?,
    };

    // bps_factor = 10_000 + total_bps. The constants.rs invariant already guarantees
    // this is positive; we still check explicitly as defense-in-depth.
    let bps_factor: i64 = (BPS_DENOMINATOR as i64)
        .checked_add(total_bps)
        .ok_or(ErrorCode::MathOverflow)?;
    if bps_factor <= 0 {
        return Err(ErrorCode::MathUnderflow.into());
    }

    // price = fair_value * bps_factor / BPS_DENOMINATOR.
    // The user-receives amount is floored in execute_swap, so we only need floor here
    // (no need for round-to-nearest at the price level).
    let price = mul_div_floor(fair_value, bps_factor as u64, BPS_DENOMINATOR)?;

    Ok(price)
}

// ============================================================================
// Helpers
// ============================================================================

/// `a * b / denom`, floor, u128 intermediate, overflow/zero-div checked.
#[inline]
pub fn mul_div_floor(a: u64, b: u64, denom: u64) -> Result<u64> {
    if denom == 0 {
        return Err(ErrorCode::MathError.into());
    }
    let result = (a as u128)
        .checked_mul(b as u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(denom as u128)
        .ok_or(ErrorCode::MathError)?;
    u64::try_from(result).map_err(|_| ErrorCode::MathOverflow.into())
}

/// `a * b / denom`, ceil, u128 intermediate.
#[inline]
pub fn mul_div_ceil(a: u64, b: u64, denom: u64) -> Result<u64> {
    if denom == 0 {
        return Err(ErrorCode::MathError.into());
    }
    let numer = (a as u128)
        .checked_mul(b as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    let denom_u128 = denom as u128;
    let result = numer
        .checked_add(denom_u128 - 1)
        .ok_or(ErrorCode::MathOverflow)?
        / denom_u128;
    u64::try_from(result).map_err(|_| ErrorCode::MathOverflow.into())
}

/// `(a - b) * BPS_DENOMINATOR / denom`, signed (a/b are u64, result i64).
#[inline]
pub fn signed_diff_bps(a: u64, b: u64, denom: u64) -> Result<i64> {
    if denom == 0 {
        return Err(ErrorCode::MathError.into());
    }
    let diff = (a as i128)
        .checked_sub(b as i128)
        .ok_or(ErrorCode::MathUnderflow)?;
    let scaled = diff
        .checked_mul(BPS_DENOMINATOR as i128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(denom as i128)
        .ok_or(ErrorCode::MathError)?;
    i64::try_from(scaled).map_err(|_| ErrorCode::MathOverflow.into())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn params_no_depth() -> DepthParams {
        DepthParams {
            depth_coef_bps: 0,
            size_unit: 1,
            max_depth_bps: 0,
            _reserved: [0; 6],
        }
    }

    fn params_with_depth(coef: u32, unit: u64, cap: u16) -> DepthParams {
        DepthParams {
            depth_coef_bps: coef,
            size_unit: unit,
            max_depth_bps: cap,
            _reserved: [0; 6],
        }
    }

    fn skew_zero() -> SkewParams {
        SkewParams {
            target_base_bps: 5_000,
            skew_coef_bps: 0,
            max_skew_offset_bps: 0,
            _reserved: [0; 10],
        }
    }

    fn skew_active(coef: u16, cap: u16) -> SkewParams {
        SkewParams {
            target_base_bps: 5_000,
            skew_coef_bps: coef,
            max_skew_offset_bps: cap,
            _reserved: [0; 10],
        }
    }

    // fair_value = $100 with PRICE_SCALE=1e6 → 100_000_000
    const FAIR: u64 = 100 * PRICE_SCALE;

    #[test]
    fn basic_no_depth_no_skew_balanced() {
        // spread 20 bps → half 10 bps. Buy=fair*1.001, Sell=fair*0.999.
        let depth = params_no_depth();
        let skew = skew_zero();
        // Balanced inventory: 50% base value, 50% quote value.
        let reserves_base = 100; // base raw amount
        let reserves_quote = reserves_base * FAIR / PRICE_SCALE; // matching quote value

        let buy = evaluate(
            FAIR, 20, &depth, &skew, reserves_base, reserves_quote, 1, Side::Sell,
        )
        .unwrap();
        let sell = buy; // re-use for symmetry test below

        let buy_price = evaluate(
            FAIR, 20, &depth, &skew, reserves_base, reserves_quote, 1, Side::Buy,
        )
        .unwrap();
        let sell_price = evaluate(
            FAIR, 20, &depth, &skew, reserves_base, reserves_quote, 1, Side::Sell,
        )
        .unwrap();

        assert_eq!(buy_price, FAIR * 10_010 / 10_000);
        assert_eq!(sell_price, FAIR * 9_990 / 10_000);
        // Simple sanity
        assert!(buy_price > sell_price);
        let _ = (buy, sell);
    }

    #[test]
    fn zero_total_value_safe() {
        // Empty vault → imbalance = 0, only depth applies. input=0 is invalid in
        // the caller, but the function itself must not panic even when vault==0.
        let depth = params_no_depth();
        let skew = skew_active(100, 500);
        let price = evaluate(FAIR, 0, &depth, &skew, 0, 0, 1, Side::Buy).unwrap();
        assert_eq!(price, FAIR); // spread=0 + skew=0 (vault empty) + depth=0
    }

    #[test]
    fn depth_scales_with_size() {
        // size_unit=1_000_000 (1.0 base), coef=2 bps/unit → +2 bps slippage per base.
        let depth = params_with_depth(2, 1_000_000, 100);
        let skew = skew_zero();
        let reserves_base = 1000;
        let reserves_quote = 1000 * FAIR / PRICE_SCALE;

        // Sell: input = 2 base (2_000_000 raw with 1e6 decimals)
        let price = evaluate(
            FAIR,
            0,
            &depth,
            &skew,
            reserves_base,
            reserves_quote,
            2_000_000,
            Side::Sell,
        )
        .unwrap();
        // depth_bps = 2_000_000 * 2 / 1_000_000 = 4 bps
        // Sell total_bps = 0 - 0 - 4 = -4 bps → price = fair * 9996/10000
        assert_eq!(price, FAIR * 9_996 / 10_000);
    }

    #[test]
    fn depth_capped() {
        // coef large → raw depth_bps would exceed cap → cap applies.
        let depth = params_with_depth(100, 1_000_000, 50); // raw 1000 bps but cap 50.
        let skew = skew_zero();
        let reserves_base = 1000;
        let reserves_quote = 1000 * FAIR / PRICE_SCALE;

        // Sell direction: input = 10_000_000 base raw → size_base_equiv unchanged.
        // depth_bps_raw = 10_000_000 * 100 / 1_000_000 = 1000 → cap 50.
        let price = evaluate(
            FAIR,
            0,
            &depth,
            &skew,
            reserves_base,
            reserves_quote,
            10_000_000,
            Side::Sell,
        )
        .unwrap();
        // Sell total = 0 - 0 - 50 = -50 → price = fair * 9950/10000
        assert_eq!(price, FAIR * 9_950 / 10_000);
    }

    #[test]
    fn skew_base_heavy_reduces_buy_price() {
        // Vault: base 200, quote 100*FAIR (=10000 quote units value). target=5000 bps (50%).
        // base value = 200*FAIR/PRICE_SCALE = 200*100 = 20000 (with PRICE_SCALE=1e6 means FAIR=1e8, 200*1e8/1e6=20000)
        let depth = params_no_depth();
        let skew = skew_active(100, 500); // skew_coef=100, cap 500

        let reserves_base = 200; // 200 base raw → 200*FAIR/PRICE_SCALE = 20000 quote-equivalent
        let reserves_quote = 10_000;
        // total_value = 30000, target_base_value = 15000, current = 20000.
        // imbalance = (15000 - 20000) * 10000 / 30000 = -1666.67 → -1666 bps
        // skew_offset_raw = -1666 * 100 / 10000 = -16.66 → -16
        // cap is 500, so -16 stays as-is
        // Buy total_bps = -16 + 0 + 0 = -16 → price < fair (base-heavy makes buys cheaper ✓)
        let price = evaluate(
            FAIR,
            0,
            &depth,
            &skew,
            reserves_base,
            reserves_quote,
            1,
            Side::Buy,
        )
        .unwrap();
        assert!(price < FAIR, "base-heavy: Buy price must be below fair");
    }

    #[test]
    fn skew_quote_heavy_raises_buy_price() {
        let depth = params_no_depth();
        let skew = skew_active(100, 500);

        let reserves_base = 50; // base value 5000
        let reserves_quote = 25_000;
        // total = 30000, target = 15000, current = 5000.
        // imbalance = (15000 - 5000) * 10000 / 30000 = 3333.33 → 3333
        // skew_offset_raw = 3333 * 100 / 10000 = 33.33 → 33
        // Buy total_bps = 33 + 0 + 0 = 33 → price > fair (quote-heavy makes buys pricier ✓)
        let price = evaluate(
            FAIR,
            0,
            &depth,
            &skew,
            reserves_base,
            reserves_quote,
            1,
            Side::Buy,
        )
        .unwrap();
        assert!(price > FAIR);
    }

    #[test]
    fn skew_capped_at_max_offset() {
        let depth = params_no_depth();
        let skew = skew_active(10_000, 100); // coef=10000 (=1.0 multiplier), cap 100

        let reserves_base = 1000;
        let reserves_quote = 0;
        // imbalance = (target - current) * 10000 / total
        //   current_base_value = 1000 * FAIR / PRICE_SCALE = 100000
        //   total = 100000
        //   target = 100000 * 5000 / 10000 = 50000
        //   imbalance = (50000 - 100000) * 10000 / 100000 = -5000
        // skew_offset_raw = -5000 * 10000 / 10000 = -5000
        // cap = 100 → clamped to -100
        // Buy total_bps = -100 + 0 + 0 = -100
        let price = evaluate(
            FAIR,
            0,
            &depth,
            &skew,
            reserves_base,
            reserves_quote,
            1,
            Side::Buy,
        )
        .unwrap();
        assert_eq!(price, FAIR * 9_900 / 10_000);
    }

    #[test]
    fn exact_in_buy_uses_quote_to_base_equiv() {
        // Buy input is quote. depth_bps should be computed on base equivalent.
        let depth = params_with_depth(2, 1_000_000, 100);
        let skew = skew_zero();
        let reserves_base = 1000;
        let reserves_quote = 1000 * FAIR / PRICE_SCALE;

        // input = FAIR * 2 = 2 base worth of quote. base_equiv = 2*PRICE_SCALE = 2_000_000.
        let input_amount = FAIR * 2;
        let price = evaluate(
            FAIR,
            0,
            &depth,
            &skew,
            reserves_base,
            reserves_quote,
            input_amount,
            Side::Buy,
        )
        .unwrap();
        // depth_bps = 2_000_000 * 2 / 1_000_000 = 4 bps
        // Buy total = 0 + 0 + 4 = 4
        assert_eq!(price, FAIR * 10_004 / 10_000);
    }

    #[test]
    fn exact_in_sell_uses_base_directly() {
        let depth = params_with_depth(2, 1_000_000, 100);
        let skew = skew_zero();
        let reserves_base = 1000;
        let reserves_quote = 1000 * FAIR / PRICE_SCALE;

        // Sell input is base directly. size_base_equiv = 2_000_000.
        let price = evaluate(
            FAIR,
            0,
            &depth,
            &skew,
            reserves_base,
            reserves_quote,
            2_000_000,
            Side::Sell,
        )
        .unwrap();
        // depth_bps = 4 bps. Sell total = 0 - 0 - 4 = -4. price = fair*9996/10000
        assert_eq!(price, FAIR * 9_996 / 10_000);
    }

    #[test]
    fn combined_spread_depth_skew() {
        let depth = params_with_depth(5, 1_000_000, 200); // 5 bps/unit, cap 200
        let skew = skew_active(50, 100); // coef 50, cap 100

        let reserves_base = 200;
        let reserves_quote = 10_000;
        // base_value = 200*FAIR/PRICE_SCALE = 20000
        // total = 30000, target = 15000.
        // imbalance = (15000 - 20000)*10000/30000 = -1666
        // skew_offset_raw = -1666 * 50 / 10000 = -8.33 → -8 (clamp at -100)
        // Spread 30 → half 15.
        //
        // Buy input is in quote units. FAIR * 2 = 200_000_000 quote = 2 base worth.
        // size_base_equiv = 200_000_000 * 1_000_000 / 100_000_000 = 2_000_000 (2 base).
        // depth_bps = 2_000_000 * 5 / 1_000_000 = 10 bps.
        // Buy total_bps = -8 + 15 + 10 = 17 → price = fair * 10017 / 10000
        let input_quote = FAIR * 2;
        let price = evaluate(
            FAIR,
            30,
            &depth,
            &skew,
            reserves_base,
            reserves_quote,
            input_quote,
            Side::Buy,
        )
        .unwrap();
        assert_eq!(price, FAIR * 10_017 / 10_000);
    }

    // ----- helper tests -----

    #[test]
    fn mul_div_floor_basic() {
        assert_eq!(mul_div_floor(100, 50, 10).unwrap(), 500);
        assert_eq!(mul_div_floor(7, 3, 2).unwrap(), 10); // 21/2 = 10 (floor)
    }

    #[test]
    fn mul_div_floor_overflow_handled() {
        let r = mul_div_floor(u64::MAX, u64::MAX, 1);
        assert!(r.is_err());
    }

    #[test]
    fn mul_div_floor_div_by_zero() {
        let r = mul_div_floor(100, 50, 0);
        assert!(r.is_err());
    }

    #[test]
    fn mul_div_ceil_basic() {
        assert_eq!(mul_div_ceil(7, 3, 2).unwrap(), 11); // 21/2 = 11 (ceil)
        assert_eq!(mul_div_ceil(100, 50, 10).unwrap(), 500);
    }

    #[test]
    fn signed_diff_bps_positive() {
        // (50 - 30) * 10000 / 100 = 2000
        assert_eq!(signed_diff_bps(50, 30, 100).unwrap(), 2000);
    }

    #[test]
    fn signed_diff_bps_negative() {
        // (30 - 50) * 10000 / 100 = -2000
        assert_eq!(signed_diff_bps(30, 50, 100).unwrap(), -2000);
    }

    #[test]
    fn signed_diff_bps_zero() {
        assert_eq!(signed_diff_bps(50, 50, 100).unwrap(), 0);
    }
}
