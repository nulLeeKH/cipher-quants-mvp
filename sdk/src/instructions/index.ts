// ============================================================================
// SDK Instruction Builders
// ============================================================================
// Each on-chain instruction should have a corresponding SDK builder here.
// The builder returns a TransactionInstruction (not a signed transaction),
// allowing callers to compose multiple instructions into a single transaction.
//
// Pattern:
//
//   export interface MyInstructionParams {
//     user: PublicKey;
//     amount: BN;
//     // ... all required parameters
//   }
//
//   export async function createMyInstruction(
//     program: Program,
//     params: MyInstructionParams
//   ): Promise<TransactionInstruction> {
//     const myPda = getMyAddress(params.someId);
//
//     return await program.methods
//       .myInstruction(params.amount)
//       .accountsPartial({
//         user: params.user,
//         myAccount: myPda,
//         systemProgram: SystemProgram.programId,
//       })
//       .instruction();
//   }
//
// Benefits of returning instructions (not transactions):
//   - Batch multiple instructions into one transaction
//   - Simulate before sending
//   - Add priority fees
//   - Custom retry logic in keeper bots
// ============================================================================
