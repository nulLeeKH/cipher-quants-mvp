pub mod wad;

pub use wad::*;

// ============================================================================
// MATH MODULES
// ============================================================================
// Separate business logic (pricing, fees, curves) from instruction handlers.
// This enables:
//   - Unit testing math independently (Rust #[cfg(test)])
//   - Reuse across instructions
//   - AI can "fix the math" without touching instruction code
//
// To add a new math module:
//   1. Create a new file: math/my_math.rs
//   2. Add `pub mod my_math;` and `pub use my_math::*;` above
//
// wad.rs is included by default — a battle-tested fixed-point arithmetic
// library using 18-decimal WAD format (10^18). Use it for all DeFi math:
//   - to_wad(lamports) → WAD value
//   - from_wad_floor/ceil(wad) → lamports
//   - multiply_wad(a, b) → a * b in WAD (with u256 overflow protection)
//   - divide_wad(a, b) → a / b in WAD
//
// Rounding rules for protocol safety:
//   - User PAYS:    round UP   (ceil)  → protocol receives more
//   - User RECEIVES: round DOWN (floor) → protocol pays less
// ============================================================================
