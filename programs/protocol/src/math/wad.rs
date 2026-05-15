//! Fixed-point WAD arithmetic library for Solana on-chain programs.
//!
//! WAD = 10^18 precision. All DeFi math should use this format to avoid
//! floating-point non-determinism on-chain.
//!
//! Conversion flow:
//!   lamports (u64, 9 decimals) → WAD (u128, 18 decimals) → compute → WAD → lamports
//!
//! Uses manual u256 multiplication to prevent overflow in large value operations.

use anchor_lang::prelude::*;
use crate::error::ErrorCode;

pub const WAD: u128 = 1_000_000_000_000_000_000;
pub const TOKEN_DECIMALS: u32 = 9;

/// Converts a u64 (lamports, 9 decimals) to a WAD (18 decimals) fixed-point representation.
pub fn to_wad(n: u64) -> Result<u128> {
    (n as u128)
        .checked_mul(10u128.pow(TOKEN_DECIMALS))
        .ok_or_else(|| Error::from(ErrorCode::MathOverflow))
}

/// Multiplies two WAD values, returns a WAD result.
/// Uses manual u256 arithmetic to prevent overflow in large calculations.
pub fn multiply_wad(a: u128, b: u128) -> Result<u128> {
    let a_lo = a as u64;
    let a_hi = (a >> 64) as u64;
    let b_lo = b as u64;
    let b_hi = (b >> 64) as u64;

    let ll = (a_lo as u128) * (b_lo as u128);
    let lh = (a_lo as u128) * (b_hi as u128);
    let hl = (a_hi as u128) * (b_lo as u128);
    let hh = (a_hi as u128) * (b_hi as u128);

    let mut low = ll;

    let (mid, overflow1) = lh.overflowing_add(hl);
    let (low_add, overflow2) = low.overflowing_add(mid << 64);
    low = low_add;

    let mut high = hh;
    high = high.checked_add(mid >> 64).ok_or(ErrorCode::MathOverflow)?;
    if overflow1 {
        high = high.checked_add(1u128 << 64).ok_or(ErrorCode::MathOverflow)?;
    }
    if overflow2 {
        high = high.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
    }

    if high >= WAD {
        return Err(Error::from(ErrorCode::MathOverflow));
    }

    let quotient_hi = high / WAD;
    let remainder_hi = high % WAD;

    if quotient_hi > 0 {
        return Err(Error::from(ErrorCode::MathOverflow));
    }

    let result = if remainder_hi == 0 {
        low / WAD
    } else {
        let power_128_div_wad: u128 = 340282366920938463463u128;

        let part1 = remainder_hi.checked_mul(power_128_div_wad)
            .ok_or(ErrorCode::MathOverflow)?;

        let power_128_mod_wad: u128 = 374607431768211456u128;
        let numerator = remainder_hi.checked_mul(power_128_mod_wad)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_add(low)
            .ok_or(ErrorCode::MathOverflow)?;
        let part2 = numerator / WAD;

        part1.checked_add(part2).ok_or(ErrorCode::MathOverflow)?
    };

    Ok(result)
}

/// Same as multiply_wad but uses ceiling division instead of floor.
/// Use for fee calculations to ensure protocol always receives at least the minimum.
pub fn multiply_wad_ceil(a: u128, b: u128) -> Result<u128> {
    let a_lo = a as u64;
    let a_hi = (a >> 64) as u64;
    let b_lo = b as u64;
    let b_hi = (b >> 64) as u64;

    let ll = (a_lo as u128) * (b_lo as u128);
    let lh = (a_lo as u128) * (b_hi as u128);
    let hl = (a_hi as u128) * (b_lo as u128);
    let hh = (a_hi as u128) * (b_hi as u128);

    let mut low = ll;

    let (mid, overflow1) = lh.overflowing_add(hl);
    let (low_add, overflow2) = low.overflowing_add(mid << 64);
    low = low_add;

    let mut high = hh;
    high = high.checked_add(mid >> 64).ok_or(ErrorCode::MathOverflow)?;
    if overflow1 {
        high = high.checked_add(1u128 << 64).ok_or(ErrorCode::MathOverflow)?;
    }
    if overflow2 {
        high = high.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
    }

    if high >= WAD {
        return Err(Error::from(ErrorCode::MathOverflow));
    }

    let quotient_hi = high / WAD;
    let remainder_hi = high % WAD;

    if quotient_hi > 0 {
        return Err(Error::from(ErrorCode::MathOverflow));
    }

    let result = if remainder_hi == 0 {
        let numerator = low.checked_add(WAD.checked_sub(1).ok_or(ErrorCode::MathUnderflow)?)
            .ok_or(ErrorCode::MathOverflow)?;
        numerator / WAD
    } else {
        let power_128_div_wad: u128 = 340282366920938463463u128;

        let part1 = remainder_hi.checked_mul(power_128_div_wad)
            .ok_or(ErrorCode::MathOverflow)?;

        let power_128_mod_wad: u128 = 374607431768211456u128;
        let numerator = remainder_hi.checked_mul(power_128_mod_wad)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_add(low)
            .ok_or(ErrorCode::MathOverflow)?;

        let numerator_ceil = numerator.checked_add(WAD.checked_sub(1).ok_or(ErrorCode::MathUnderflow)?)
            .ok_or(ErrorCode::MathOverflow)?;
        let part2 = numerator_ceil / WAD;

        part1.checked_add(part2).ok_or(ErrorCode::MathOverflow)?
    };

    Ok(result)
}

