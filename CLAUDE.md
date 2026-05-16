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
- On-chain: Rust + Anchor 0.32.1, SPL Token classic
- SDK: TypeScript (CommonJS) — instruction builder, RFQ quote serialize/verify, ed25519 prepend, curve simulate
- Frontend: Next.js 14 + Solana Wallet Adapter — admin dashboard + user swap UI. **Mobile-first** (Tailwind responsive). English only. Wallet support: Phantom / Solflare / Backpack / **Ledger** / **Saga (Solana Mobile)** / Wallet Standard. Admin auth is a transaction-based challenge (Ledger-compatible, SIWS fallback).
- Keeper: **Deno** — *oracle pusher only* (calls update_oracle while Mode A/B is active).
- API server: **Deno + Hono** — RFQ webhook running 24/7 (especially during Mode C windows).
- Tests: Jest + ts-jest

### Monorepo Layout
- `programs/protocol/` — on-chain settlement program (8 instructions)
- `sdk/` — TypeScript SDK (shared)
- `app/` — Next.js frontend (admin + user UI). Screen breakdown in [docs/OPERATIONS.md §14](docs/OPERATIONS.md)
- `keeper/` — Deno oracle pusher. Only runs while Mode A/B is active.
- `api/` — Deno HTTP server (RFQ webhook, JupiterZ-compatible). 24/7.
- `tests/` — Integration tests (Jest + Anchor)
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

[TODO.md](TODO.md) — external-dependency tracker (data sources, Backed Finance, Jupiter integration).

## Development Commands

```bash
# Build
anchor build
./scripts/build.sh devnet      # devnet features enabled
./scripts/build.sh mainnet     # production build

# Test
pnpm test
pnpm test -- --testPathPattern="my_test.test.ts"  # specific test

# Check test results (structured JSON output)
cat test_result.json | jq '.numPassedTests, .numFailedTests'
cat test_result.json | jq '.testResults[].assertionResults[] | select(.status == "failed")'

# SDK
cd sdk && pnpm build
cd sdk && pnpm dev             # watch mode

# Keeper
cd keeper && deno task dev

# Program logs (after tests)
grep "consumed" .anchor/program-logs/*.log
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

### Current phase (2026-05-15)

Spec v1 finalized → **about to enter Week 1–2 infra setup + code scaffolding**.

## ⚠️ Critical Rules

- **DO NOT run tests directly.** Tests take 3+ minutes (validator start → deploy → Jest). Ask the user to run them, then read `test_result.json` for results.
- **DO NOT use `anchor test` directly.** Use `pnpm test` instead.
  - **Why:** `pnpm test` runs the configured `package.json "test"` script, which includes `--features` flags (e.g., `anchor test -- --features devnet,test-feature`). Running bare `anchor test` skips those flags → program compiles with wrong settings → tests fail in hard-to-diagnose ways.
  - **Rule:** If you add `[features]` to `Cargo.toml`, update `package.json "test"` to pass them: `"anchor test -- --features your-feature"`.
- **DO NOT commit `.env` files.** They contain private keys.
- **DO NOT modify multiple instructions in one change.** One instruction per change, test, then move on.
- **ALWAYS use checked arithmetic** (`checked_add`, `checked_sub`, `checked_mul`, `checked_div`) for all on-chain math.
- **ALWAYS update this file** when changing architecture, PDA seeds, error codes, or test structure.

## Architecture

### Program Module Structure

```
programs/protocol/src/
├── lib.rs             # Entry points (delegates to instruction handlers)
├── constants.rs       # PDA seeds, protocol parameters
├── error.rs           # All error codes
├── instructions/      # One file per instruction
│   └── mod.rs         # pub mod + pub use
├── state/             # Account structures
│   └── mod.rs
└── math/              # Business logic
    ├── mod.rs
    └── wad.rs         # Fixed-point WAD arithmetic (10^18)
