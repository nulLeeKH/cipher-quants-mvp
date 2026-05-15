use anchor_lang::prelude::*;

// ============================================================================
// Error Codes
// ============================================================================
// All custom error codes for the program.
//
// Keep this file in sync with CLAUDE.md's Error Codes table:
//   | Code | Name | Description |
//   |------|------|-------------|
//   | 6000 | MathOverflow | Arithmetic overflow |
//
// Naming convention: PascalCase, descriptive.
// Always include a #[msg("...")] with a human-readable description.
// ============================================================================

#[error_code]
pub enum ErrorCode {
    #[msg("Arithmetic overflow occurred.")]
    MathOverflow,

    #[msg("Math error occurred (division by zero or invalid operation).")]
    MathError,

    #[msg("Arithmetic underflow occurred.")]
    MathUnderflow,
}
