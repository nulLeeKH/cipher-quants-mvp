# CLAUDE.md

> AI agent context file. Loaded automatically at the start of every Claude Code session.
> This is the project's "operating manual" for AI agents.

## Project Overview

**Cipher Quants Program** — a research project for a hybrid PropAMM-RFQ trading
system on Solana.

### One-line definition

> A hybrid venue where the settlement contract accepts BOTH (a) an on-chain
> curve controlled by the MM and (b) a signed RFQ quote attached to the
> transaction, and automatically switches between modes based on the **curve's
> freshness (TTL)**.

### Why this design matters

> **RFQ is the baseline; PropAMM's advantages (cancel priority, HFT-grade
> prices) only kick in during specific windows.** The oracle worker detects
> large moves (offline events or sudden price jumps) and switches to PropAMM
> mode *the instant* that happens; it falls back to RFQ once volatility calms
> down. Jupiter router integration is the end goal.

A **single-MM-operated venue** targeting tokenized RWAs (xStocks) and long-tail
assets. Not production — the output is research data, not a live product.

### Core design principles

1. **RFQ baseline + PropAMM intervention**. Existing hybrids are all RFQ-primary;
   this design is a *single-MM model where the MM toggles its own oracle based
   on a cost-benefit*. When the curve is fresh, the quote is *always* ignored —
   giving us both composability and cancel priority.
2. **TTL-based automatic mode switching** (cache hit/miss): `curve_age ≤ TTL` →
   curve, otherwise quote.
3. **Single MM (v1)**. Multi-MM is v3.
4. **No large-price-gap reject** — the oracle only updates on large moves, so a
   gap can be a legitimate signal. Defense against exploits comes from cancel
   priority (Jito tip-per-CU).

3-tier mode (full details in [docs/OPERATIONS.md](docs/OPERATIONS.md)):
- **A** Aggressive: TTL 1 slot, 100–200ms push cadence, high-volatility windows
- **B** Light Hybrid: TTL 3 slots, threshold-triggered push, normal trading
- **C** RFQ Only: TTL=0, no push, market closed / low-vol

### Tech Stack (locked)
- On-chain: Rust + **Pinocchio 0.11** (zero-dep Anza framework — replaces Anchor 0.32.1; rationale in [docs/ARCHITECTURE.md §0.1](docs/ARCHITECTURE.md)). SPL Token classic via `pinocchio-token`.
- SDK: TypeScript (CommonJS) — hand-rolled Borsh codecs + Anchor-shaped `Program` shim on top of the 1-byte-tag + Borsh dispatch (drops `@coral-xyz/anchor` at runtime). Instruction builders, RFQ quote serialize/verify, ed25519 prepend, curve simulate.
- Frontend: Next.js 14 + Solana Wallet Adapter — admin dashboard + user swap UI. **Mobile-first** (Tailwind responsive). English only. Wallet support: Phantom / Solflare / Backpack / **Ledger** / **Saga (Solana Mobile)** / Wallet Standard. Admin auth is a transaction-based challenge (Ledger-compatible, SIWS fallback).
- Keeper: **Deno** — *oracle pusher only* (calls update_oracle while Mode A/B is active).
- API server: **Deno + Hono** — RFQ webhook running 24/7 (especially during Mode C windows).
- Tests: Jest + ts-jest (drives `solana-test-validator` via `scripts/test.sh`; no `anchor test` orchestrator).

### Monorepo Layout
- `programs/protocol/` — on-chain settlement program (11 instructions: init_pool, update_oracle, execute_swap, set_paused, rotate_oracle_signer, rotate_admin, admin_withdraw_inventory, close_expired_nonce, propose_admin, accept_admin, cancel_admin_proposal)
- `sdk/` — TypeScript SDK (shared). Pinocchio-era port — no `@coral-xyz/anchor` runtime dep; exports an Anchor-shaped `Program` shim for back-compat.
- `app/` — Next.js frontend (admin + user UI). Screen breakdown in [docs/OPERATIONS.md §14](docs/OPERATIONS.md)
- `keeper/` — Deno oracle pusher. Only runs while Mode A/B is active.
- `api/` — Deno HTTP server (RFQ webhook, JupiterZ-compatible). 24/7.
- `tests/` — Integration tests (Jest, drives the SDK shim against a local validator).
- `TODO.md` — tracks external dependencies (data sources, Backed Finance, Jupiter integration split)

