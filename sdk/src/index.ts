// ============================================================================
// @cipher-quants/sdk
// ============================================================================
// Typed SDK for the Cipher Quants Program (PropAMM-RFQ hybrid venue).
// On-chain spec: docs/SPECIFICATION.md
// Pinocchio-era port: drops @coral-xyz/anchor at runtime. The Program class
// exported below is a thin shim that exposes the Anchor-shaped surface
// (`program.methods.X(args).rpc()`, `program.account.Y.fetch(addr)`,
// `program.addEventListener(...)`) on top of a 1-byte tag + Borsh dispatch.
// ============================================================================

// Program shim + provider/wallet types.
export {
  AnchorProvider,
  IDL,
  PROGRAM_ID,
  Program,
  Wallet,
  createProgram,
  derivePoolStatePda,
  deriveVaultPda,
  deriveAdminProposalPda,
  sideToArg,
  type Protocol,
  type ProviderLike,
  type SideArg,
  type SignedQuoteArgIxArg,
  type WalletLike,
} from "./program.js";

// BN re-export (Anchor previously re-exported its own copy; we ship the
// upstream `bn.js` directly so callers don't need an extra import).
export { default as BN } from "bn.js";

// Constants.
export * from "./constants/index.js";

// PDA derivation + fetch helpers.
export * from "./accounts/index.js";

// Borsh codecs + raw encoders (in case callers want to build instructions
// without going through `program.methods`).
export {
  decodeAdminRotationProposal,
  decodePoolState,
  decodeQuoteNonceMarker,
  encodeAcceptAdmin,
  encodeAdminWithdrawInventory,
  encodeCancelAdminProposal,
  encodeCloseExpiredNonce,
  encodeExecuteSwap,
  encodeInitPool,
  encodeProposeAdmin,
  encodeRotateAdmin,
  encodeRotateOracleSigner,
  encodeSetPaused,
  encodeUpdateOracle,
  POOL_STATE_DISCRIMINATOR,
  QUOTE_NONCE_MARKER_DISCRIMINATOR,
  ADMIN_ROTATION_PROPOSAL_DISCRIMINATOR,
  INSTRUCTION_TAG_INIT_POOL,
  INSTRUCTION_TAG_UPDATE_ORACLE,
  INSTRUCTION_TAG_EXECUTE_SWAP,
  INSTRUCTION_TAG_SET_PAUSED,
  INSTRUCTION_TAG_ROTATE_ORACLE_SIGNER,
  INSTRUCTION_TAG_ROTATE_ADMIN,
  INSTRUCTION_TAG_ADMIN_WITHDRAW_INVENTORY,
  INSTRUCTION_TAG_CLOSE_EXPIRED_NONCE,
  INSTRUCTION_TAG_PROPOSE_ADMIN,
  INSTRUCTION_TAG_ACCEPT_ADMIN,
  INSTRUCTION_TAG_CANCEL_ADMIN_PROPOSAL,
  type AdminRotationProposalData,
  type DepthParamsData,
  type PoolStateData,
  type QuoteNonceMarkerData,
  type SkewParamsData,
} from "./borsh.js";

// Events.
export * from "./events.js";

// Errors / friendly mapping.
export * from "./errors.js";

// Instruction builders.
export * from "./instructions/index.js";

// Signed-quote helpers (RFQ path).
export * from "./quote.js";

// Curve simulator (frontend client-side).
export * from "./math/curve.js";
