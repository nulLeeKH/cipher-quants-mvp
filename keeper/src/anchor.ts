// ============================================================================
// Anchor re-export shim
// ============================================================================
// Deno's `npm:@coral-xyz/anchor` ESM named-export resolution is fragile, so
// we explicitly load via createRequire (CommonJS) and re-export named members.
// Every keeper file imports from "./anchor.ts".

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// deno-lint-ignore no-explicit-any
const anchor: any = require("@coral-xyz/anchor");

export const BN = anchor.BN;
export const AnchorProvider = anchor.AnchorProvider;
export const Wallet = anchor.Wallet;
export const Program = anchor.Program;
export type Idl = ReturnType<typeof anchor.Idl>;

// Re-export type-only via runtime any → consumers declare proper types
// at usage sites if needed.
