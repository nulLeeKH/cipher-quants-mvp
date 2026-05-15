use anchor_lang::prelude::*;

// ============================================================================
// PDA Seeds
// ============================================================================
// Define PDA seed constants here. Using constants ensures consistency
// across instructions and makes seeds discoverable for AI agents.
//
// Pattern:
//   #[constant]
//   pub const MY_PDA_SEED: &[u8] = b"my_pda";
//
// Document each PDA in CLAUDE.md's PDA Seeds table:
//   | PDA Name | Seeds | Purpose |
//   |----------|-------|---------|
//   | MyPDA    | ["my_pda", key] | Description |
// ============================================================================

// ============================================================================
// Protocol Constants
// ============================================================================
// Define protocol-wide constants here (fee rates, limits, thresholds).
//
// Pattern:
//   pub const MAX_FEE_BPS: u16 = 10_000; // 100% in basis points
//
// Use #[constant] for values that should appear in the IDL.
// ============================================================================
