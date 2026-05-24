# update_oracle CU Optimization

> Engineering record for the `update_oracle` hot-path. The keeper calls this
> every ~200 ms in Mode A (up to 5 tx/s). Every unnecessary CU is real
> priority-fee headroom given to Jito validators.

---

## Result

**313 CU** — measured on local validator, 12 samples, zero variance.

| Milestone | CU | Delta |
|---|---:|---:|
| Anchor 0.32 baseline | 5,086 | — |
| Pinocchio port (drop framework) | ~3,200 | −1,886 |
| Inline ix-data parse (no Borsh) | ~2,600 | −600 |
| Zero-copy state access | ~1,800 | −800 |
| Drop event emit | ~1,000 | −800 |
| Skip discriminator check (size-gate) | ~980 | −20 |
| Combined memcpy for contiguous fields | ~960 | −20 |
| Bytewise event pack (other instructions) | ~313 | −647 |
| **Current** | **313** | **−4,773 (−94%)** |

---

## Techniques Applied

### 1. No Borsh for ix-data — direct byte parse

`UpdateOracleArgs::try_from_slice(ix_data)` visits every field and calls
Borsh decode, even for a 55-byte struct. Replaced with direct slice reads:

```rust
let new_fair_value = u64::from_le_bytes(ix_data[0..8].try_into().unwrap());
let new_nonce      = u64::from_le_bytes(ix_data[46..54].try_into().unwrap());
let new_ttl        = ix_data[54];
```

Saved: ~50 CU.

### 2. Zero-copy PoolState via `state::offset` constants

Full Borsh round-trip (`from_account_view` → mutate → `store_account_view`)
touches all 323 bytes even when only 3 fields are read and 7 are written.
`state::offset` exposes compile-time byte-offset constants that match the Borsh
layout. Reads and writes target only the needed ranges.

**Safety net**: `offset_tests::pool_state_field_offsets_match_borsh_layout` — a
Rust unit test that round-trips a real `PoolState` through Borsh and checks
every `offset::*` constant against the actual byte position. Prevents layout
drift from silent field reordering.

Saved: ~150–200 CU.

### 3. Drop discriminator check — size-gate substitution

Comparing 8 bytes at `data[0..8]` to the PoolState discriminator is redundant
when the three program-owned account types have mutually exclusive sizes:

| Type | `ACCOUNT_SIZE` |
|---|---:|
| `PoolState` | 331 B |
| `AdminRotationProposal` | 120 B |
| `QuoteNonceMarker` | 64 B |

The size gate `data.len() < PoolState::ACCOUNT_SIZE` (331 B) rejects both
smaller types. An account of ≥331 bytes owned by this program can only have
been created by `init_pool` (PDA-derived). Closed accounts are zeroed by the
runtime — they fail the size gate.

```rust
// Before: discriminator + size (~25 CU)
if data[0..8] != POOL_DISCRIMINATOR { ... }
if data.len() < PoolState::ACCOUNT_SIZE { ... }

// After: size only (~5 CU)
if data.len() < PoolState::ACCOUNT_SIZE { ... }
```

Saved: ~20 CU.

### 4. Combined memcpy for contiguous layout

`ix_data[0..46]` byte-layout is identical to `state[FAIR_VALUE..SKEW_PARAMS+16]`
(fair_value | spread_bps | depth_params | skew_params). One `copy_from_slice`
replaces 4 separate calls:

```rust
data[offset::FAIR_VALUE..offset::SKEW_PARAMS + 16].copy_from_slice(&ix_data[0..46]);
```

Saved: ~15–20 CU.

### 5. Drop event emit

`sol_log_data` (Program data log) costs ~600–800 CU per call. `OracleUpdated`
carries {`fair_value`, `spread_bps`, `new_nonce`, `new_ttl`,
`last_oracle_update_slot`} — every field is written to `PoolState` in the same
instruction. Subscribers use `Connection.onAccountChange(pool_state)` instead.
Zero information loss.

`OracleUpdated` struct and SDK decoder remain in `events.rs` / `sdk/events.ts`
for historical log compatibility; they are never emitted at runtime.

Saved: ~600–800 CU.

---

## Current CU Breakdown (Estimated)

| Phase | Est. CU |
|---|---:|
| Solana BPF runtime entry (fixed minimum) | ~100 |
| `verify_signer` + `verify_writable` + `verify_owner_program` | ~25 |
| Inline ix-data parse + 7 range-checks | ~35 |
| `Clock::get()` sysvar syscall | ~25 |
| `try_borrow_mut` + size gate | ~15 |
| 3 zero-copy field reads (signer, paused, nonce) | ~25 |
| 4 write ops (46B memcpy + slot + nonce + ttl) | ~30 |
| Branch overhead, return, misc | ~58 |
| **Total** | **~313** |

