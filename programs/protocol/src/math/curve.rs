use crate::constants::{BPS_DENOMINATOR, PRICE_SCALE};
use crate::error::{ProtocolError, Result};
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
        .ok_or(ProtocolError::MathOverflow)?;

    let imbalance_bps: i64 = if total_value == 0 {
        0
    } else {
        let target_base_value =
            mul_div_floor(total_value, skew.target_base_bps as u64, BPS_DENOMINATOR)?;
        signed_diff_bps(target_base_value, current_base_value, total_value)?
    };

    // 2) skew_offset_bps (clamp by max_skew_offset_bps)
    let skew_offset_bps = {
        let raw = (imbalance_bps as i128)
            .checked_mul(skew.skew_coef_bps as i128)
            .ok_or(ProtocolError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR as i128)
            .ok_or(ProtocolError::MathError)?;
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
            .ok_or(ProtocolError::MathOverflow)?
            .checked_add(depth_bps)
            .ok_or(ProtocolError::MathOverflow)?,
        Side::Sell => skew_offset_bps
            .checked_sub(half_spread)
            .ok_or(ProtocolError::MathUnderflow)?
            .checked_sub(depth_bps)
            .ok_or(ProtocolError::MathUnderflow)?,
    };

    let bps_factor: i64 = (BPS_DENOMINATOR as i64)
        .checked_add(total_bps)
        .ok_or(ProtocolError::MathOverflow)?;
    if bps_factor <= 0 {
        return Err(ProtocolError::MathUnderflow.into());
    }

    // Rounding policy — always bias in the protocol's favour:
    //   Buy  (user pays quote, receives base): downstream output = input * PRICE_SCALE / price
    //        → minimise output ⇒ maximise price ⇒ CEIL price.
    //   Sell (user pays base, receives quote): downstream output = input * price / PRICE_SCALE
    //        → minimise output ⇒ minimise price ⇒ FLOOR price.
    // Downstream `output_amount` is FLOOR in both directions (execute_swap).
    // The half-spread used above is `spread_bps / 2` (integer truncation) — for
    // odd spread_bps this loses 1 bps of intended take. Use even spread_bps to
    // get exact symmetric take. See docs/SPECIFICATION.md §2.2 (Rounding rules).
    let price = match direction {
        Side::Buy => mul_div_ceil(fair_value, bps_factor as u64, BPS_DENOMINATOR)?,
        Side::Sell => mul_div_floor(fair_value, bps_factor as u64, BPS_DENOMINATOR)?,
    };
    Ok(price)
}

// ============================================================================
// Helpers
// ============================================================================

#[inline]
pub fn mul_div_floor(a: u64, b: u64, denom: u64) -> Result<u64> {
    if denom == 0 {
        return Err(ProtocolError::MathError.into());
    }
    let result = (a as u128)
        .checked_mul(b as u128)
        .ok_or(ProtocolError::MathOverflow)?
        .checked_div(denom as u128)
        .ok_or(ProtocolError::MathError)?;
    u64::try_from(result).map_err(|_| ProtocolError::MathOverflow.into())
}

#[inline]
pub fn mul_div_ceil(a: u64, b: u64, denom: u64) -> Result<u64> {
    if denom == 0 {
        return Err(ProtocolError::MathError.into());
    }
    let numer = (a as u128)
        .checked_mul(b as u128)
        .ok_or(ProtocolError::MathOverflow)?;
    let denom_u128 = denom as u128;
    let result = numer
        .checked_add(denom_u128 - 1)
        .ok_or(ProtocolError::MathOverflow)?
        / denom_u128;
    u64::try_from(result).map_err(|_| ProtocolError::MathOverflow.into())
}