> **Keeper vs API server — responsibility split**:
> - Keeper     = write (pushes oracle via update_oracle). Active windows only.
> - API server = read + sign (issues RFQ quotes). 24/7. Currently shares the
>   oracle hot key (future: split into a dedicated quote_signer).

## Core Documentation

Three documents hold all spec / operational / research content. New collaborators
should read them in this order:

1. [docs/SPECIFICATION.md](docs/SPECIFICATION.md) — on-chain instructions, state, validation, error codes, constants. **Always read before implementing or modifying an instruction.**
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system components, data flow, account model, PDAs, module dependencies, comparative positioning, risks.
3. [docs/OPERATIONS.md](docs/OPERATIONS.md) — off-chain (price engine, oracle worker, RFQ webhook, inventory), mode-transition triggers, deployment cases, and the **research methodology (RQs + baseline policies + adversarial bot + measurement)**.
4. [docs/CORE.md](docs/CORE.md) — operational summary (mode transitions, curve algorithm, RFQ MM, order flow) — what to read for a single-doc overview.
5. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — pre-flight checklist + step-by-step procedure for devnet deployment (Stage 2).
6. [docs/INCIDENT_RESPONSE.md](docs/INCIDENT_RESPONSE.md) — on-call runbooks (SEV-1/2/3 playbooks, key-rotation procedures).
7. [docs/PERFORMANCE.md](docs/PERFORMANCE.md) — CU baseline (auto-generated by `pnpm cu:measure`).

[TODO.md](TODO.md) — external-dependency tracker (data sources, Backed Finance, Jupiter integration).

## Development Commands

```bash
# Build (BPF .so via cargo build-sbf — no anchor build)
./scripts/build.sh             # mainnet (default)
./scripts/build.sh devnet      # devnet features enabled
./scripts/build.sh localnet    # localnet

# Rust unit tests (host, ~0.1s; runs math + Borsh parity)
cargo test -p protocol --lib

# Integration tests (validator + jest)
pnpm test
pnpm test -- --testPathPattern="my_test.test.ts"  # specific test

# Check test results (structured JSON output)
cat test_result.json | jq '.numPassedTests, .numFailedTests'
cat test_result.json | jq '.testResults[].assertionResults[] | select(.status == "failed")'

# SDK
pnpm sdk:build
pnpm sdk:dev                   # watch mode

# Keeper / API
pnpm keeper:dev
pnpm api:dev

# Program logs (after tests)
grep "consumed" .anchor/validator.log
```

## Milestones

22-week (~5-month) phased plan. Operational + research detail in [docs/OPERATIONS.md](docs/OPERATIONS.md).

| Window     | Phase                              | Deliverable                                                                   |
|---|---|---|
| Week 1–2   | Infra setup                        | NBBO/RPC wiring, environment standup                                          |
| Week 3–6   | Core system                        | Settlement program (6 instructions) + 4 policy instances + adversarial bot     |
| Week 7–8   | Backtest pipeline                  | Simulator, ClickHouse ingestion                                               |
| Week 9–10  | **Stage 1 (Backtest)**             | First data pass, threshold tuning                                             |
| Week 11–12 | **Stage 2 (Devnet)** deployment    | Integration validation                                                        |
| Week 13–16 | Stage 2 run + Stage 3 prep         | Devnet data, mainnet capital deposit                                          |
| Week 17–20 | **Stage 3 (Mainnet small-scale)**  | Live data                                                                     |
| Week 21–22 | Final analysis + report            | Answers to 5 research questions                                               |

### Stage entry gates

**Stage 1 → 2**: All 4 simulator policies running, mode-switch thresholds tuned (first pass), no new attack vectors uncovered (or mitigation designed).
**Stage 2 → 3**: Devnet uptime ≥ 99%, cancel priority confirmed to land on devnet, RFQ webhook p95 ≤ 250ms.
**Stage 3 → final analysis**: At least 4 weeks of mainnet uptime, statistically significant cumulative volume, measurable per-policy PnL differences from the adversarial bot.

### Current phase (2026-05-17)

