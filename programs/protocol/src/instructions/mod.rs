// ============================================================================
// INSTRUCTION MODULES
// ============================================================================
// Each instruction handler lives in its own file. This enforces:
//   - Clear boundaries: AI modifies one file per instruction
//   - Safe refactoring: changes to one instruction can't break another
//   - Easy navigation: "modify deposit" → open deposit.rs
//
// To add a new instruction:
//   1. Create a new file: instructions/my_instruction.rs
//   2. Add `pub mod my_instruction;` and `pub use my_instruction::*;` below
//   3. Add the entry point in lib.rs
//   4. Update CLAUDE.md: Architecture section + PDA Seeds table
//
// Handler pattern (3-phase):
//
//   pub fn process_my_instruction(ctx: Context<MyInstruction>, args...) -> Result<()> {
//       // Phase 1: Validation & Calculation (immutable borrow scope)
//       let result = {
//           let state = &ctx.accounts.my_state;
//           require!(!state.is_paused, ErrorCode::Paused);
//           // ... all reads and math here
//           calculated_value
//       }; // immutable borrow ends
//
//       // Phase 2: CPIs (token transfers, mints, burns)
//       let signer_seeds = &[&[b"pda_seed", &[bump]][..]];
//       token::transfer(ctx.accounts.into_transfer_ctx().with_signer(signer_seeds), amount)?;
//
//       // Phase 3: State update (mutable borrow)
//       let state = &mut ctx.accounts.my_state;
//       state.value = result;
//
//       Ok(())
//   }
// ============================================================================