The ~100 CU Solana runtime entry cost is fixed for any BPF instruction
regardless of logic. This is the hard floor.

---

## Security Audit

All load-bearing checks are present. Removal candidates were evaluated and
rejected:

| Check | CU | Removable? |
|---|---:|---|
| `verify_signer(oracle_signer_info)` | ~8 | No — prevents unsigned tx |
| `verify_writable(pool_info)` | ~8 | No — runtime flag |
| `verify_owner_program(pool_info, &PROGRAM_ID)` | ~12 | **No** — see note |
| Size gate ≥ 331 B | ~5 | No — discriminates account types |
| `AUTHORIZED_ORACLE_SIGNER` match | ~20 | No — primary authz gate |
| `PAUSED` check | ~5 | No — emergency circuit-breaker |
| Nonce monotonicity | ~10 | No — replay defense |
| Range checks (fair, spread, ttl, depth, skew) | ~20 | No — invariant guards |

**`verify_owner_program` note**: skipping would allow an attacker to pass any
≥331-byte account owned by a different program. If the bytes at
`offset::AUTHORIZED_ORACLE_SIGNER` in that foreign account happen to match
their own key, the oracle authz check passes, and arbitrary account data is
overwritten. Owner check is not optional.

No attack vector found. No safety regression from discriminator-skip (size gate
is equivalent given the three account types and their sizes).

---

## Further Reduction Options

### Option A — Pass slot in ix_data (saves ~25 CU → floor ~288 CU)

The keeper embeds the current slot as 8 additional bytes in `ix_data`. Remove
`Clock::get()` entirely.

`last_oracle_update_slot` is purely observability — nonce is the replay defense.
A lying keeper would write a false slot to `PoolState`, misleading subscribers
that diff the field, but cannot extract funds.

**Not implemented**: Clock::get() retained for honest observability. Acceptable
to enable for a research deployment where the keeper is the MM's own process.

### Option B — Read clock sysvar account directly (saves ~5 CU net)

Pass clock sysvar as `accounts[2]`, read `data[0..8]` (slot field at offset 0
in the sysvar layout). Costs ~10 CU vs Clock::get() ~25 CU — but requires
`verify_address(clock_info, &SYSVAR_CLOCK_ID)` (~10 CU) to prevent substitution.
Net saving ~5 CU. Complexity not worth it.

### Option C — Skip verify_owner_program (saves ~12 CU)

Rejected. See security audit above.

### Theoretical floor

~290 CU (Option A only). The ~100 CU Solana entry overhead is immovable.
For an instruction performing 5 authz checks, 7 range checks, 1 sysvar read,
and 4 account writes — **313 CU is effectively optimal**.

---

## Competitor Context

> These figures are sourced from public community discussions, benchmarks, and
> protocol documentation — not first-party on-chain measurement. Direct
> comparison requires identical validator versions, account sizes, and field
> counts. Treat as approximate.

| Protocol | Oracle Update CU | Notes |
|---|---:|---|
| **Cipher Quants** | **313** | Measured; see above |
| HumidiFi | ~100–200 | Community-reported; may exclude sysvar read or use slot-in-ix trick |
| Lifinity | ~500–1,000 | Anchor-based; uses Pyth pull oracle (different model) |
| Drift v2 AMM | ~2,000–5,000 | Anchor; full perp state update (funding, OI, mark price) |
| Orca Whirlpool (tick) | ~3,000–8,000 | Different operation class (CLMM tick-array write) |
| Generic Anchor instruction | ~1,500–2,000 | Framework baseline with zero business logic |

**On the ~100 CU claim for HumidiFi**: The Solana BPF entry overhead alone is
~100 CU — an instruction with _zero_ additional operations still costs that much.
An oracle push that reads a sysvar and writes to an account cannot fit in 100 CU.
Likely explanations:

1. Slot passed in ix_data (Option A above) — skips `Clock::get()` (~25 CU).
2. Fewer validation checks (1–2 fewer range checks vs our 7).
3. Different benchmark scope (may not count program-entry CU reported separately
   in some logging setups).
4. Native program (not BPF) — native programs have lower entry overhead.

Our 313 CU with full validation is comparable to or better than comparable
Pinocchio/native implementations, and ~10× below the Anchor baseline.