Spec v1 finalized → Pinocchio migration shipped → security audit closed →
devnet-ready (DEPLOYMENT.md §1 all green) → comprehensive test coverage in
place (416 tests across 5 runners: 26 Rust unit, 96 Jest integration, 129
keeper, 37 API, 64 SDK, 64 app). Next: actually deploy to devnet (Stage 2
entry) and run the 4-week soak per DEPLOYMENT.md §10.

## ⚠️ Critical Rules

- **Integration tests take ~100 s** (validator start → deploy → Jest 96 cases). Safe to run when the user is engaged; prefer `pnpm test:unit` (~3 s, no validator) for fast feedback during iteration. Always read `test_result.json` for structured failure output.
- **DO NOT use `anchor test` / `anchor build`.** The project is Pinocchio. Use:
  - `./scripts/build.sh [label]` (BPF build — wraps `cargo build-sbf`; the `<label>` argument is informational only, same `.so` for every cluster)
  - `pnpm test` (integration: `scripts/test.sh` — cargo build-sbf → validator-up → jest → validator-down)
  - `pnpm test:unit` (all unit suites — sdk + app jest + keeper + api deno tests; no validator)
  - `pnpm test:all` (everything: integration + every unit suite)
  - If you add `[features]` to `Cargo.toml`, update `scripts/build.sh` and `scripts/test.sh` to pass them.
- **DO NOT commit `.env` files.** They contain private keys.
- **DO NOT modify multiple instructions in one change.** One instruction per change, test, then move on.
- **ALWAYS use checked arithmetic** (`checked_add`, `checked_sub`, `checked_mul`, `checked_div`) for all on-chain math.
- **ALWAYS call the explicit safety helpers** (`safety::verify_signer`, `verify_owner_program`, `verify_pda_with_bump`, `verify_token_mint`, `verify_address`, `close_account`, …). Pinocchio has no `#[derive(Accounts)]` — every guarantee Anchor used to enforce must be written out by hand at the top of each instruction.
- **ALWAYS update this file** when changing architecture, PDA seeds, error codes, or test structure.

## Architecture

### Program Module Structure

```
programs/protocol/src/
├── lib.rs             # entrypoint + 1-byte-tag dispatch table
├── constants.rs       # PDA seeds, well-known program ids, protocol parameters
├── error.rs           # ProtocolError enum → ProgramError::Custom(u32)
├── events.rs          # Borsh + base64 event emit helpers (`Program log: EVT:<base64>`)
├── safety/            # Explicit checks (signer/owner/PDA/discriminator/token-mint/…)
│   └── mod.rs
├── instructions/      # One file per instruction; each defines `process(...)`
│   └── mod.rs
├── state/             # Borsh-encoded account structs + 8-byte discriminator + load/store
│   └── mod.rs
└── math/              # Pure logic (no Pinocchio types beyond Result aliases)
    ├── curve.rs       # Linear-bps quote curve evaluate
    ├── signature.rs   # Manual Instructions-sysvar parser for ed25519 cross-check
    ├── wad.rs         # 10^18 fixed-point (unused in v0, kept for future work)
    └── mod.rs
```

### Instruction Handler Pattern (Pinocchio era)

Each `instructions/X.rs` exposes:

```rust
pub fn process(
    _program_id: &Address,
    accounts: &mut [AccountView],
    ix_data: &[u8],
) -> ProgramResult {
    // 1. Parse args (Borsh).
    let args = MyArgs::try_from_slice(ix_data)
        .map_err(|_| ProtocolError::InvalidInstructionData)?;

    // 2. Destructure the account slice. `let [...] = accounts else { ... }`
    //    binds each element as `&mut AccountView`, which is what `set_lamports` /
    //    `try_borrow_mut` / `assign` need.
    let [admin_info, pool_info, _rest @ ..] = accounts else {
        return Err(ProtocolError::NotEnoughAccountKeys.into());
    };

    // 3. Spell out every Anchor guarantee explicitly via the safety helpers.
    verify_signer(admin_info)?;
    verify_writable(pool_info)?;
    verify_owner_program(pool_info, &PROGRAM_ID)?;
    // For PDA-derived accounts:
    // verify_pda_with_bump(pool_info, &[POOL_SEED, ...], pool.bump, &PROGRAM_ID)?;

    // 4. Load state (Borsh decode against the 8-byte discriminator).
    let mut pool = PoolState::from_account_view(pool_info)?;

    // 5. Validate business invariants. `require!` macro from Anchor is gone —
    //    use plain `if … { return Err(…) }`.
    if &pool.admin != admin_info.address() {
        return Err(ProtocolError::UnauthorizedAdmin.into());
    }

    // 6. Apply mutations and CPIs (pinocchio_system / pinocchio_token).
    pool.value = args.value;
    pool.store_account_view(pool_info)?;

    // 7. Emit observability log (events.rs).
    emit_pool_paused_changed(&PoolPausedChanged { … });

    Ok(())
}
```

