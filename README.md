# Cipher Quants — PropAMM × RFQ Hybrid Settlement

Research-grade Solana program implementing the hybrid PropAMM / RFQ venue
described in [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md). Built as a
**Pinocchio** program — no Anchor runtime — with a hand-rolled Borsh SDK and
matching Next.js / Deno tooling.

## Why this exists

A single-MM settlement contract that accepts both (a) an on-chain curve
controlled by the MM and (b) a signed RFQ quote attached to the transaction,
and toggles between the two based on the **curve's freshness (TTL)**. RFQ is
the baseline; PropAMM kicks in the instant the oracle worker detects a
volatility spike and falls back to RFQ once vol calms down. Research goals,
adversarial-bot model, and stage gates live in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Tech stack (locked)

| Layer       | Stack                                                                                   |
|-------------|-----------------------------------------------------------------------------------------|
| On-chain    | Rust + **Pinocchio 0.11** (no Anchor runtime). 11 instructions, ~141 KB `.so`.          |
| SDK         | TypeScript (CommonJS). Hand-rolled Borsh codecs + Anchor-shaped `Program` shim — drops `@coral-xyz/anchor`. |
| Frontend    | Next.js 14 + Solana Wallet Adapter. Mobile-first. Phantom / Solflare / Backpack / Ledger / Saga. |
| Keeper      | Deno — oracle pusher (calls `update_oracle` while Mode A/B is active).                  |
| API server  | Deno + Hono — RFQ webhook (JupiterZ-compatible), runs 24/7.                              |
| Tests       | Jest + ts-jest, driven by `solana-test-validator` (`./scripts/test.sh`). 96 integration cases + 320 unit tests across rust/keeper/api/sdk/app. |

## Prerequisites

| Tool        | Version             |
|-------------|---------------------|
| Rust        | latest stable        |
| Solana CLI  | ≥ 1.18 (`cargo build-sbf` ships with the platform-tools)    |
| Node.js     | ≥ 24.0.0             |
| pnpm        | ≥ 9.0.0              |
| Deno        | ≥ 2.0 (keeper / api) |

> No Anchor CLI required. `cargo build-sbf` (from the Solana CLI) builds the
> program; integration tests spawn `solana-test-validator` directly via
> `scripts/test.sh`.

## Quick start

```bash
# 1. Install JS workspace deps
pnpm install

# 2. Build everything
./scripts/build.sh localnet    # cargo build-sbf → target/deploy/protocol.so
pnpm sdk:build                  # SDK → sdk/dist/

# 3. Run integration tests (spawns its own validator)
pnpm test                       # integration suite (96 tests, ~100 s)
pnpm test:unit                  # all unit suites (keeper + api + sdk + app, ~6 s, no validator)
pnpm test:all                   # both of the above, end-to-end

# 4. Run Rust unit tests (math + Borsh parity, <1s)
cargo test -p protocol --lib

# 5. Long-lived dev validator
pnpm validator:up               # bg; logs at .anchor/validator.log
pnpm validator:down

# 6. Off-chain services
pnpm keeper:dev                 # oracle pusher
pnpm api:dev                    # RFQ webhook
pnpm app:dev                    # Next.js admin + swap UI
```

## Project layout

```
.
├── programs/protocol/     # Pinocchio on-chain program (11 instructions)
│   └── src/
│       ├── lib.rs              # entrypoint + 1-byte-tag dispatch
│       ├── constants.rs        # PDA seeds, well-known program ids, params
│       ├── error.rs            # ProtocolError → ProgramError::Custom(u32)
│       ├── events.rs           # Borsh + base64 event emit ("Program log: EVT:…")
│       ├── safety/             # signer / owner / PDA / discriminator helpers
│       ├── instructions/       # one process(...) per instruction
│       ├── state/              # PoolState, QuoteNonceMarker, AdminRotationProposal
│       └── math/               # curve, ed25519 sysvar parser, WAD reserve
├── sdk/                   # @cipher-quants/sdk — TS SDK (no Anchor runtime)
├── app/                   # Next.js frontend (Wallet Adapter + RFQ + curve sim)
├── keeper/                # Deno oracle pusher
├── api/                   # Deno RFQ webhook (JupiterZ-compatible)
├── tests/                 # Jest integration suite (96 cases)
├── scripts/               # build / test / validator / measure-cu
├── docs/                  # SPEC + ARCH + OPS + CORE + DEPLOYMENT + INCIDENT_RESPONSE + PERFORMANCE
└── CLAUDE.md              # AI-agent operating manual (read first)
```

## Working with AI agents

`CLAUDE.md` is the operating manual loaded by Claude Code at every session.
It encodes:

- the Pinocchio handler pattern (slice destructure → `safety::verify_*` → state
  load/mutate/store → emit) and the **safety-helper checklist that replaces
  Anchor's `#[derive(Accounts)]`** — missing any check there is silently
  exploitable.
- error-code categories, PDA-seed table, CU budget.
- critical operational rules (no `anchor build`/`anchor test`, no `.env` commits,
  always `checked_*` math).

Recommended workflow:

1. Define / update the on-chain semantics in `docs/SPECIFICATION.md`.
2. Update `CLAUDE.md` if architecture or PDA seeds change.
3. Ask AI to implement one instruction at a time, following the helper
   checklist.
4. Run `cargo test -p protocol --lib` for unit-level signals, then
   `pnpm test` end-to-end.
5. Re-baseline CU via `pnpm cu:measure` after CU-sensitive changes.

## Build for different networks

```bash
./scripts/build.sh              # default — clean release build
./scripts/build.sh <label>      # same .so, label is a log tag only; no per-cluster
                                # cfg gates today. Reintroduce a Cargo feature
                                # here and in Cargo.toml in the same commit if
                                # divergent behaviour is ever needed.
```

The `mainnet` build is what gets deployed. The script prints program size and
the deployment-rent estimate.

## Related tools

| Tool                                                                                  | Use                                                                  |
|---------------------------------------------------------------------------------------|----------------------------------------------------------------------|
| [Helius MCP Server](https://github.com/helius-labs/mcp-server-helius)                 | 60+ Solana APIs surfaced inside Claude Code via MCP                  |
| [Solana Fender](https://github.com/nicola-attico/solana-fender)                       | Static analyser — was Anchor-focused; cross-check Pinocchio code by hand |
| [SendAI Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit)              | Prebuilt Solana actions for off-chain bot work                       |

## License

MIT