/// Divides two WAD values, returns a WAD result.
pub fn divide_wad(a: u128, b: u128) -> Result<u128> {
    if b == 0 {
        return Err(Error::from(ErrorCode::MathError));
    }

    let integer_part = a.checked_div(b)
        .ok_or_else(|| Error::from(ErrorCode::MathError))?
        .checked_mul(WAD)
        .ok_or_else(|| Error::from(ErrorCode::MathOverflow))?;

    let remainder = a.checked_rem(b)
        .ok_or_else(|| Error::from(ErrorCode::MathError))?;

    let fractional_part = remainder.checked_mul(WAD)
        .ok_or_else(|| Error::from(ErrorCode::MathOverflow))?
        .checked_div(b)
        .ok_or_else(|| Error::from(ErrorCode::MathError))?;

    integer_part.checked_add(fractional_part)
        .ok_or_else(|| Error::from(ErrorCode::MathOverflow))
}

/// Converts a WAD value to lamports (9 decimals), rounding down (floor).
/// Use when user RECEIVES tokens (protocol-protective).
pub fn from_wad_floor(wad_value: u128) -> Result<u64> {
    let lamports_factor = 10u128.pow(TOKEN_DECIMALS);
    let lamports = wad_value.checked_div(lamports_factor).ok_or(ErrorCode::MathError)?;
    lamports.try_into().map_err(|_| ErrorCode::MathOverflow.into())
}

/// Converts a WAD value to lamports (9 decimals), rounding up (ceiling).
/// Use when user PAYS tokens (protocol-protective).
pub fn from_wad_ceil(wad_value: u128) -> Result<u64> {
    let lamports_factor = 10u128.pow(TOKEN_DECIMALS);
    let lamports = wad_value
        .checked_add(lamports_factor - 1)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(lamports_factor)
        .ok_or(ErrorCode::MathError)?;
    lamports.try_into().map_err(|_| ErrorCode::MathOverflow.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_wad() {
        let lamports = 1_000_000_000u64; // 1 SOL
        let result = to_wad(lamports).unwrap();
        assert_eq!(result, 1_000_000_000_000_000_000);
    }

    #[test]
    fn test_multiply_wad_basic() {
        let a = 2 * WAD;
        let b = 3 * WAD;
        let result = multiply_wad(a, b).unwrap();
        assert_eq!(result, 6 * WAD);
    }

    #[test]
    fn test_multiply_wad_large_values() {
        let a = 71_046_822_921_805_401_836u128; // ~71 WAD
        let b = 11_920_303_932_518_281_376u128; // ~12 WAD
        let result = multiply_wad(a, b);
        assert!(result.is_ok());
        let value = result.unwrap();
        assert!(value > 800 * WAD && value < 900 * WAD);
    }

    #[test]
    fn test_divide_wad_basic() {
        let a = 6 * WAD;
        let b = 2 * WAD;
        let result = divide_wad(a, b).unwrap();
        assert_eq!(result, 3 * WAD);
    }

    #[test]
    fn test_divide_wad_zero() {
        let result = divide_wad(100, 0);
        assert!(result.is_err());
    }

    #[test]
    fn test_from_wad_rounding() {
        // 1.5 SOL in WAD = 1_500_000_000_000_000_000
        let wad_value = 1_500_000_000_000_000_001u128; // slightly over 1.5 SOL

        let floor = from_wad_floor(wad_value).unwrap();
        let ceil = from_wad_ceil(wad_value).unwrap();

        assert_eq!(floor, 1_500_000_000); // rounds down
        assert_eq!(ceil, 1_500_000_001);  // rounds up
    }
}
