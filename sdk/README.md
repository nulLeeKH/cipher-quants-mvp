# @cipher-quants/sdk

Typed TypeScript SDK for the **Cipher Quants Program** — Pinocchio-era port of
the on-chain protocol.

Mirrors `programs/protocol`. Consumed by the frontend (`app/`), keeper
(`keeper/`), API server (`api/`), and the Jest integration suite (`tests/`).

The SDK has **no `@coral-xyz/anchor` runtime dependency** — it ships its own
hand-rolled Borsh codecs plus an Anchor-shaped `Program` shim so the call sites
(`program.methods.X(args).rpc()`, `program.account.Y.fetch(addr)`,
`program.addEventListener(...)`) keep working unchanged.

## Install (workspace)

This is a `pnpm` workspace package. Inside the monorepo it is already linked.
Consumers import the same path:

```ts
import {
  createProgram,
  derivePoolState,
  createExecuteSwapIx,
  simulateSwap,
} from "@cipher-quants/sdk";
```

For external consumers (npm publish — not done yet):
`pnpm add @cipher-quants/sdk`.

## Build

```bash
pnpm sdk:build           # tsc → dist/
```

Output is CommonJS for Node / Jest / Deno-npm compatibility. ESM consumers
(Next.js bundler) interop fine. The Pinocchio-era SDK no longer ships an IDL,
so there's no prebuild step.

## Architecture

| Module          | Purpose                                                                                                |
|-----------------|--------------------------------------------------------------------------------------------------------|
| `program`       | `Program` shim (Anchor-shaped surface on top of the 1-byte-tag + Borsh dispatch), `AnchorProvider` / `Wallet` wrappers around `Connection` / `Keypair`, `createProgram`, `PROGRAM_ID`. |
| `borsh`         | Hand-rolled codecs — `Reader`, `Writer`, `encode*` per instruction, `decodePoolState` / `decodeQuoteNonceMarker` / `decodeAdminRotationProposal`. |
| `constants`     | On-chain mirror — PDA seeds (`POOL_SEED`, `VAULT_SEED`, `QUOTE_USED_SEED`, `ADMIN_PROPOSAL_SEED`), `MAX_TTL_SLOTS`, `PRICE_SCALE`, `BPS_DENOMINATOR`, recommended Mode TTLs (A=1, B=3, C=0). |
| `accounts`      | PDA derivation (`derivePoolState`, `deriveVault`, `deriveQuoteNonceMarker`, `deriveAdminProposal`) + fetch helpers (`fetchPoolState`, `fetchVaultBalances`) + `sortMints`. |
| `instructions`  | Per-instruction builders (`createInitPoolIx`, `createUpdateOracleIx`, `createExecuteSwapIx`, `createAdminWithdrawInventoryIx`, etc.) returning `TransactionInstruction` for compose-friendly use. |
| `quote`         | RFQ helpers — `serializeSignedQuoteMessage` (canonical 97-byte Borsh body), `buildSignedQuoteWithVerifyIx` (Ed25519 sign + prebuilt verify ix), `executeSwapWithVerify` wrapper. |
| `math/curve`    | Bit-for-bit TypeScript port of the on-chain linear-bps curve. `simulateSwap` for client-side preview. |
| `events`        | `parseEventsFromTx`, `parseEventsFromLogs`, `subscribeEvent`, `decodeEventLog` (base64+Borsh) + 10 typed event payloads. |
| `errors`        | `friendlyError(err)`, `errorCodeToMessage(code)`, `errorCodeToName(code)`. Used by the `sendAndConfirm` path to annotate `custom program error: 0x...` with the variant name. |

## Common flows

### 1. Init pool (admin one-shot)

```ts
import {
  BN,
  createProgram, sortMints,
  createInitPoolIx, MODE_C_TTL,
} from "@cipher-quants/sdk";

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
} from "@cipher-quants/sdk";

// Preview
const { address: poolState, state: pool } = await fetchPoolState(program, base, quote);
const { baseAmount, quoteAmount } = await fetchVaultBalances(program, poolState, base, quote);
const { outputAmount, price } = simulateSwap({
  fairValue: BigInt(pool.fairValue.toString()),
  spreadBps: BigInt(pool.spreadBps),
  depth: { /* … */ },
  skew: { /* … */ },
  reservesBase: baseAmount,
  reservesQuote: quoteAmount,
  inputAmount: 1_000_000n,
  direction: "sell",
});
showUser(`You'll receive ≈ ${outputAmount} USDC`);

// Send
try {
  const ix = await createExecuteSwapIx(program, { /* … */ });
  await provider.sendAndConfirm(new Transaction().add(ix));
} catch (err) {
  toast.error(friendlyError(err));
}
```

### 3. Router mint → Side conversion (Jupiter / RFQ webhook)

```ts
import { directionFromMints } from "@cipher-quants/sdk";

const direction = directionFromMints(inputMint, outputMint, baseMint, quoteMint);
// "buy" | "sell"
```

### 4. RFQ path (when curve is stale)

```ts
import {
  buildSignedQuoteWithVerifyIx, executeSwapWithVerify,
} from "@cipher-quants/sdk";

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
import { subscribeEvent } from "@cipher-quants/sdk";

const listenerId = subscribeEvent(program, "SwapExecuted", (data, slot, sig) => {
  console.log(`Swap @ slot=${slot}, mode=${data.mode}, price=${data.executionPrice}`);
});
// On shutdown: await program.removeEventListener(listenerId);
```

Events are emitted on-chain as `Program log: EVT:<base64>` lines whose payload
is `[1-byte tag][Borsh body]`. `decodeEventLog` / `parseEventsFromLogs` strip
the prefix, base64-decode, peel the tag, and Borsh-deserialize into one of the
typed payloads (`PoolInitializedData`, `SwapExecutedData`, …).

## Spec sync rules

- When `programs/protocol/src/error.rs` changes → update both
  `ERROR_CODE_NAMES` and `ERROR_CODE_MESSAGES` in `sdk/src/errors.ts`.
- When `programs/protocol/src/math/curve.rs` changes → update
  `sdk/src/math/curve.ts` in lockstep (bit-for-bit; covered by the SDK
  simulate-vs-on-chain parity test in `tests/protocol.test.ts`).
- When `programs/protocol/src/constants.rs` changes → update
  `sdk/src/constants/index.ts`.
- When a state struct gains a field → update the corresponding `decode*` in
  `sdk/src/borsh.ts` AND the `SIZE` constant in
  `programs/protocol/src/state/*.rs`. Mismatch yields `InvalidAccountData`
  on the on-chain side or a too-short-buffer error on the SDK side.
- When an instruction's args change → update the matching `encode*` in
  `sdk/src/borsh.ts` AND the `process(...)` decoder in the on-chain handler.
  The wire format is `[1-byte tag][Borsh args]`.

## Out of v1 scope

- ESM build (production dual-format via tsup / rollup).
- Subgraph-style indexer.
- Token-2022 extensions.
- Multi-pool batch ops.
- Codama-generated client (current SDK is hand-rolled; revisit after Shank
  IDL is in place).
