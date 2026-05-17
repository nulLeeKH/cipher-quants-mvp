# DEPLOYMENT.md

> Pre-flight checklist and step-by-step procedure for taking Cipher Quants to
> devnet (Stage 2). Stops when devnet is live; ongoing operational runbooks
> live in [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) and
> [OPERATIONS.md](OPERATIONS.md).
>
> Scope: **Stage 2 (Devnet)** entry, run, and Stage 3 exit gates only.
> Mainnet hardening is a separate document, written after Stage 2 settles.

**Related**: [CLAUDE.md §Deployment Checklist](../CLAUDE.md) · [CORE.md](CORE.md) · [SPECIFICATION.md](SPECIFICATION.md) · [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md)

---

## 0. Stage gates (from CLAUDE.md)

| Gate | Criterion |
|---|---|
| **Stage 1 → 2 (entry)** | All 4 simulator policies running · mode-switch thresholds first-pass tuned · no new attack vectors uncovered or mitigation designed |
| **Stage 2 → 3 (exit)** | Devnet uptime ≥ 99 % · cancel priority confirmed to land on devnet · RFQ webhook p95 ≤ 250 ms · ≥ 4 weeks elapsed |

The Stage 1 work is research/backtest — DEPLOYMENT.md covers what happens
once Stage 1 deliverables are signed off and we move on-chain on devnet.

---

## 1. Known blockers before devnet

Audit of pre-deploy gaps. Each item lists the resolution; the current state
is **all green** for devnet entry. Items marked _"deferred"_ are tracked but
acceptable to ship past devnet *entry*; they block devnet *exit* (Stage 2 →
3) instead.

### 1.1 `devnet` Cargo feature ✅ resolved

Was: `programs/protocol/Cargo.toml` declared `devnet = []` and
`scripts/build.sh` wired `--features devnet`, but zero `#[cfg(feature =
"devnet")]` branches existed. Dead feature flag, source of config-skew
risk.

Resolution: removed the feature from `Cargo.toml` and dropped the
per-cluster branching from `build.sh`. The same `.so` ships to
localnet / devnet / mainnet. If divergent behaviour is ever needed,
re-introduce a feature and gate the actual code path in the same commit.

### 1.2 PriceSource architecture ✅ shipped (Pyth Hermes + composable wrappers)

Was: keeper's only price source was `MockPriceSource` — a random walk +
spike. Acceptable for localnet, but Stage 2 exit gates around
cancel-priority and `p95 ≤ 250 ms` can't be measured against random data.

Resolution: a layered `PriceSource` pipeline assembled by
[keeper/src/sources/factory.ts](../keeper/src/sources/factory.ts):

```
  primary (mock | pyth)
    └─► FailoverPriceSource (optional)  ←  multi-source priority
          └─► BasisAdjustedSource (optional)  ←  underlying → tokenized
                └─► keeper worker
```

Concrete pieces shipped:

- **`PythPriceSource`** ([sources/pyth.ts](../keeper/src/sources/pyth.ts)) — Pyth Hermes adapter with:
  - **SSE streaming** as the default transport (`PYTH_TRANSPORT=sse`),
    push-based and free of polling RTT. Polling kept as a fallback.
    Auto-reconnects with exponential backoff on disconnect.
  - **Staleness detection** — `now − publish_time > PYTH_MAX_STALENESS_SEC`
    tags the tick `stale`. Equity feeds will trip this after-hours by
    design; the worker holds Mode C.
  - **Halted/unknown handling** — `price ≤ 0` or `conf == 0` are tagged
    `halted`. The worker refuses to push.
  - **EMA option** (`PYTH_QUOTE_KIND=ema`) — Pyth-smoothed price, less
    reactive but more robust to single-publisher noise.
- **`BasisAdjustedSource`** ([sources/basis.ts](../keeper/src/sources/basis.ts)) —
  Pyth publishes the *underlying* (NYSE AAPL, native BTC). Tokenized
  assets (xStocks etc.) have a basis. The wrapper multiplies fair_value
  by `(10_000 + BASIS_ADJUSTMENT_BPS) / 10_000`. Default `0` is a no-op
  (correct for crypto pairs). When a dynamic basis feed becomes
  available, replace the constant — the worker code path is unchanged.
- **`FailoverPriceSource`** ([sources/failover.ts](../keeper/src/sources/failover.ts)) —
  Multi-source priority. `current()` walks the list and returns the
  first fresh tick; degrades to the least-bad available status if all
  are non-fresh. Wrapped above by composition (`cfg.fallback`).
