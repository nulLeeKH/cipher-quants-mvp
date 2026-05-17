# Keeper — Oracle Pusher

Off-chain oracle worker for the Cipher Quants Program. **While Mode A/B is
active**, it pushes `update_oracle` in real time to keep the curve fresh.

## Responsibilities (Keeper *only*)

- **Oracle write** — push `update_oracle` every ~200ms in Mode A, threshold-triggered in Mode B.
- **Price-source integration** — composable pipeline (`PriceSource` interface + `FailoverPriceSource` + `BasisAdjustedSource`). Ships `MockPriceSource` (random walk, dev/CI) and `PythPriceSource` (Pyth Hermes SSE/poll, production). Additional adapters (Finnhub, Yahoo, on-chain Pyth, …) drop in as one-file additions.
- **Automatic mode switching** — RV/NBBO-driven A/B/C decisions with hysteresis.
- **Single-writer nonce** — in-memory monotonic counter (seeded from the on-chain nonce on boot).

## The RFQ webhook lives elsewhere (`api/`)

> The RFQ webhook is 24/7 (especially during Mode C). The keeper does
> oracle write only. The [api/](../api/) Deno HTTP server is responsible for
> quote responses. Both currently share the oracle hot key (or can be split
> into a dedicated `quote_signer` key).

## Quick Start

```bash
cd keeper
cp .env.example .env  # fill in RPC_URL, wallet paths, BASE_MINT, QUOTE_MINT

# Initialize the pool (one-shot)
deno task init-pool

# Start the oracle worker (Mode A/B active)
deno task oracle

# Inspect pool state
deno task status
```

## Subcommands

| Command | Purpose |
|---|---|
| `init-pool`             | One-shot admin op — calls the `init_pool` instruction. Requires BASE_MINT / QUOTE_MINT.                  |
| `status`                | Inspect pool / vault / freshness.                                                                        |
| `oracle` (= `start`)    | Run the oracle worker loop (Mode A/B/C auto-switching).                                                  |

## Environment Variables

See [.env.example](.env.example). Key entries:

| Variable | Required | Description |
|---|---|---|
| `RPC_URL` | ✓ | Solana RPC endpoint |
| `ORACLE_WALLET_PATH` | ✓ | Oracle hot key (Ed25519 keypair JSON, 64-byte secret array) |
| `ADMIN_WALLET_PATH` | for init-pool | Admin key |
| `BASE_MINT`, `QUOTE_MINT`             | ✓               | Pool pair                                                                |
| `ORACLE_MODE_A_PUSH_INTERVAL_MS`      | default 200     | Mode A push interval                                                     |
| `ORACLE_MODE_B_EVAL_INTERVAL_MS`      | default 1000    | Mode B threshold-evaluation interval                                     |

## Architecture

```
keeper/src/
├── main.ts           # CLI entry (init-pool / status / oracle)
├── config.ts         # env loading
├── wallet.ts         # KeypairProvider (PoC: JsonFile; future: Turnkey/KMS)
├── connection.ts     # RpcAdapter abstraction
├── program.ts        # Anchor Provider + SDK Program
├── sources/          # Composable PriceSource pipeline
│   ├── types.ts      # PriceSource interface + PriceTickStatus + priceToFairValue
│   ├── mock.ts       # Random walk + spike (dev/CI)
│   ├── pyth.ts       # Pyth Hermes adapter (SSE default, polling fallback)
│   ├── basis.ts      # Underlying → tokenized basis adjustment wrapper
│   ├── failover.ts   # Multi-source priority + status-rank fallback
│   ├── factory.ts    # Env-driven pipeline composition
│   └── index.ts
├── oracle/           # Oracle worker
│   ├── state.ts        # OracleSharedState (mode, nonce, latest tick)
│   ├── mode.ts         # Mode decision (RV/NBBO + hysteresis + NYSE calendar)
│   ├── stale_policy.ts # 30s-of-non-fresh → force Mode C (pure helper)
│   ├── worker.ts       # Push loop
│   └── index.ts
└── commands/         # CLI subcommands
    ├── init_pool.ts
    ├── status.ts
    └── oracle.ts
```

## Mode decisions (current v0)

| Mode  | TTL                  | Push                       | When                                                       |
|---|---|---|---|
| **A** | 1 slot               | every 200ms                | High vol (RV > 150 bps OR NBBO 30s move > 15 bps)          |
| **B** | 3 slots              | threshold-triggered only   | Normal trading                                              |
| **C** | 0 (forced stale)     | no push (sleep)            | Market closed / low-vol                                     |

Downgrades fire when the quiet-duration condition holds (B→C: 90s, A→B:
180s). Cool-down: at least 30 seconds in the current mode before evaluating a
downgrade. See [docs/OPERATIONS.md §1.1](../docs/OPERATIONS.md) for the full
policy.

## Data sources

The keeper composes its price feed at boot from env vars (see `.env.example`):

```
primary (mock | pyth)
  └─► FailoverPriceSource (optional, comma-separated env)
        └─► BasisAdjustedSource (optional, signed bps)
              └─► worker.pushOracle()
```

`PRICE_SOURCE=mock` is fine for localnet / CI; `PRICE_SOURCE=pyth` consumes
the free [Pyth Hermes](https://hermes.pyth.network) feed (SSE by default,
polling as fallback). Pyth publishes the *underlying* asset price — for
tokenized representations (xStocks) set `BASIS_ADJUSTMENT_BPS` to the
measured basis vs underlying. See [sources/basis.ts](src/sources/basis.ts)
and [sources/factory.ts](src/sources/factory.ts).

Every tick carries a `status` field (`fresh|stale|halted|unknown`). The
worker refuses to push anything but `"fresh"` and force-downgrades to
Mode C after 30 s of consecutive non-fresh ticks — so RFQ-only fallback
engages automatically when Pyth equity feeds go quiet after the NYSE
close. The policy lives in [stale_policy.ts](src/oracle/stale_policy.ts)
as a pure helper for unit-testability.

Adding a new adapter (Finnhub, Yahoo, on-chain Pyth, …) is a one-file
change in `src/sources/` + a factory branch. [TODO.md §1](../TODO.md)
tracks the planned second adapter.

## Tests

```bash
deno task test                 # All keeper unit tests (no network)
deno task check                # tsc-equivalent
```

## Build / Compile

```bash
deno task compile              # Standalone binary: ./keeper-bot
```

## Related

- [api/](../api/) — RFQ webhook (24/7)
- [sdk/](../sdk/) — TypeScript SDK (shared)
- [programs/protocol/](../programs/protocol/) — on-chain program
- [docs/OPERATIONS.md](../docs/OPERATIONS.md) — full operational spec
