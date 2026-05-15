// ============================================================================
// Program Initialization
// ============================================================================
// Creates a typed Anchor program instance for interacting with the on-chain program.
//
// Usage:
//   import { createProgram } from "@solana-boilerplate/sdk";
//   const program = createProgram(provider);
//
// After building the program with `anchor build`, generate types:
//   1. Copy IDL: cp target/idl/protocol.json sdk/src/idl/protocol.json
//   2. Generate types: anchor idl type target/idl/protocol.json -o sdk/src/idl/protocol.ts
//   3. Import and use the generated types here
// ============================================================================

// import { Program, AnchorProvider } from "@coral-xyz/anchor";
// import { Protocol } from "./idl/protocol.js";
// import IDL from "./idl/protocol.json";
//
// export function createProgram(provider: AnchorProvider): Program<Protocol> {
//   return new Program<Protocol>(IDL as any, provider);
// }