- **`PriceTick.status`** — every tick now carries
  `"fresh" | "stale" | "halted" | "unknown"`. The worker refuses to push
  anything but `"fresh"`, and after 30 s of consecutive non-fresh ticks
  it force-downgrades to Mode C so RFQ takes over.

🟡 Still deferred until Stage 2 exit: a second concrete adapter (Finnhub
free / Yahoo unofficial — TODO.md §1). The Failover scaffold is in place
so adding one is a one-file change.

### 1.3 Two-step admin rotation ✅ resolved

Was: on-chain `propose_admin` / `accept_admin` / `cancel_admin_proposal`
were wired through the SDK and tested but not exposed in
`/admin/actions`. Admin-key recovery via multisig handoff was harder than
it should have been.

Resolution: `/admin/actions` now shows a "Rotate admin — 2-step
(recommended)" card above the single-step rotation. The card auto-fetches
the outstanding proposal (`adminRotationProposal.fetchNullable`) and
toggles between the propose form (when no proposal exists) and an
accept/cancel pair (when one does). `Accept` is gated to require the
connected wallet's pubkey to match `proposal.newAdmin`.

### 1.4 Priority fee on swap ✅ resolved

Was: `app/src/app/swap/page.tsx::submitSwap` built the tx without
`ComputeBudgetProgram.setComputeUnitPrice`. RFQ-path landing odds during
contested mainnet slots would have been worse than they need to be.

Resolution: a "Priority fee (µL/CU)" input next to "Slippage", defaulting
to `1 000` (safe devnet floor — `0` skips the ix entirely). Validated for
non-negative integers with a soft upper bound of `10 000 000` to catch fat
fingers. The compute-budget ix is prepended to the transaction only when
the user has opted into a non-zero fee.

### 1.5 `.env.example` completeness ✅ resolved

Was: `app/.env.example` lacked the JWT/admin-auth keys and didn't
document the standard Next.js `cp .env.example .env.local` flow.

Resolution: all three `.env.example` files now ship with a copy-target
comment header, secret-generation hints (`openssl rand -hex 32`), and a
complete enumeration of consumed env vars including the new
`PRICE_SOURCE` / `PYTH_FEED_ID` / `PYTH_HERMES_URL` /
`PRICE_SOURCE_POLL_MS` block in `keeper/.env.example`.

---

## 2. Pre-deployment checklist

Run top-to-bottom. Each check is binary and gated by a concrete command.

### 2.1 Code freeze

- [ ] Working tree clean: `git status` returns nothing untracked or staged.
- [ ] Target branch (`main`) is up to date with origin.
- [ ] No `TODO` / `FIXME` markers added since the last review
      (`grep -rn "TODO\|FIXME\|XXX\|HACK" --include="*.rs" --include="*.ts" programs/ sdk/ keeper/ api/ app/src/` baseline = the single hit in `keeper/src/commands/oracle.ts:18`, which references TODO.md §1).

### 2.2 Tests pass (96/96)

- [ ] `cargo test -p protocol --lib` — Rust unit suite, <1s.
- [ ] `pnpm test` — full integration (96 tests, ~110s, requires
      `solana-test-validator`).
- [ ] `cat test_result.json | jq '.numFailedTests'` returns `0`.

### 2.3 CU baseline current

- [ ] `pnpm cu:measure` — regenerates `docs/PERFORMANCE.md`.
- [ ] All instructions stay in the ✅ band (< 100k CU). Yellow/red flags
      block deployment until investigated.

### 2.4 Security audit verification

- [ ] Every handler still passes the safety checklist
      (`grep -rn "safety::verify_" programs/protocol/src/instructions/`
      returns ≥ 141 hits — the count established at the May 2026 audit;
      anything lower means a check was removed).
- [ ] No new `unsafe` blocks without `// SAFETY:` comments.
- [ ] `declare_id!` and `constants::PROGRAM_ID` agree (compile-time
      assertion in `lib.rs:24-37`; build failure means drift).
- [ ] `InstructionTag` enum values match dispatch literals (compile-time
      assertion in `lib.rs:46-64`).

### 2.5 Dependency locking