#[inline]
pub fn signed_diff_bps(a: u64, b: u64, denom: u64) -> Result<i64> {
    if denom == 0 {
        return Err(ProtocolError::MathError.into());
    }
    let diff = (a as i128)
        .checked_sub(b as i128)
        .ok_or(ProtocolError::MathUnderflow)?;
    let scaled = diff
        .checked_mul(BPS_DENOMINATOR as i128)
        .ok_or(ProtocolError::MathOverflow)?
        .checked_div(denom as i128)
        .ok_or(ProtocolError::MathError)?;
    i64::try_from(scaled).map_err(|_| ProtocolError::MathOverflow.into())
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

    const FAIR: u64 = 100 * PRICE_SCALE;

    #[test]
    fn basic_no_depth_no_skew_balanced() {
        let depth = params_no_depth();
        let skew = skew_zero();
        let reserves_base = 100;
        let reserves_quote = reserves_base * FAIR / PRICE_SCALE;

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
        assert!(buy_price > sell_price);
    }

    #[test]
    fn zero_total_value_safe() {
        let depth = params_no_depth();
        let skew = skew_active(100, 500);
        let price = evaluate(FAIR, 0, &depth, &skew, 0, 0, 1, Side::Buy).unwrap();
        assert_eq!(price, FAIR);
    }

    #[test]
    fn depth_scales_with_size() {
        let depth = params_with_depth(2, 1_000_000, 100);
        let skew = skew_zero();
        let reserves_base = 1000;
        let reserves_quote = 1000 * FAIR / PRICE_SCALE;

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
        assert_eq!(price, FAIR * 9_996 / 10_000);
    }

    #[test]
    fn depth_capped() {
        let depth = params_with_depth(100, 1_000_000, 50);
        let skew = skew_zero();
        let reserves_base = 1000;
        let reserves_quote = 1000 * FAIR / PRICE_SCALE;

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
        assert_eq!(price, FAIR * 9_950 / 10_000);
    }

    #[test]
    fn skew_base_heavy_reduces_buy_price() {
        let depth = params_no_depth();
        let skew = skew_active(100, 500);

        let reserves_base = 200;
        let reserves_quote = 10_000;
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

        let reserves_base = 50;
        let reserves_quote = 25_000;
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
        let skew = skew_active(10_000, 100);

        let reserves_base = 1000;
        let reserves_quote = 0;
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
        let depth = params_with_depth(2, 1_000_000, 100);
        let skew = skew_zero();
        let reserves_base = 1000;
        let reserves_quote = 1000 * FAIR / PRICE_SCALE;

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
        assert_eq!(price, FAIR * 10_004 / 10_000);
    }

    #[test]
    fn exact_in_sell_uses_base_directly() {
        let depth = params_with_depth(2, 1_000_000, 100);
        let skew = skew_zero();
        let reserves_base = 1000;
        let reserves_quote = 1000 * FAIR / PRICE_SCALE;

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
        assert_eq!(price, FAIR * 9_996 / 10_000);
    }

    #[test]
    fn combined_spread_depth_skew() {
        let depth = params_with_depth(5, 1_000_000, 200);
        let skew = skew_active(50, 100);

        let reserves_base = 200;
        let reserves_quote = 10_000;
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

    #[test]
    fn mul_div_floor_basic() {
        assert_eq!(mul_div_floor(100, 50, 10).unwrap(), 500);
        assert_eq!(mul_div_floor(7, 3, 2).unwrap(), 10);
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
        assert_eq!(mul_div_ceil(7, 3, 2).unwrap(), 11);
        assert_eq!(mul_div_ceil(100, 50, 10).unwrap(), 500);
    }

    #[test]
    fn signed_diff_bps_positive() {
        assert_eq!(signed_diff_bps(50, 30, 100).unwrap(), 2000);
    }

    #[test]
    fn signed_diff_bps_negative() {
        assert_eq!(signed_diff_bps(30, 50, 100).unwrap(), -2000);
    }

    #[test]
    fn signed_diff_bps_zero() {
        assert_eq!(signed_diff_bps(50, 50, 100).unwrap(), 0);
    }
}
