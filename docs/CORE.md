# CORE.md

> Operational reference for the Cipher Quants protocol — keeper-bot mode
> transitions, the on-chain quote curve, the RFQ market-maker algorithm, and
> the end-to-end order flow. For deeper material: protocol surface in
> [SPECIFICATION.md](SPECIFICATION.md), system structure in
> [ARCHITECTURE.md](ARCHITECTURE.md), operations and research methodology in
> [OPERATIONS.md](OPERATIONS.md).

---

## 0. One-line summary

> The settlement contract accepts **both** (a) an on-chain curve controlled by
> the MM and (b) a signed RFQ quote attached to the transaction. When the
> curve's freshness window (TTL) is alive, the curve price executes
> immediately and any attached quote is ignored; once the TTL lapses, the
> contract falls back to the signed quote. Which mode is active at any given
> moment is, in practice, decided by the **keeper bot toggling the on-chain
> TTL** in response to market conditions.

| | Curve path (PropAMM) | RFQ path |
|---|---|---|
| Price source | On-chain `pool.fair_value` + curve adjustments | API server computes per-request and ed25519-signs |
| Trigger | `curve_age ≤ TTL` (Mode A/B) | Otherwise (Mode C, or stale window in A/B) |
| Cancel priority | A same-slot `update_oracle` from the keeper neutralises stale quotes | One-shot nonce — no replay |
| Responsibility | Keeper (write) | API server (read + sign) |

---

## 1. Operating modes & keeper-bot transitions

### 1.1 Three-tier mode definition

| Mode | TTL (slots) | Push cadence | When |
|---|---|---|---|
| **A** Aggressive | 1 | 100–200 ms | High-vol windows (open/close, macro events) |
| **B** Light Hybrid | 3 | Threshold-triggered (RV or NBBO jump) | Normal trading hours |
| **C** RFQ Only | 0 | No push | Market closed / low-vol / holiday |