- [ ] `pnpm-lock.yaml` committed at repo root (workspace lockfile —
      individual packages don't need their own).
- [ ] `Cargo.lock` committed at repo root.
- [ ] `deno.lock` committed for `keeper/` and `api/`.

### 2.6 Build reproducibility

- [ ] `./scripts/build.sh mainnet` produces a `.so` whose SHA256 matches
      what we expect on disk:
      ```bash
      shasum -a 256 target/deploy/protocol.so
      ```
- [ ] Build is deterministic across two consecutive runs (same SHA).

---

## 3. Key management — generate before deploying

Four-tier key separation. Document each key's storage location and
recovery procedure **before** generating them.

| Tier | Key | Location | Funds | Used by |
|---|---|---|---|---|
| **0** Cold | Treasury / upgrade authority | Ledger or Squads multisig | High | `solana program deploy --upgrade-authority` |
| **1** Warm | Admin | Ledger or air-gapped laptop | None ongoing | `set_paused`, `rotate_*`, `admin_withdraw_inventory` |
| **2** Hot | Oracle / Quote signer (shared in v0) | Hosted KMS or `.env` on a single dedicated machine | None (signs only) | `update_oracle`, RFQ quote signing |
| **3** Payer | Fee payer | Anywhere; reuse admin in PoC | SOL for fees only | tx fee payments |

```bash
# Generate (run once, save outputs to secure storage immediately):
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/admin-devnet.json
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/oracle-devnet.json
# Treasury / upgrade-authority key: use Ledger, NOT a JSON file:
solana-keygen new --keypair usb://ledger --derivation-path "m/44'/501'/0'"
```

Each public key gets recorded in `docs/DEPLOYMENT_DEVNET.md` (created
post-deploy from this doc; tracks the actual addresses).

---

## 4. Program ID decision

The repo currently declares `3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy`.
**For devnet, decide:**

- **Option A — Keep the existing keypair** (`target/deploy/protocol-keypair.json`).
  Cheapest. The compile-time assertion in `lib.rs` already enforces
  consistency between `declare_id!` and `constants::PROGRAM_ID`.
- **Option B — Rotate to a fresh devnet-only keypair.** Cleaner separation
  from any future mainnet deploy.
  ```bash
  solana-keygen new -o target/deploy/protocol-devnet-keypair.json
  NEW_ID=$(solana address -k target/deploy/protocol-devnet-keypair.json)
  # Update BOTH:
  #   programs/protocol/src/lib.rs       declare_id!("$NEW_ID")
  #   programs/protocol/src/constants.rs PROGRAM_ID = from_str_const("$NEW_ID")
  #   scripts/validator-up.sh            PROGRAM_ID="$NEW_ID"
  #   scripts/measure-cu.sh              PROGRAM_ID="$NEW_ID"
  ```
- **Recommendation:** Option B. The 5-minute cost buys clean separation
  and avoids any accidental cross-cluster confusion.

After the decision, rerun §2.2 to confirm tests still pass.

---

## 5. Deployment procedure (devnet)

### 5.1 Pre-flight (one-time per devnet deploy)

```bash
# Point Solana CLI at devnet
solana config set --url devnet

# Fund the upgrade-authority key (≥ 5 SOL for deploy + buffer)
solana airdrop 5 <UPGRADE_AUTHORITY_PUBKEY> --url devnet
# (Devnet airdrop is rate-limited; QuickNode / Helius devnet faucets are
# the practical fallback.)
```

### 5.2 Build

```bash
./scripts/build.sh devnet    # label only; same .so for every cluster

# Record artifact hash:
shasum -a 256 target/deploy/protocol.so | tee deploy-devnet-$(date +%Y%m%d).sha256
```

### 5.3 Deploy

```bash
solana program deploy target/deploy/protocol.so \
  --program-id target/deploy/protocol-devnet-keypair.json \
  --upgrade-authority usb://ledger \
  --url devnet

# Verify:
solana program show <PROGRAM_ID> --url devnet
# Confirm: ProgramData address, Authority, Last deployed slot, Data length
```

### 5.4 Post-deploy configuration

Update the runtime configs (none of these are committed to git):

```bash
# Keeper
cd keeper && cp .env.example .env
#  - RPC_URL=https://api.devnet.solana.com (or Helius devnet endpoint)
#  - RPC_PROVIDER=helius-devnet
#  - ORACLE_WALLET_PATH=/path/to/oracle-devnet.json
#  - ADMIN_WALLET_PATH=/path/to/admin-devnet.json (or `usb://ledger`)
#  - PROGRAM_ID=<deployed-id>
#  - BASE_MINT / QUOTE_MINT: filled in after §6.1
#  - PRICE_SOURCE=pyth         # mock for smoke-only; pyth for real devnet runs
#  - PYTH_FEED_ID=<feed id>    # match the pool's underlying; see hermes
#                              # https://pyth.network/developers/price-feed-ids

# API server
cd ../api && cp .env.example .env
#  - same RPC_URL / PROGRAM_ID / mints
#  - QUOTE_SIGNER_WALLET_PATH=<same as oracle for v0>
#  - METRICS_AUTH_TOKEN=<openssl rand -hex 32>

# Frontend
cd ../app && cp .env.example .env.local
#  - NEXT_PUBLIC_CLUSTER=devnet
#  - NEXT_PUBLIC_RPC_URL=<devnet RPC>
#  - NEXT_PUBLIC_PROGRAM_ID=<deployed-id>
#  - NEXT_PUBLIC_BASE_MINT / NEXT_PUBLIC_QUOTE_MINT: from §6.1
#  - NEXT_PUBLIC_API_BASE_URL=https://api.devnet.cipherquants.xyz (or wherever)
#  - JWT_SECRET=<openssl rand -hex 32>  ← server-only, ≥ 16 chars
#  - ADMIN_CHALLENGE_EXP_MIN=5
#  - ADMIN_JWT_EXP_HOURS=1
```

---

## 6. Pool initialization

### 6.1 Create / source the mint pair

For devnet, the simplest path is to **create two SPL test mints** the
admin controls. Real xStocks devnet mints would be ideal but Backed
Finance doesn't publish a devnet faucet
([TODO.md §2](../TODO.md) tracks the production conversation).

```bash
# Create base + quote mints (6 decimals each, mimicking xStock/USDC):
spl-token create-token --decimals 6 --url devnet  # → BASE_MINT
spl-token create-token --decimals 6 --url devnet  # → QUOTE_MINT
spl-token create-account <BASE_MINT> --url devnet
spl-token create-account <QUOTE_MINT> --url devnet
spl-token mint <BASE_MINT>  1000000000 --url devnet   # 1B units (6dp = 1000.0)
spl-token mint <QUOTE_MINT> 1000000000 --url devnet
```

Verify `BASE_MINT < QUOTE_MINT` lexicographically (the SDK's `sortMints`
auto-handles this, but record the canonical order in your devnet doc).

### 6.2 `init_pool`

```bash
cd keeper && deno task init-pool
# Reads BASE_MINT / QUOTE_MINT / ADMIN_WALLET_PATH from .env
# Defaults: fair_value=$100, spread=20bps, depth/skew = PoC values, mode=C
```

Confirm via `deno task status`:
- `Pool address` matches PDA `[b"pool", base_mint, quote_mint]`
- `Mode TTL = 0` (starts in Mode C, waiting for inventory)
- `Paused = no`

### 6.3 Inventory deposit

```bash
# From the admin's ATAs into the pool vault PDAs.
# Use the frontend (/admin/inventory) or:
spl-token transfer <BASE_MINT>  500000000 <BASE_VAULT_PDA>  --url devnet
spl-token transfer <QUOTE_MINT> 500000000 <QUOTE_VAULT_PDA> --url devnet
```

Vault PDAs can be derived offline via the SDK's `deriveVault` helper.

---

## 7. Off-chain services bring-up

Order matters: API first (24/7), keeper second (writes), frontend last.

### 7.1 API server

```bash
cd api
deno task start          # foreground for first run
# or
deno compile -A --output api-server src/main.ts && ./api-server
```

Smoke check from another shell:
```bash
curl http://localhost:8080/health                # → "ok"
curl http://localhost:8080/tokens                # → base/quote mint list
curl -H "Authorization: Bearer $METRICS_AUTH_TOKEN" http://localhost:8080/metrics
```

### 7.2 Keeper

Start in Mode C (no push) to confirm the pool is wired before enabling
the loop:

```bash
cd keeper
deno task status         # confirms it can read pool state
deno task oracle         # begins the worker loop
```

The worker auto-decides modes; expect it to stay in C until the calendar
or RV thresholds promote it (or override via mock spike rate).

### 7.3 Frontend

```bash
cd app
pnpm build && pnpm start   # production build
# or
pnpm dev                   # dev mode for iteration
```

Open the deployed URL, connect wallet, and run the §8 smoke tests.

---

## 8. Post-deploy smoke tests

Each test must pass before declaring devnet "live." Failures roll back
to §7 / §6 / §5 depending on layer.

| # | Test | Pass criterion |
|---|---|---|
| 1 | `init_pool` event present | `PoolInitialized` event in tx logs at the init slot |
| 2 | Keeper push lands | `update_oracle` tx confirmed within 5 s of keeper start; nonce > 0 |
| 3 | Pool status reflects push | `deno task status` shows `Freshness: fresh (age=<TTL)` |
| 4 | Curve-path swap | `/swap` UI in Mode A/B → `SwapExecuted{mode:0}` event |
| 5 | RFQ-path swap | Force `MODE_C_TTL=0` (or wait), swap via UI → `SwapExecuted{mode:1}` + `quote_nonce_marker` PDA created |
| 6 | Replay rejection | Re-send the same RFQ tx → fails with `QuoteAlreadyUsed` |
| 7 | Slippage trip | Submit with tight `min_output` → fails with `SlippageExceeded`, no token movement |
| 8 | Pause | Admin pauses via `/admin/actions`; subsequent swap fails with `PoolPaused` |
| 9 | Unpause | Admin unpauses; swap succeeds again |
| 10 | `close_expired_nonce` | After `expiry_slot + 150` slots (~1 min), any signer closes the marker → rent refunded to closer |
| 11 | Admin rotation (2-step) | `propose_admin` → `accept_admin` → `AdminRotated` event; old admin's `set_paused` now fails with `UnauthorizedAdmin` |
| 12 | Event decoder parity | Frontend transaction history (`/api/history`) decodes all 10 event types without errors |

---

## 9. Monitoring (minimum for devnet)

| Signal | Source | Threshold |
|---|---|---|
| Keeper push success rate | `[oracle] push failed` log lines | < 1 % over 1 h |
| Keeper push cadence (Mode A) | `[oracle] mode A cycle overshoot` warnings | < 5 % |
| API `/quote` p95 latency | `/metrics` `cipher_quote_latency_ms{quantile="0.95"}` | ≤ 250 ms |
| API `/quote` inventory fail rate | `cipher_quote_inventory_fail_total / cipher_quote_requests_total` | < 5 % |
| Cancel priority effectiveness | Manual: race a stale RFQ vs a same-slot `update_oracle`; expect SwapExecuted with `mode:0` | Documented in stage exit |
| RPC error rate | Provider dashboard | < 0.5 % |

Set up Slack / PagerDuty wiring against these *before* the keeper starts
pushing. INCIDENT_RESPONSE.md §0 calls this out as a pre-incident
prerequisite.

---

## 10. Stage 2 → Stage 3 exit gates

After ≥ 4 weeks on devnet, verify all of the following:

- [ ] **Uptime ≥ 99 %** — keeper push interval respected; gaps logged with
      cause.
- [ ] **Cancel priority confirmed** — at least 3 documented instances of a
      stale RFQ being neutralised by a same-slot `update_oracle` (manual or
      adversarial-bot driven).
- [ ] **RFQ webhook p95 ≤ 250 ms** — measured continuously, not spot-checked.
- [ ] **Real PriceSource adapter shipped** — Finnhub free or Yahoo
      unofficial at minimum (§1.2).
- [ ] **Adversarial bot run completed** — at least one of the four
      policies in [OPERATIONS.md §9](OPERATIONS.md) was exercised against
      our devnet pool with measurable PnL deltas.
- [ ] **No outstanding SEV-1 incidents** in the past 14 days.
- [ ] **Backup & recovery drill** — admin pause executed end-to-end from a
      cold-key recovery path within 5 minutes (INCIDENT_RESPONSE §0).

Failing any gate → fix and extend the devnet run before promoting.

---

## 11. Rollback

For any post-deploy failure that requires reverting:

1. **Immediate (< 60 s):** `set_paused(true)` via the admin key.
   Procedure: [INCIDENT_RESPONSE.md §2 Step 1](INCIDENT_RESPONSE.md).
2. **Investigate:** capture tx signatures, log lines, and slot ranges
   before touching anything.
3. **Patch + redeploy:** `solana program deploy` with the same
   `--program-id` uploads a new `.so` in place. Upgrade authority is
   required (kept on Ledger / multisig).
4. **Verify + unpause:** re-run §8 smoke tests 1–6 before unpausing.

Devnet has no real funds, so the rollback bar is low — use the same
muscle memory you'll need for mainnet. The drill is the deliverable.

---

## 12. Sign-off

Devnet promotion is signed off by recording the following in
`docs/DEPLOYMENT_DEVNET.md` (created from this template after the deploy):

```
Cluster:           devnet
Program ID:        <pubkey>
Deploy slot:       <n>
Deploy tx:         <sig>
Program SHA256:    <hash>
Upgrade authority: <pubkey or "Ledger m/44'/501'/0'">
Admin pubkey:      <pubkey>
Oracle pubkey:     <pubkey>
BASE_MINT:         <pubkey>
QUOTE_MINT:        <pubkey>
Pool PDA:          <pubkey>
init_pool tx:      <sig>
Smoke tests:       1–12 ✅  <date>
Signed off by:     <name>  <date>
```

Once that file exists and §8 is green, devnet is live and the Stage 2 run
begins. Track Stage 2 → 3 progress against §10.
