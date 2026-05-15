// ============================================================================
// @cipher-quants/sdk
// ============================================================================
// Typed SDK for the Cipher Quants Program (PropAMM-RFQ hybrid venue).
// On-chain spec: docs/SPECIFICATION.md
// ============================================================================

export * from "./program.js";
export * from "./constants/index.js";
export * from "./accounts/index.js";
export * from "./events.js";
export * from "./errors.js";
export * from "./instructions/index.js";
export * from "./quote.js";
export * from "./math/curve.js";

// Re-export IDL types (consumer convenience)
export type { Protocol } from "./idl/protocol.js";
