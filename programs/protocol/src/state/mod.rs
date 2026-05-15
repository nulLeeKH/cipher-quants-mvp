// ============================================================================
// STATE (Account Structures)
// ============================================================================
// Each account type lives in its own file under state/.
//
// To add a new account:
//   1. Create a new file: state/my_account.rs
//   2. Add `pub mod my_account;` and `pub use my_account::*;` below
//   3. Update CLAUDE.md: Architecture section
//
// Account struct pattern:
//
//   #[account]
//   #[derive(InitSpace)]
//   pub struct MyAccount {
//       /// PDA bump seed for signing
//       pub bump: u8,
//       /// Authority who can modify this account
//       pub authority: Pubkey,
//       /// Some value stored on-chain
//       pub value: u64,
//   }
//
// For embedded structs (not standalone accounts):
//
//   #[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
//   pub struct EmbeddedData {
//       pub field: u128,
//   }
//
// Space calculation:
//   - 8 bytes discriminator (automatic with #[account])
//   - u8: 1, u16: 2, u32: 4, u64: 8, u128: 16
//   - Pubkey: 32, bool: 1
//   - [T; N]: N * size_of::<T>()
//   - Use #[derive(InitSpace)] to auto-calculate
// ============================================================================