> TTL = 0 forces on-chain `curve_fresh` to always be false, so every order
> routes via RFQ. TTL > 0 enables the curve path whenever
> `slot_now - last_oracle_update_slot ≤ TTL`. This decision lives in
> [execute_swap.rs:97-99](../programs/protocol/src/instructions/execute_swap.rs#L97-L99)
> and also guards against fork rollback (`now < last_oracle_update_slot`).

### 1.2 Transition rules ([keeper/src/oracle/mode.ts](../keeper/src/oracle/mode.ts))

**Reactive decision**

```
upgradeSignal := (RV_bps > 150) OR (|NBBO_30s_move_bps| > 15)

C → B : upgradeSignal
B → A : upgradeSignal
A → B : 180 s quiet since the last upgrade trigger
B → C :  90 s quiet since the last upgrade trigger
```

**Cooldown.** No transition is allowed within `modeMinDwellMs = 30 s` of the
previous mode change. Without this, threshold chatter would oscillate the
mode on every tick.

**Calendar floor.** The US-equity schedule (xStocks target) acts as a *lower
bound* on the mode. The final mode is `max(reactive, calendar)`, so the
calendar can only **raise** the mode — it never demotes a volatility-driven
upgrade in the middle of a spike.

| ET window | Floor |
|---|---|
| Weekends / NYSE holidays | C |
| 09:00–10:00 (open ±30 min) | **A** |
| 15:30–16:30 (close ±30 min) | **A** |
| 09:30–16:00, other times | B |
| Everything else | C |

> The holiday list is hard-coded in
> [mode.ts:69-92](../keeper/src/oracle/mode.ts#L69-L92) for 2026–2027 and must
> be refreshed each year against the NYSE calendar. A stale list degrades to
> "we run a thin trading session in B/A on a holiday" — not a safety issue.

### 1.3 Keeper push loop ([keeper/src/oracle/worker.ts](../keeper/src/oracle/worker.ts))

```
loop:
  1. tick ← priceSource.current()                          # MockPriceSource (PoC)
  2. update rolling 30 s NBBO EMA (α = 0.2)
  3. nextMode ← decideMode(current, tick, …)
  4. if nextMode != currentMode:
       upgradeImminentUntil ← now + 800 ms        (on mode-up)
       pushOracle(nextMode)
     elif currentMode == A: pushOracle()           # push every cycle
     elif currentMode == B: if RV > 50 OR |move| > 5: pushOracle()
     elif currentMode == C: sleep
  5. sleep(intervalMs - elapsed)
     # ≥3 consecutive push failures → exponential backoff (capped at 30 s)
     # ≥5, then every 10 failures → re-sync nonce from chain
```

**Single-writer nonce.** `state.lastPushedNonce` is an in-memory counter,
seeded from on-chain nonce at boot, incremented on push success, untouched on
failure (so retries reuse the same nonce). When drift is suspected,
`resyncNonceFromChain()` re-reads the on-chain value.

**Cancel priority.** `ComputeBudgetProgram.setComputeUnitPrice` sets a
per-mode priority fee (`A = 50 000 µL/CU`, `B = 5 000`, `C = 0`). When a stale
quote and a fresh `update_oracle` land in the same slot, paying for the
oracle to be ordered first flips `curve_fresh` to true — and the stale quote
is then ignored on-chain by construction.

**Mode-A overshoot.** With `verbose=true`, the worker logs a warning if push
latency causes a 200 ms cycle to slip. Frequent overshoots are the signal to
upgrade RPC or move to Jito bundles.

---

## 2. Curve algorithm (Linear-bps quote curve)

### 2.1 Location and entry points

* Implementation: [programs/protocol/src/math/curve.rs](../programs/protocol/src/math/curve.rs)
* Call site: [execute_swap.rs:110-120](../programs/protocol/src/instructions/execute_swap.rs#L110-L120)
* SDK mirror (bit-identical, used by the frontend simulator): [sdk/src/math/curve.ts](../sdk/src/math/curve.ts)
* Design: a variant of the Drift v3 reservation-price. Integer-ratio u128 math, not WAD — see CLAUDE.md "On-Chain Math" for the rationale.

### 2.2 Inputs

| Field | Source | Meaning |
|---|---|---|
| `fair_value` | `pool.fair_value` (PRICE_SCALE = 1e6) | raw_quote_per_raw_base last pushed by MM |
| `spread_bps` | `pool.spread_bps` | Two-sided spread; `half = spread_bps / 2` |
| `depth_params` | `pool.depth_curve_params` | `{depth_coef_bps, size_unit, max_depth_bps}` |
| `skew_params` | `pool.inventory_skew_params` | `{target_base_bps, skew_coef_bps, max_skew_offset_bps}` |
| `reserves_base/quote` | `vault.amount` | Current inventory |
| `input_amount`, `direction` | User intent | ExactIn |

### 2.3 Evaluation steps

**Step 1 — normalise size into base units.**

```
size_base_equiv = (Buy)  input_amount * PRICE_SCALE / fair_value
                  (Sell) input_amount
```

On a Buy, `input_amount` is quote-denominated, so we convert to base before
charging the depth penalty (depth is always in base units to keep the
penalty curve consistent across directions).

**Step 2 — inventory imbalance as signed bps.**

```
current_base_value = reserves_base * fair_value / PRICE_SCALE     # in quote units
total_value        = current_base_value + reserves_quote
target_base_value  = total_value * target_base_bps / 10_000

imbalance_bps = (target_base_value - current_base_value) * 10_000 / total_value
              ↑ +ve = quote-heavy (base shortfall → MM wants to buy base → mid up)
              ↑ -ve = base-heavy  (base surplus   → MM wants to sell base → mid down)
```

If `total_value == 0` (right after init, or empty vaults), force
`imbalance_bps = 0` to avoid divide-by-zero.

**Step 3 — skew offset (i128 intermediate, then clamp).**

```
skew_raw        = imbalance_bps * skew_coef_bps / 10_000
skew_offset_bps = clamp(skew_raw, -max_skew_offset_bps, +max_skew_offset_bps)
```

**Step 4 — depth penalty (linear, capped).**

```
depth_raw = size_base_equiv * depth_coef_bps / size_unit
depth_bps = min(depth_raw, max_depth_bps)
```

**Step 5 — direction-aware composition.**

```
half_spread = spread_bps / 2

total_bps = (Buy)  skew_offset + half_spread + depth_bps
            (Sell) skew_offset - half_spread - depth_bps
```

Buy moves above the mid, Sell below. A positive skew (quote-heavy inventory)
raises both Buy and Sell prices — the mid itself shifts up.

**Step 6 — price.**

```
price = fair_value * (10_000 + total_bps) / 10_000
```

`(10_000 + total_bps) ≤ 0` returns `MathUnderflow`. The compile-time invariant
in `constants.rs` (`half_spread + max_depth + max_skew_offset < 10_000`)
guarantees this can't happen with valid parameters.

**Step 7 — output (floor).**

```
output = (Buy)  input_amount * PRICE_SCALE / price
         (Sell) input_amount * price / PRICE_SCALE
```

Floor rounding protects the protocol. `output < min_output` triggers
`SlippageExceeded`.

### 2.4 Recommended parameters

PoC defaults (init_pool):

```
spread_bps              = 20         (0.20 % two-sided)
depth_coef_bps          = 2          (2 bps per size_unit)
size_unit               = 1_000_000  (= 1.0 base at 6 decimals)
max_depth_bps           = 100        (1 %)
target_base_bps         = 5_000      (50/50)
skew_coef_bps           = 50         (1 % imbalance → 0.5 bp shift)
max_skew_offset_bps     = 100        (1 %)
```

Validator caps:

```
MAX_TTL_SLOTS         = 8
MAX_SPREAD_BPS        = 1_000  (10 %)
MAX_DEPTH_BPS         = 500    (5 %)
MAX_SKEW_OFFSET_BPS   = 500    (5 %)
```

---

## 3. RFQ MM algorithm

### 3.1 Responsibility split

| Component | Active hours | Role |
|---|---|---|
| **Keeper** | Mode A/B windows only | Pushes `update_oracle` (write) |
| **API server** | 24/7 | Serves `/quote` + ed25519-signs (read + sign) |

In PoC v0 both share the same oracle hot key. A future split introduces a
dedicated `quote_signer`.

### 3.2 `/quote` flow ([api/src/server.ts](../api/src/server.ts))

```
POST /quote { inputMint, outputMint, inAmount, userPubkey }

 1. Rate limit (1 s sliding window, 30 req/IP for /quote)
 2. Parse body; direction = directionFromMints(input, output, base, quote)
 3. fetchPoolState() to read current pair state
      - pool.paused == 1   → 503 "Pool is paused"
      - curve_fresh == true → 409 "Curve is fresh — use direct execute_swap"
 4. Price (v0 simplification — only spread/2 applied, depth/skew deferred to v1)
      half = spread_bps / 2
      price = (Buy)  fair_value * (10_000 + half) / 10_000
              (Sell) fair_value * (10_000 - half) / 10_000
      outAmount = (Buy)  inAmount * PRICE_SCALE / price
                  (Sell) inAmount * price / PRICE_SCALE
 5. Inventory pre-check — if vault balance < outAmount, 503
      (otherwise the user would burn fee + nonce only to hit
       InsufficientReserves on-chain)
 6. nonce = crypto.getRandomValues(8 bytes) → bigint LE
      (NOT Date.now()+Math.random(): same-ms collisions, attacker-predictable)
 7. expirySlot = currentSlot + QUOTE_VALID_WINDOW_SLOTS (default 200)
 8. Serialise SignedQuoteMessage (97 bytes, Borsh) and build the ed25519
    verify ix via Ed25519Program.createInstructionWithPrivateKey()
 9. Pre-derive quoteNonceMarker PDA, include in the response
10. Cache (quoteId → resp) — LRU 10 k entries, 5 min TTL
```

The response bundles `signedQuote`, `verifyIxBase64`, and `quoteNonceMarker`,
so the frontend can drop them straight into a transaction.

### 3.3 Signed-quote canonical layout (97 bytes)

```
offset  size  field
   0     32   pool             (Pubkey)
  32     32   user             (Pubkey)
  64      1   direction        (0 = Buy, 1 = Sell)
  65      8   input_amount     (u64 LE)
  73      8   price            (u64 LE, PRICE_SCALE units)
  81      8   expiry_slot      (u64 LE)
  89      8   nonce            (u64 LE)
```

[sdk/src/quote.ts:serializeSignedQuoteMessage](../sdk/src/quote.ts) ↔
[programs/protocol/src/state/quote.rs](../programs/protocol/src/state/quote.rs)
have a golden-byte parity test
([tests/protocol.test.ts:46](../tests/protocol.test.ts#L46)). If either side
drifts, the entire RFQ path is silently rejected on-chain — never change
either in isolation.

### 3.4 On-chain verification ([execute_swap.rs:121-158](../programs/protocol/src/instructions/execute_swap.rs#L121-L158))

```
When curve_fresh == false:
  signed_quote_opt is None             → NoFreshPriceSource
  sq.pool != pool_key                  → QuoteWrongPool
  sq.user != user_key                  → QuoteWrongUser
  sq.direction != args.direction       → QuoteDirectionMismatch
  sq.input_amount != args.input_amount → QuoteSizeMismatch
  now > sq.expiry_slot                 → QuoteExpired

verify_signed_quote_signature():
  parses the Instructions sysvar, finds an ed25519 verify ix in the same tx,
  byte-matches pubkey == authorized_oracle_signer, signature, and message
  bytes (math/signature.rs:62-160).

init_quote_nonce_marker():
  PDA seeds [b"quote_used", pool, nonce_le]
  CreateAccount CPI — if the marker already exists, system_program rejects
  with `account already in use` → translated to QuoteAlreadyUsed
  → permanent replay protection.
```

### 3.5 Quote lifecycle

```
issued (API signed, in-memory cache) ─────► used  or  expired
                                              │
                                              ├─ used: quote_nonce_marker PDA persists
                                              │  → close_expired_nonce can reclaim rent
                                              │    (when expiry_slot + SAFETY_BUFFER_SLOTS < now)
                                              │
                                              └─ expired: rejected on-chain;
                                                 API cache swept after 5 min TTL
```

`SAFETY_BUFFER_SLOTS` is 150 in production (~1 min) and 5 under the
`test-feature` cfg.

---

## 4. Order flow (end-to-end)

### 4.1 From user intent to settlement

```
[1] User opens /swap                                            (app/src/app/swap/page.tsx)
    - useCurveFreshness polls slot every 1.5 s
    - simulateSwap() (mirror of the on-chain curve) previews outAmount
    - User picks direction, inputAmount, slippage_bps

[2] Submit                                                       (swap/page.tsx:189)
    - freshness.isFresh == true → CURVE path
        buildIx = createExecuteSwapIx(signedQuote = null)
        tx = [executeSwap_ix]
    - freshness.isFresh == false → RFQ path
        POST /quote → { signedQuote, verifyIxBase64, quoteNonceMarker }
        Re-check expirySlot on the client (RTT may have made it stale)
        tx = [verifyIx, executeSwap_ix(signedQuote, marker)]

[3] sendTransaction()                                            (wallet adapter)

[4] On-chain dispatch                                            (programs/protocol/src/lib.rs)
    - 1-byte tag = 2 (ExecuteSwap) → instructions/execute_swap.rs::process

[5] Safety phase (verify_* helpers)                              (execute_swap.rs:55-82)
    signer / writable / owner / address / pda / token_mint / token_authority
    pool.paused == 0
    input_amount > 0

[6] Path decision                                                (execute_swap.rs:91-99)
    now = Clock::get().slot
    curve_fresh = (current_mode_ttl > 0)
               && now >= last_oracle_update_slot
               && now - last_oracle_update_slot <= current_mode_ttl

[7a] CURVE path
    price = curve::evaluate(fair_value, spread, depth, skew, reserves, input, dir)
    mode  = 0

[7b] RFQ path                                                    (execute_swap.rs:121-158)
    sq = args.signed_quote_opt.ok_or(NoFreshPriceSource)
    Six-way match against args (see §3.4)
    verify_signed_quote_signature() — Instructions sysvar cross-check
    init_quote_nonce_marker() — create the PDA (errors if it already exists)
    price = sq.price
    mode  = 1

[8] Compute output + slippage check                              (execute_swap.rs:161-169)
    output = mul_div_floor(input, PRICE_SCALE, price)  (Buy)
           = mul_div_floor(input, price, PRICE_SCALE)  (Sell)
    if output < min_output → SlippageExceeded

[9] Token transfers (direction-aware)                            (execute_swap.rs:181-206)
    Buy:  user_quote_ata → quote_vault  (user-signed)
          base_vault     → user_base_ata (pool PDA signs)
    Sell: user_base_ata  → base_vault   (user-signed)
          quote_vault    → user_quote_ata (pool PDA signs)

[10] Emit SwapExecuted event                                     (events.rs)
     Program log: EVT:<base64(0x03 || borsh_body)>
     Indexers and the frontend decode this for trade history.
```

### 4.2 Routing truth table

| Keeper mode | TTL | curve_age ≤ TTL? | signed_quote attached? | Result |
|---|---|---|---|---|
| A/B | >0 | Yes | (ignored) | **CURVE path** — quote is silently dropped |
| A/B | >0 | No | Yes | RFQ path |
| A/B | >0 | No | No | Rejected: `NoFreshPriceSource` |
| C | 0 | (always false) | Yes | RFQ path |
| C | 0 | (always false) | No | Rejected: `NoFreshPriceSource` |

Key invariant: **when the curve is fresh, the quote is always ignored**.
This is what makes cancel priority work — if the keeper lands its
`update_oracle` first in a contested slot, any stale RFQ attached to a
later swap in the same slot is ignored and the swap executes against the
new curve price instead. Even if the stale quote would be more favourable,
the protocol simply doesn't use it.

### 4.3 Protections at a glance

| Threat | Defence |
|---|---|
| Stale-quote sniping | TTL + cancel priority (Jito tip or compute-unit price) |
| RFQ replay | `quote_nonce_marker` PDA — one-shot, can never re-fire |
| Forked oracle push | `now >= last_oracle_update_slot` enforced on-chain |
| Quote forgery | ed25519 verify ix + Instructions sysvar cross-check |
| Oracle key compromise | `rotate_oracle_signer` (admin authority) |
| Admin key compromise | Two-step `propose_admin` / `accept_admin` + `ProposalStale` |
| Inventory exhaustion | `/quote` pre-check + on-chain `InsufficientReserves` |
| Slippage | Client `min_output` + on-chain `SlippageExceeded` |
| Arithmetic overflow | `checked_*` everywhere, u128/i128 intermediates, compile-time bps invariant |

---

## 5. Cross-reference

| Topic | CORE.md (this doc) | SPEC | ARCH | OPS |
|---|---|---|---|---|
| Mode definition | §1.1 | — | §0.2 | §1 |
| Mode-transition rules | §1.2 | — | — | §1.1, §2 |
| Keeper push loop | §1.3 | — | — | §4 |
| Curve formula | §2 | §2.2 | — | — |
| Curve parameters | §2.4 | §5 | — | — |
| RFQ quote layout | §3.3 | §2.3 | — | — |
| RFQ verification | §3.4 | §3.3 | — | — |
| Quote lifecycle | §3.5 | §3.8 | — | §5.3 |
| Order flow | §4.1 | §3.3 | §3 | — |
| Routing decision | §4.2 | §3.1 | — | §3.1 |
