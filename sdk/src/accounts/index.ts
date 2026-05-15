// ============================================================================
// PDA Derivation Helpers
// ============================================================================
// Provide helper functions for deriving PDA addresses used by the program.
// These should mirror the seeds defined in programs/protocol/src/constants.rs.
//
// Pattern:
//
//   import { PublicKey } from "@solana/web3.js";
//
//   const PROGRAM_ID = new PublicKey("your_program_id");
//
//   export function getMyAccountAddress(
//     someKey: PublicKey
//   ): PublicKey {
//     const [pda] = PublicKey.findProgramAddressSync(
//       [Buffer.from("my_seed"), someKey.toBuffer()],
//       PROGRAM_ID
//     );
//     return pda;
//   }
//
// Keep in sync with:
//   - programs/protocol/src/constants.rs (PDA seeds)
//   - CLAUDE.md PDA Seeds table
// ============================================================================
