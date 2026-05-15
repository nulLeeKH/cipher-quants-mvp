// ============================================================================
// MATH MODULES
// ============================================================================
// docs/SPECIFICATION.md §2.2 — Linear-bps curve (u128 integer-ratio chosen).
// wad.rs is unused in v0 (kept for future rate-decay / dynamic-spread work).

pub mod curve;
pub mod signature;
pub mod wad;

pub use curve::*;
pub use signature::*;
pub use wad::*;