```

### Instruction Handler Pattern (3-Phase)

Every instruction handler follows this pattern:

```rust
pub fn process_my_instruction(ctx: Context<MyInstruction>, args...) -> Result<()> {
    // Phase 1: Validation & Calculation (immutable borrow scope)
    let result = {
        let state = &ctx.accounts.my_state;
        require!(condition, ErrorCode::SomeError);
        // All reads and math here
        calculated_value
    }; // borrow ends here

    // Phase 2: CPIs (token transfers, mints, burns)
    let signer_seeds = &[&[b"seed", key.as_ref(), &[bump]][..]];
    token::transfer(cpi_ctx.with_signer(signer_seeds), amount)?;

    // Phase 3: State update (mutable borrow)
    let state = &mut ctx.accounts.my_state;
    state.value = result;
    Ok(())
}
```

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

Invariants:
- `base_mint < quote_mint` (lexicographic ordering enforced) → prevents duplicate pools.
- `quote_nonce_marker` is `init`-forced only in the RFQ path of `execute_swap` → replay blocked. Reclaimable via `close_expired_nonce` once `expiry_slot + SAFETY_BUFFER_SLOTS < now`.

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
- Check after implementing: `grep "consumed" .anchor/program-logs/*.log`
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
- `61xx` — input validation (mint pair, TTL, fair_value, spread, size)
- `62xx` — authorization & state (oracle/admin signer, nonce monotonic, paused)
- `63xx` — pricing source (curve stale + no quote, quote invalid)
- `64xx` — execution (slippage, insufficient reserves)

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

### Anchor Feature Flags (Cargo.toml)

**`init-if-needed` (Currently enabled)**
- ⚠️ **NOT automatically dangerous** — only risky if misused in code
- Safe usage: One-time account initialization (config, registry)
- Unsafe usage: User-specific accounts (wallets, positions) → re-initialization attacks
- Rule: Use `#[account(init)]` for user accounts, reserve `init_if_needed` for global singletons

**Why it's in workspace dependencies:**
```toml
[workspace.dependencies]
anchor-lang = { version = "0.32.1", features = ["init-if-needed"] }
```
- Available for use, but NOT active until `#[account(init_if_needed)]` is explicitly added
- AI should flag any `init_if_needed` usage in instruction code for human review

### Known False Positives
These are intentional for a boilerplate/development setup:
- ✅ Placeholder program ID (`11111...1`) — See "Deployment Checklist" below
- ✅ Broad dependency versions (Next.js `^14.0.0`) — Lock before production
- ✅ Missing `pnpm-lock.yaml` — Run `pnpm install` to generate
- ✅ Keeper with `-A` flag — Acceptable for trusted off-chain automation

## Deployment Checklist

Before deploying to devnet/mainnet, verify:

### 1. Program ID (CRITICAL)
```bash
# Current state (placeholder):
declare_id!("11111111111111111111111111111111");

# Steps to fix:
anchor build                                    # Generate keypair
solana address -k target/deploy/protocol-keypair.json
# Copy address to lib.rs declare_id!()
# OR use vanity address:
solana-keygen grind --starts-with ABC:1        # Custom prefix
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
# Verify Anchor.toml [programs.localnet] has correct program ID
anchor build --verifiable                       # Mainnet builds
./scripts/build.sh mainnet                      # Our custom build script
```

### 4. Security Audit
- [ ] No `init_if_needed` on user-specific accounts
- [ ] All math uses `checked_*` operations
- [ ] All Signer constraints in place
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
[3] How: Follow the 3-phase pattern in initialize.rs
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

1. Define the instruction in `docs/SPECIFICATION.md`
2. Create `instructions/my_instruction.rs` (3-phase pattern)
3. Add accounts struct with Anchor validation attributes
4. Add to `instructions/mod.rs` (pub mod + pub use)
5. Add entry point to `lib.rs`
6. Add error codes to `error.rs`
7. Update this file: Architecture, PDA Seeds, Error Codes
8. Write tests with assigned seed range
9. Create SDK instruction builder in `sdk/src/instructions/`

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
