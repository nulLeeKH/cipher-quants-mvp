// ============================================================================
// Anchor-shim re-exports
// ============================================================================
// Pre-migration this loaded `@coral-xyz/anchor` directly. The Pinocchio-era
// SDK ships its own Anchor-shaped Program / AnchorProvider / Wallet on top of
// the 1-byte-tag + Borsh dispatch, so we just forward those names here. Every
// keeper file already imports from "./anchor.ts" — no call-site churn needed.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// deno-lint-ignore no-explicit-any
const sdk: any = require("../../sdk/dist/index.js");

export const BN = sdk.BN;
export const AnchorProvider = sdk.AnchorProvider;
export const Wallet = sdk.Wallet;
export const Program = sdk.Program;