The dispatcher in `lib.rs` matches the first byte of `instruction_data` (`InstructionTag::*` enum) and routes to the right `process(...)`. The SDK's `program.methods.X(args).rpc()` shim Borsh-encodes the args and prepends the right tag.

### Solana Account Model (Key Concept)

Unlike EVM where contract = logic + state, Solana separates them:
- **Program** = logic only (read-only, executable)
- **Account** = state only (data storage, owned by a program)

When defining instructions, explicitly specify which accounts are read vs written.

## PDA Seeds

> Full design rationale in [docs/ARCHITECTURE.md §5](docs/ARCHITECTURE.md#5-pda-seed-design).

| PDA                  | Seeds                                          | Stored bump                          | Purpose                                                                  |
|---|---|---|---|
| `pool_state`         | `[b"pool", base_mint, quote_mint]`                             | `PoolState.bump`                  | Unique pool state per pair                                                                         |
| `base_vault`         | `[b"vault", pool_state, base_mint]`                            | `PoolState.base_vault_bump`       | Pool's base-token vault                                                                            |
| `quote_vault`        | `[b"vault", pool_state, quote_mint]`                           | `PoolState.quote_vault_bump`      | Pool's quote-token vault                                                                           |
| `quote_nonce_marker` | `[b"quote_used", pool_state, nonce_le_bytes]`                  | `QuoteNonceMarker.bump`           | Blocks RFQ quote replay (one-shot marker, closeable after expiry)                                  |
| `admin_proposal`     | `[b"admin_proposal", pool_state]`                              | `AdminRotationProposal.bump`      | One-shot record for the 2-step admin rotation (propose → accept)                                   |

Invariants:
- `base_mint < quote_mint` (lexicographic ordering enforced) → prevents duplicate pools.
- `quote_nonce_marker` is manually `create_account`-forced only in the RFQ path of `execute_swap` (the `system_program::create_account` CPI fails if the marker exists) → replay blocked. Reclaimable via `close_expired_nonce` once `expiry_slot + SAFETY_BUFFER_SLOTS < now`.
- `admin_proposal` is created by `propose_admin` and closed (rent reclaimed) by `accept_admin` or `cancel_admin_proposal`. Only one outstanding proposal per pool at a time.

## Important Implementation Notes

### On-Chain Math: Two Approaches

This boilerplate provides **two math approaches**. Choose based on your protocol:

#### 1. u128 Integer-Ratio Math (for AMM proportional calculations)

For proportional calculations like `amount * supply / reserve`, `fee * amount / 10000`,
or any integer-ratio math, use u128 intermediates with `checked_*` operations:

```rust
// Proportional: u128 intermediates
let lp_tokens = (amount_a as u128)
    .checked_mul(lp_supply as u128)?
    .checked_div(reserve_a as u128)? as u64;

// Ceil division for fees
let fee = ((amount_in as u128)
    .checked_mul(fee_rate_bps as u128)?
    .checked_add(9999)?
    .checked_div(10000)?) as u64;
```

#### 2. WAD Fixed-Point Math (for rate-based protocols)

`math/wad.rs` provides 10^18 fixed-point arithmetic for protocols needing fractional precision
(compound interest rates, price oracles, lending protocols):

```rust
use crate::math::wad::*;

let wad_value = to_wad(lamports)?;           // u64 → u128 WAD
let result = multiply_wad(a_wad, b_wad)?;     // WAD × WAD → WAD
let lamports = from_wad_floor(wad_value)?;    // WAD → u64 (round down)
let lamports = from_wad_ceil(wad_value)?;     // WAD → u64 (round up)
```

> **Which to use?** Check `docs/SPECIFICATION.md` — it specifies the math approach for this project.
> AMM (constant product) → u128 integer-ratio. Lending/oracle → WAD.
>
> **Decision for this project (2026-05-15)**: the v0 curve is a **Linear-bps quote curve** (a Drift v3 reservation-price variant) → **u128 integer-ratio chosen**. Summing in `bps` is a natural integer ratio, and `fair_value` is an externally-anchored integer, so WAD's cumulative-precision advantage isn't needed. `math/wad.rs` is preserved for future rate-decay / implied-vol-driven dynamic-spread work.

### Rounding Rules (Protocol Safety)

| Situation | Direction | Reason |
|-----------|-----------|--------|
| User **pays** | ceil (round up) | Protocol receives more |
| User **receives** | floor (round down) | Protocol pays less |
| Fee calculation | ceil (round up) | Protocol collects at least minimum |
| LP token issuance | floor (round down) | User receives less |

### Compute Unit (CU) Budget

- Default: 200,000 CU per instruction
- Check after implementing: `grep "consumed" .anchor/validator.log`
- If over budget: split into multiple instructions or optimize math

## Testing

### Seed ID Ranges

To prevent PDA collisions in parallel tests, each test file uses a unique seed
range. New test files should use the `setupPool(ctx, seedId)` helper from
`tests/helpers/setup.ts`, which creates a fully-initialized, isolated pool
with fresh keys / mints / vaults / ATAs.

| Test File           | Seed Range | Description                                  |
|---------------------|------------|----------------------------------------------|
| protocol.test.ts    | (legacy)   | Global shared pool (order-dependent)         |
| *.test.ts (new)     | 100–199    | First new feature suite                      |
| *.test.ts (new)     | 200–299    | Second new feature suite                     |
| ...                 | +100 each  | Add a block per file                         |

Why this still matters with `setupPool`: PDA collision is already prevented
because each call generates fresh random mints, but the seedId is the
canonical knob for deterministic logging and `--testNamePattern` filtering.

### Test Helper Functions

- `setupTestContext(seedId)` — Creates provider, program, funded payer
- `getOrCreateATA(provider, mint, owner, payer)` — Gets or creates Associated Token Account

### Debugging Failed Tests

1. Run tests: `pnpm test`
2. Check results: `cat test_result.json | jq '.testResults[].assertionResults[] | select(.status == "failed")'`
3. Fix based on structured error messages
4. Repeat

## Error Codes

> Authoritative list in [docs/SPECIFICATION.md §4](docs/SPECIFICATION.md#4-error-codes). Keep code in `programs/protocol/src/error.rs` in sync.

Categories:
- `60xx` — math (overflow / underflow / div0)
- `61xx` — input validation (mint pair, TTL, fair_value, spread, size, oracle signer key, new admin, proposal stale)
- `62xx` — authorization & state (oracle/admin signer, nonce monotonic, paused)
- `63xx` — pricing source (curve stale + no quote, quote invalid, replay-used)
- `64xx` — execution (slippage, insufficient reserves)
- `65xx` — account / nonce lifecycle / safety helpers (wrong PDA / owner / discriminator / token mint / signer flag / writable / size / address / unknown ix / invalid ix data / not enough keys)

## Security Checklist

### AI Can Detect
- ✅ Missing `checked_*` arithmetic
- ✅ Missing access control (Signer verification)
- ✅ Missing input validation (amount > 0, valid ranges)
- ✅ PDA seed/bump mismatches
- ✅ Missing account ownership checks

### Human Must Verify
- ⚠️ Economic attack vectors (sandwich attacks, oracle manipulation)
- ⚠️ Multi-instruction state manipulation
- ⚠️ Flash loan vulnerabilities
- ⚠️ MEV (Miner Extractable Value) exposure
- ⚠️ Business logic correctness (does the math make economic sense?)

### Pinocchio safety checklist (replaces Anchor's `#[derive(Accounts)]`)

Anchor used to auto-generate signer/owner/PDA/discriminator/has_one checks from the
`#[derive(Accounts)]` macro. Pinocchio has nothing of the kind. The
`programs/protocol/src/safety/mod.rs` module exposes one helper per check —
**every instruction handler must call the relevant subset explicitly**:

| Anchor constraint          | Pinocchio equivalent                                                |
|----------------------------|---------------------------------------------------------------------|
| `Signer<'info>`            | `safety::verify_signer(info)`                                       |
| `#[account(mut)]`          | `safety::verify_writable(info)` + use `&mut AccountView` for writes |
| `#[account(owner = X)]`    | `safety::verify_owner_program(info, &X)`                            |
| `#[account(address = X)]`  | `safety::verify_address(info, &X)`                                  |
| `#[account(seeds=…, bump)]`| `safety::verify_pda_with_bump(info, &[seeds], bump, &PROGRAM_ID)`   |
| 8-byte discriminator       | `PoolState::from_account_view(info)` (decode rejects mismatched tag)|
| `token::mint = X`          | `safety::verify_token_mint(info, &X)`                               |
| `token::authority = X`     | `safety::verify_token_authority(info, &X)`                          |
| `#[account(close = dest)]` | `safety::close_account(account, destination)`                       |

Missing any of these is silently exploitable — no compile error, no runtime panic.
Code reviewers should grep new handlers for every account they consume and confirm
each has the matching safety call.

### Known False Positives

- ✅ Placeholder program ID (`11111…1`) historical concern — current
  declare_id is `3br2wCs…NxNMy` and a compile-time `const _: () = assert!`
  in `lib.rs` enforces parity with `constants::PROGRAM_ID`. Rotate before
  mainnet per DEPLOYMENT.md §4.
- ✅ Broad dependency versions (Next.js `^14.0.0`) — `pnpm-lock.yaml` is
  committed at the workspace root; runtime versions are locked.
- ✅ Keeper with `-A` flag — only used for `deno compile`. Long-running tasks
  use narrowly-scoped permissions (see `keeper/deno.json` tasks).

## Deployment Checklist

Before deploying to devnet/mainnet, verify:

### 1. Program ID (CRITICAL)
```bash
# Current state (committed):
solana_address::declare_id!("3br2wCsENbm6GfH3cfJVzZK5GKWNJZBD6oEX2rMNxNMy");

# If rotating to a new keypair:
cargo build-sbf                                  # Generates target/deploy/protocol-keypair.json
solana address -k target/deploy/protocol-keypair.json
# Copy the new address into BOTH:
#   programs/protocol/src/lib.rs   (declare_id!)
#   programs/protocol/src/constants.rs (PROGRAM_ID)
# OR use a vanity address:
solana-keygen grind --starts-with ABC:1
```

### 2. Dependency Locking
```bash
# Lock versions for reproducible builds
pnpm install          # Generates pnpm-lock.yaml (commit this!)
cd app && pnpm install
cd sdk && pnpm install
```

### 3. Build Configuration
```bash
./scripts/build.sh mainnet                      # cargo build-sbf, prints program size + rent estimate
./scripts/build.sh devnet                       # same with `--features devnet`
```

### 4. Security Audit
- [ ] Every handler calls the appropriate `safety::verify_*` helpers (see "Pinocchio safety checklist" above)
- [ ] All math uses `checked_*` operations
- [ ] No hardcoded private keys in code
- [ ] `.env` files in `.gitignore`
- [ ] Error messages don't leak sensitive info

### 5. Keeper Permissions
```bash
# Review deno.json for production:
# --allow-net=<specific-domains>  (not --allow-net)
# --allow-read=<specific-paths>   (not -A)
# --allow-write=<specific-paths>
```

### 6. Frontend Configuration
```bash
# app/.env.production (create before deploy)
NEXT_PUBLIC_CLUSTER=mainnet-beta
NEXT_PUBLIC_PROGRAM_ID=<your-deployed-program-id>
# NEVER commit .env files with private keys
```

## AI Collaboration Guide

### Effective Prompt Structure (5 Elements)

```
[1] What: Implement the deposit instruction
[2] Where: programs/protocol/src/instructions/deposit.rs
[3] How: Follow the Pinocchio handler pattern in set_paused.rs (slice destructure +
        safety::verify_* + state::load → mutate → store + emit)
[4] Constraints: Use checked_* math, ceil rounding for fees, CU < 200k
[5] Verification: Write deposit.test.ts, seed range 200-299
```

### Incremental Build Order

```
Step 1: Happy path only (no error handling)
Step 2: Add validations and error codes
Step 3: Add edge case tests
Step 4: Optimize CU if needed
```

### Adding a New Instruction (Checklist)

1. Define the instruction in `docs/SPECIFICATION.md`.
2. Reserve a new tag in `InstructionTag` (lib.rs) + add the human-readable
   name to `IX_LOG_LINES` (used by `scripts/measure-cu.sh` and debug logs).
   Never reuse a retired tag number.
3. Create `instructions/my_instruction.rs`:
   - `#[derive(BorshDeserialize)] pub struct MyArgs { … }`
   - `pub fn process(program_id, accounts: &mut [AccountView], ix_data) -> ProgramResult`
   - Slice-destructure accounts → call the relevant `safety::verify_*` helpers → load
     state via `from_account_view` → validate invariants → mutate / CPI → `store_account_view`
     → emit event.
4. Add the new module to `instructions/mod.rs` and a dispatch arm in `lib.rs`.
5. Add any new error variants to `error.rs` (preserve the numeric mapping)
   AND mirror them in `sdk/src/errors.ts` (`ERROR_CODE_NAMES` + `ERROR_CODE_MESSAGES`).
6. Mirror the args struct in `sdk/src/borsh.ts` (`encodeMyInstruction`) and add a
   builder to `sdk/src/program.ts` `Program.methods.myInstruction(…)`.
7. Update this file: Architecture, PDA Seeds, Error Codes.
8. Write tests with the assigned seed range. For each handler, include:
   - **Happy path** with an event-emission assertion.
   - **Negative paths**: one test per `safety::verify_*` you invoked
     (`tests/security.test.ts` shows the substitution pattern — wrong owner,
     wrong PDA, wrong address, wrong token mint, wrong authority,
     discriminator confusion). Missing one of these is how Pinocchio bugs
     ship to production.
   - **Input validation**: one test per `ProtocolError` variant that the
     handler can return from parameter checks.
9. Re-baseline CU with `pnpm cu:measure` and re-commit `docs/PERFORMANCE.md`.

### Session Handoff

Before ending a session, ask AI:
> "Summarize progress and remaining work in CLAUDE.md"

This ensures the next session picks up where you left off.

## Glossary

- **NBBO**: National Best Bid and Offer. The official top-of-book quote in US equity markets.
- **TTL**: Time To Live. The cache validity window (in this system, the oracle-staleness threshold).
- **Cancel priority**: Landing the oracle update before stale quotes within the same block, neutralizing them.
- **Toxic flow**: Trades from informed traders (unfavorable to MMs).
- **Basis**: The price gap between a tokenized asset and its underlying.
- **PropAMM**: Proprietary AMM. A single-operator AMM run directly by the MM (e.g. HumidiFi, Lifinity).
- **RFQ**: Request-For-Quote. The user asks for a price; the MM returns a signed quote.
- **xStocks**: Tokenized stocks issued by Backed Finance.
- **MMaaS**: Market Maker as a Service. The issuer supplies inventory; an external MM runs the operation.
- **ExactIn**: User fixes the *paid* token amount; the received amount floats (Jupiter / Uniswap convention).

## References

- HumidiFi: https://humidifi.xyz/litepaper
- HumidiFi Aquarium: https://aquarium.humidifi.xyz/
- Jupiter Routing: https://dev.jup.ag/docs/routing
- JupiterZ RFQ Integration: https://dev.jup.ag/docs/routing/rfq-integration
- `jup-ag/rfq-webhook-toolkit`: https://github.com/jup-ag/rfq-webhook-toolkit (reference for the RFQ webhook implementation)
- Drift v2 JIT: https://docs.drift.trade
- UniswapX: https://docs.uniswap.org/contracts/uniswapx/overview
- Pyth Express Relay: https://docs.pyth.network/express-relay
- Lifinity (proactive MM, virtual liquidity): https://docs.lifinity.io/
- Backed Finance: https://backed.fi
- Byreal (Bybit xStocks venue, reference): https://byreal.io
