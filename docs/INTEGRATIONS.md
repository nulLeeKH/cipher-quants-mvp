# Integrations

> How external routers / aggregators plug into Cipher Quants. The on-chain
> program serves **two paths** through one `execute_swap` instruction:
>
> - **Curve path** (`signedQuote = null`) — runs when the oracle is fresh.
>   Permissionless AMM-style settlement. Routed via Jupiter **Metis**.
> - **RFQ path** (`signedQuote = Some`) — runs when the oracle is stale.
>   Requires a MM-signed ed25519 quote + a pre-image verify instruction.
>   Routed via **JupiterZ** (the RFQ overlay).
>
> One pool, one ix, two routing surfaces — they coexist because the curve-fresh
> check inside `execute_swap` decides which branch executes.

**Related**: [SPECIFICATION.md §3.3](SPECIFICATION.md#33-execute_swap) ·
[OPERATIONS.md §5](OPERATIONS.md#5-rfq-webhook) ·
[CORE.md §3](CORE.md#3-rfq-mm-algorithm)

---

## 1. Routing decision matrix

| Pool state                            | Recommended router | Path                | What hits the chain                                          |
|---|---|---|---|
| `current_mode_ttl > 0` AND `slot - last_oracle_update_slot ≤ ttl` | Jupiter Metis    | Curve               | `execute_swap(signedQuote=null)`                              |
| Curve stale (above false) OR Mode C (`ttl=0`)                     | JupiterZ webhook | RFQ                 | `[ed25519_verify_ix, execute_swap(signedQuote=Some)]`         |
| `paused == true`                                                  | —                | None                | All `execute_swap` calls reject with `PoolPaused (6203)`.    |

The api server publishes [`GET /freshness`](#23-freshness-side-channel) so
routers can read this state without parsing PoolState themselves.

---

## 2. JupiterZ webhook (RFQ path)

JupiterZ-compatible HTTP server in [`api/src/server.ts`](../api/src/server.ts).
Runs 24/7 with priority during the curve-stale window (Mode C / equity market
hours when the oracle isn't pushing).

### 2.1 Endpoints

| Method | Path           | Purpose                                                            |
|--------|----------------|--------------------------------------------------------------------|
| `POST` | `/quote`       | Unsigned price preview. MM does NOT commit here.                   |
| `POST` | `/swap`        | Maker last-look + ed25519 sign + serialized `VersionedTransaction`. |
| `GET`  | `/tokens`      | Supported `{address, symbol, decimals}` list.                      |
| `GET`  | `/health`      | Liveness (out of JupiterZ spec).                                   |
| `GET`  | `/metrics`     | Prometheus counters (bearer-guarded).                              |
| `GET`  | `/freshness`   | Routing signal (see §2.3).                                          |

### 2.2 Two-step flow (Maker last-look at `/swap`)

```
POST /quote { userPubkey, inputMint, outputMint, inAmount }
  → 200 { quoteId, inAmount, outAmount, price, fairValueAtQuote, expirySlot }
     // No feeBps: MM revenue = spread baked into price vs fairValueAtQuote.
     // Aggregators that want a bps figure compute it themselves:
     //   feeBps = abs(price - fairValueAtQuote) * 10_000 / fairValueAtQuote
  → 4xx: pre-sign reject (paused / curve-fresh / inventory)

POST /swap { quoteId, userPubkey }
  → 200 { quoteId, tx, lastValidBlockHeight, components }
     tx = base64( VersionedTransaction containing [
       setComputeUnitLimit(250_000),
       createAssociatedTokenAccountIdempotent × 2,   // first-time user safety
       ed25519_verify_ix,
       execute_swap_ix
     ])
     // User wallet deserialises, signs once (sole signer + fee payer), sends.
     // MM does NOT sign the tx; commitment lives inside verify_ix.data.
  → 4xx: Maker last-look reject (drift / curve-fresh / expired / inventory / paused)
```

Reject codes (see `OPERATIONS.md §5.3`):

| HTTP | Reason                                                |
|------|-------------------------------------------------------|
| 400  | Malformed body / bad pubkey / non-positive inAmount   |
| 403  | `/swap` userPubkey ≠ quoteId's bound user             |
| 404  | Unknown / expired `quoteId`                           |
| 409  | Pre-sign curve-fresh / `/swap` price-drift / curve become fresh |
| 410  | `/swap` quote past `expiry_slot`                      |
| 503  | Pool paused / inventory underflow                     |

### 2.3 `/freshness` side-channel

Cheap GET returning the routing state. Metis polls this; JupiterZ relies on
the standard `/quote` 409 response (curve is fresh → use Metis).

```json
{
  "fresh": false,
  "ttl": 3,
  "ttlRemainingSlots": 0,
  "ageSlots": 142,
  "lastOracleUpdateSlot": 12345678,
  "currentSlot": 12345820,
  "paused": false,
  "recommendedPath": "rfq"
}
```

`recommendedPath ∈ {curve, rfq, none}`. `none` = `paused`.

### 2.4 Fill-rate SLA

JupiterZ requires a rolling 95% fill rate. `/metrics` exposes the buckets:

```
cipher_swap_drift_reject_total
cipher_swap_inventory_reject_total
cipher_swap_curve_fresh_reject_total
cipher_swap_expired_reject_total
cipher_swap_paused_reject_total
cipher_swap_client_fail_total
cipher_swap_success_total / cipher_swap_requests_total
```

Combined reject rate must stay under 5% rolling 1h. `MM_MAX_DRIFT_BPS`
(default 50) is the dominant knob — raise for high-vol assets, lower for
tight pairs.

### 2.5 Validating the spec

The reference toolkit (`jup-ag/rfq-webhook-toolkit`) ships an OpenAPI
schema + integration tests. Run them against this server before Stage 3
mainnet (tracked in [TODO.md §3.3](../TODO.md)).

---

## 3. Jupiter Metis (Curve path)

Metis is Jupiter's main aggregating router. It routes through AMM-style
DEXes by composing instructions client-side. Our pool plugs in like any
other Jupiter DEX — Metis only needs:

1. Off-chain price simulator.
2. Instruction builder for the swap.
3. Pool/account discovery.
4. A signal for "is the pool currently routable" (curve fresh + not paused).

### 3.1 SDK surface for adapter authors

```ts
import {
  // Discovery
  derivePoolState,
  deriveVault,
  fetchPoolState,           // → { address, state }
  sortMints,                // base/quote ordering
  // Pricing (bit-identical to on-chain curve::evaluate)
  simulateSwap,
  PRICE_SCALE,
  // Instruction
  createExecuteSwapIx,      // signedQuote=null for curve path
} from "@cipher-quants/sdk";
```

### 3.2 Routability check

```ts
import { fetchPoolState } from "@cipher-quants/sdk";

const { state: pool } = await fetchPoolState(program, baseMint, quoteMint);
const curveAge = (await conn.getSlot("confirmed"))
  - pool.lastOracleUpdateSlot.toNumber();
const routable =
  !pool.paused &&
  pool.currentModeTtl > 0 &&
  curveAge <= pool.currentModeTtl;
```

Identical logic to the on-chain check in
[`execute_swap.rs:97-99`](../programs/protocol/src/instructions/execute_swap.rs#L97-L99).
Equivalent to `GET /freshness` returning `recommendedPath: "curve"`.

### 3.3 Quote simulation

```ts
const out = simulateSwap({
  fairValue: pool.fairValue,
  spreadBps: pool.spreadBps,
  depth: pool.depthCurveParams,
  skew: pool.inventorySkewParams,
  reservesBase: baseVaultAmount,
  reservesQuote: quoteVaultAmount,
  inputAmount,
  direction,           // "buy" | "sell"
});
```

Returns `{ price, outAmount }`. The on-chain ix recomputes the same value
at execution time; routers should pass `minOutput = floor(outAmount * (1 - slippage))`.

### 3.4 Instruction order

The curve path uses 9 positional accounts and **no remaining accounts**.
The RFQ path adds `quote_nonce_marker` as `remainingAccounts[0]` and
**requires the ed25519 verify ix immediately before `execute_swap` in the
same tx** (the Instructions sysvar is parsed on-chain to cross-check the
verify result).

Curve path:
```ts
const ix = await createExecuteSwapIx(program, {
  user, poolState, baseVault, quoteVault, userBaseAta, userQuoteAta,
  inputAmount, direction, minOutput,
  // signedQuote omitted ⇒ curve path
});
```

### 3.5 What happens if Metis routes when curve has just gone stale

The on-chain ix returns `NoFreshPriceSource (6300)`. The whole Metis route
fails. To avoid this, Metis adapters MUST re-check `routable` immediately
before submitting (slot can age in transit) or attach a `minOutput` low
enough that the user accepts the alternative aggregator route.

Conservative pattern: subtract 1 slot of safety from `currentModeTtl` when
deciding routability. Stricter: also drop the route if the oracle key has
been rotated very recently (admins can rotate without affecting state, but
operationally rotations correlate with downtime).

---

## 4. Standalone direct trading (no router)

When neither Jupiter integration is available (or Mode C with no JupiterZ
registration), the FE swap UI at [app/swap](../app/src/app/swap/page.tsx)
hits `/quote` → `/swap` directly. Same protocol as JupiterZ; the api
server doesn't distinguish callers.

---

## 5. Cross-reference

| Concern                         | Location                                            |
|---|---|
| On-chain settlement instruction | [SPECIFICATION.md §3.3](SPECIFICATION.md#33-execute_swap) |
| RFQ webhook reject policy       | [OPERATIONS.md §5.3](OPERATIONS.md#53-rejection-policy-v0-defaults) |
| Maker last-look mechanics       | [OPERATIONS.md §5.4](OPERATIONS.md#54-last-look-maker-side-reject-at-swap) |
| Curve algorithm                 | [CORE.md §2](CORE.md#2-curve-algorithm-linear-bps-quote-curve) |
| Mode transitions (when curve is fresh) | [CORE.md §1](CORE.md#1-operating-modes--keeper-bot-transitions) |
| Quote-signer vs oracle-signer split    | [SPECIFICATION.md §2.1](SPECIFICATION.md#21-poolstate), [§3.12](SPECIFICATION.md#312-rotate_quote_signer-admin) |
