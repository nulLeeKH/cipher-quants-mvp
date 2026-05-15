# @cipher-quants/sdk

Typed TypeScript SDK for the **Cipher Quants Program** — a Solana hybrid PropAMM-RFQ venue.

Mirrors `programs/protocol`. Used by Frontend (`app/`), Keeper (`keeper/`),
and integration tests.

## Install (workspace)

This is a workspace package. Inside the monorepo it is already linked via
`pnpm-workspace.yaml`. Consumers import directly:

```ts
import {
  createProgram,
  derivePoolState,
  createExecuteSwapIx,
  simulateSwap,
} from "@solana-boilerplate/sdk";
```

For external consumers (npm publish — not done yet): `pnpm add @cipher-quants/sdk`.

## Build

```bash
pnpm sdk:build           # tsc → dist/  (prebuild hook copies IDL automatically)
```

The build emits CommonJS for Node/Jest/Deno-npm compatibility. ESM consumers
(Next.js bundler) interop fine.

## Architecture

| Module | Purpose |
|---|---|
| `program` | `createProgram(provider)`, `PROGRAM_ID`, raw `IDL` |
| `constants` | On-chain mirror: PDA seeds, MAX_TTL_SLOTS, PRICE_SCALE, BPS_DENOMINATOR, recommended Mode TTLs (A=1, B=3, C=0) |
| `accounts` | PDA derivation (`derivePoolState`, `deriveVault`, `deriveQuoteNonceMarker`) + fetch helpers (`fetchPoolState`, `fetchVaultBalances`) + `sortMints` |
| `instructions` | 8 instruction builders (`createInitPoolIx`, `createUpdateOracleIx`, `createExecuteSwapIx`, ...) returning `TransactionInstruction` for compose-friendly use |
| `quote` | RFQ helpers — `serializeSignedQuoteMessage` (Borsh 97 bytes), `buildSignedQuoteWithVerifyIx` (Ed25519 sign + verify ix), `executeSwapWithVerify` wrapper |
| `math/curve` | Bit-for-bit TypeScript port of on-chain curve. `simulateSwap` for client-side preview |
| `events` | `parseEventsFromTx`, `parseEventsFromLogs`, `subscribeEvent` + 8 typed event names |
| `errors` | `friendlyError(err)`, `errorCodeToMessage(code)` — chain error → UI string |

## Common flows

### 1. Init pool (admin UI)

```ts
import { BN } from "@coral-xyz/anchor";
import {
  createProgram, sortMints, derivePoolState,
  createInitPoolIx, MODE_C_TTL,
} from "@solana-boilerplate/sdk";

const program = createProgram(provider);
const [base, quote] = sortMints(tslaxMint, usdcMint);
const ix = await createInitPoolIx(program, {
  admin: admin.publicKey,
  baseMint: base, quoteMint: quote,
  authorizedOracleSigner: workerKey.publicKey,
  initialFairValue: new BN(100_000_000),  // $100 × 1e6
  initialSpreadBps: 20,
  initialDepthParams: { depthCoefBps: 2, sizeUnit: new BN(1_000_000), maxDepthBps: 100 },
  initialSkewParams: { targetBaseBps: 5_000, skewCoefBps: 50, maxSkewOffsetBps: 100 },
  initialModeTtl: MODE_C_TTL,
});
```

### 2. User swap with client-side preview

```ts
import {
  fetchPoolState, fetchVaultBalances,
  simulateSwap, createExecuteSwapIx, friendlyError,
} from "@solana-boilerplate/sdk";

// Preview
const { address: poolState, state: pool } = await fetchPoolState(program, base, quote);
const { baseAmount, quoteAmount } = await fetchVaultBalances(program, poolState, base, quote);
const { outputAmount, price } = simulateSwap({
  fairValue: BigInt(pool.fairValue.toString()),
  spreadBps: BigInt(pool.spreadBps),
  depth: { ... },
  skew: { ... },
  reservesBase: baseAmount,
  reservesQuote: quoteAmount,
  inputAmount: 1_000_000n,
  direction: "sell",
});
showUser(`You'll receive ≈ ${outputAmount} USDC`);

// Send
try {
  const ix = await createExecuteSwapIx(program, { ... });
  await provider.sendAndConfirm(new Transaction().add(ix));
} catch (err) {
  toast.error(friendlyError(err));
}
```

### 3. Router mint → Side conversion (Jupiter webhook)

```ts
import { directionFromMints } from "@solana-boilerplate/sdk";

const direction = directionFromMints(inputMint, outputMint, baseMint, quoteMint);
// "buy" | "sell"
```

### 4. RFQ path (when curve is stale)

```ts
import {
  buildSignedQuoteWithVerifyIx, executeSwapWithVerify,
} from "@solana-boilerplate/sdk";

// Webhook side (RFQ engine)
const { signedQuote, verifyIx } = buildSignedQuoteWithVerifyIx(oracleSigner, {
  pool: poolState,
  user: userPubkey,
  direction: "sell",
  inputAmount: 1_000_000n,
  price: 100_000_000n,
  expirySlot: BigInt(currentSlot + 200),
  nonce: BigInt(Date.now() * 1000),
});

// Client side
const [verifyIxFinal, swapIx] = await executeSwapWithVerify(program, {
  ...swapParams, signedQuote, verifyIx,
});
const tx = new Transaction().add(verifyIxFinal).add(swapIx);
await provider.sendAndConfirm(tx, [user]);
```

### 5. Event subscription (admin dashboard)

```ts
import { subscribeEvent } from "@solana-boilerplate/sdk";

const listenerId = subscribeEvent(program, "SwapExecuted", (data, slot, sig) => {
  console.log(`Swap @ slot=${slot}, mode=${data.mode}, price=${data.executionPrice}`);
});
// On shutdown: program.removeEventListener(listenerId);
```

## Spec sync rules

- When `programs/protocol/src/error.rs` changes → update the mapping in `sdk/src/errors.ts`.
- When `programs/protocol/src/math/curve.rs` changes → update `sdk/src/math/curve.ts` in lockstep (bit-for-bit).
- When `programs/protocol/src/constants.rs` changes → update `sdk/src/constants/index.ts`.
- The IDL is copied automatically from `target/idl` → `sdk/src/idl` by `pnpm sdk:build` (prebuild hook).

## Out of v1 scope

- ESM build (production dual-format via tsup / rollup)
- Subgraph-style indexer
- Token-2022 extensions
- Multi-pool batch ops
