# TODO

> Tracks **external dependencies / negotiations / licensing** only. We move fast
> through the PoC and resolve these before entering the production phase.
> Operational parameter tuning (thresholds, depth coefficient, adversarial bot
> parameters, etc.) is tracked separately in
> [docs/OPERATIONS.md §9.2](docs/OPERATIONS.md).

---

## 1. Data sources

### 1.1 PoC policy (locked 2026-05-15)
- **Start with free sources.** Default combo: Finnhub free + Yahoo unofficial + Pyth/Raydium.
- **Data-source abstraction layer from day one** — the price engine / keeper must be implemented source-agnostically so we can swap to Polygon.io paid, Chainlink xStocks Data Streams, etc.
- Paid licensing is revisited just before Stage 3 entry, or sooner if data-quality limits become a blocker.

### 1.2 Candidate comparison

**US equities (xStocks underlying):**

| Source                  | Cost      | Latency                              | Tick granularity   | Notes                                                              |
|---|---|---|---|---|
| Polygon.io free tier    | $0        | ~15 min delayed                       | aggregated         | No real trade ticks, basically unusable for backtest               |
| Polygon.io Starter      | $29/mo    | EOD                                   | EOD                | EOD backtest only                                                  |
| **Polygon.io Developer**| $99/mo    | 15-min delay (+ realtime add-on)      | tick               | **Strong PoC candidate**                                           |
| Alpha Vantage free      | $0        | EOD                                   | EOD                | 5 calls/min; intraday too sparse                                   |
| Finnhub free            | $0        | realtime (limited)                    | tick (last trade)  | 60 calls/min; not true NBBO                                        |
| IEX Cloud free          | $0        | realtime                              | tick               | IEX exchange only (not NBBO), redistribution restricted            |
| Twelve Data free        | $0        | realtime (limited)                    | tick               | 800 calls/day                                                      |
| Yahoo Finance (unoff.)  | $0        | ~15 min delayed                       | aggregated         | ToS grey area, common in academic PoCs                             |
| Databento Lite          | ~$125/mo  | realtime (high latency)               | tick               | NBBO available; pricing to be confirmed                            |

→ **First choice (locked)**: **Finnhub free + Yahoo unofficial**. Treat the last trade as an NBBO approximation ("NBBO = last trade ± synthetic spread", simulator-only). The data source is abstracted in the SDK / keeper for easy future migration.

**Crypto (long-tail tokens):** free sources are sufficient — Binance/Coinbase public WS, Pyth, Raydium/Orca pool prices.

### 1.3 Decisions required before production (pre Stage 3)
- Polygon.io paid plan vs Chainlink xStocks Data Streams (price/licensing comparison)
- Redistribution rights (legality of publishing research output / data)
- SLA / uptime / cost negotiation

### 1.4 Action items
- [x] **Design the data-source abstraction layer** (price engine / keeper source-agnostic) — **shipped**: `PriceSource` interface (`keeper/src/sources/types.ts`), `MockPriceSource` + `PythPriceSource` adapters, `FailoverPriceSource` + `BasisAdjustedSource` wrappers, env-driven `factory.ts`.
- [ ] **Ship a second concrete adapter (Finnhub / Yahoo / CoinGecko)** so the Failover scaffold has someone to fall back to. Stage 2 exit gate.
- [ ] Measure Finnhub free + Twelve Data free in practice (latency, drop rate, tick frequency)
- [ ] Review the ToS grey area before relying on Yahoo unofficial
- [ ] Decide where 12 months of historical data come from for the Stage 1 backtest
- [ ] Define a fallback when NBBO is unavailable in the simulator ("last trade ± synthetic spread")
- [ ] (Migration time) Confirm Polygon.io Developer or Chainlink xStocks Data Streams pricing / terms
- [ ] (Migration time) Confirm data-redistribution legality (can we publish research output?)

---

## 2. RWA infrastructure negotiation (Backed Finance / alternatives)

### 2.1 PoC policy
- **The Backed meeting is right before Stage 3 entry.** During the PoC we treat xStocks as *external inventory* — buy them on market, deposit into the pool.
- The primary deliverable of this research is *engine performance comparison*. Partnership economics are a production-phase concern.

### 2.2 Items to resolve (answers needed pre Stage 3)

| #     | Item                                                                                  | Priority |
|---|---|---|
| 2.2.1 | Backed Finance sales / partnerships contact channel                                    | Medium   |
| 2.2.2 | xStock token redemption cost (bps, minimum size)                                       | High     |
| 2.2.3 | Redemption latency (mint/redeem processing time)                                       | High     |
| 2.2.4 | Inventory deposit (Aquarium-style) feasibility + LOI                                   | Medium   |
| 2.2.5 | Hedging responsibility split (Backed fully owns it vs. we share)                       | Medium   |
| 2.2.6 | Ability to request new xStock issuances (long-tail equity expansion)                   | Low      |

### 2.3 Alternatives (if Backed is lukewarm)
- Kraken Direct (candidate xStocks issuer)
- Dinari (another tokenized-equity issuer)
- 100% self-owned inventory (low margin but viable)

### 2.4 Action items
- [ ] Read Backed Finance public materials (litepaper, docs) end-to-end — understand the redemption mechanism
- [ ] Collect public info on HumidiFi Aquarium's Backed partnership (reference for the negotiation model)
- [ ] Attempt the meeting roughly 2 months before Stage 3 entry (better leverage when bringing research history)

---

## 3. Jupiter integration

### 3.1 Split of responsibilities (locked 2026-05-15)
- **Dev team (us)**: build a **JupiterZ-webhook-compatible interface only**. The RFQ webhook service must expose `POST /quote`, `POST /swap`, `GET /tokens` per spec.
- **Jupiter-side negotiation / registration**: handled directly by the user (Telegram @biuu0x, Discord Developer Support). The dev team owns no tracking / negotiation duty here.

### 3.2 Standards / tooling
- JupiterZ webhook spec: [Integrate MM into JupiterZ (RFQ)](https://dev.jup.ag/docs/routing/rfq-integration)
- Standard endpoints: `POST /quote`, `POST /swap`, `GET /tokens`
- SLA: 250ms response, 95% fill rate (rolling 1-hour window)
- Reference implementation: [jup-ag/rfq-webhook-toolkit](https://github.com/jup-ag/rfq-webhook-toolkit) — Rust sample server + OpenAPI schema + integration tests

### 3.3 Dev-team action items
- [ ] Review `jup-ag/rfq-webhook-toolkit` and run the local sample server (learn the interface). Stage 2 entry task — shipped code shape already mirrors the toolkit; the open piece is running their tests against our api server (`pnpm api:dev` → point the toolkit's OpenAPI tests at `localhost:8080`).
- [x] Implement our RFQ webhook: `POST /quote`, `POST /swap`, `GET /tokens`, `GET /freshness` — full surface in [INTEGRATIONS.md](docs/INTEGRATIONS.md).
- [x] **Maker last-look at `/swap`**: ed25519 signing moved from `/quote` to `/swap`; drift/expiry/inventory recheck gates the signature. Default `MM_MAX_DRIFT_BPS=50`. See [OPERATIONS.md §5.4](docs/OPERATIONS.md).
- [x] **`/swap` returns JupiterZ-spec `tx`** (base64 `VersionedTransaction` with CU-limit + idempotent ATA-create + verify + execute_swap). MM does not sign — user sole signer. `components` retained for callers that assemble their own tx shell.
- [x] **`GET /freshness`** Metis routing signal (paused / fresh / ttl / recommended path).
- [x] **`/tokens`** JupiterZ-shape `{address, symbol, decimals}` records.
- [x] `SignedQuote` ↔ Jupiter swap-tx mapping locked: SignedQuote serialised inside `execute_swap_ix.data`; the ed25519 verify ix immediately precedes it; both wrapped in a `VersionedTransaction`. See [SPECIFICATION.md §3.3](docs/SPECIFICATION.md#33-execute_swap) + [INTEGRATIONS.md §2.2](docs/INTEGRATIONS.md).
- [ ] **OpenAPI schema validation pass against `jup-ag/rfq-webhook-toolkit`**. Stage 2→3 gate. Tracked as a single hand-off — no further code is anticipated unless the toolkit surfaces a divergence.

### 3.4 Metis (Jupiter main router, curve-path integration)
- [x] SDK exports for off-chain adapters (`simulateSwap`, `createExecuteSwapIx`, `fetchPoolState`, `derivePoolState`, `deriveVault`, `sortMints`).
- [x] Routability signal: `GET /freshness` + same logic documented inline ([INTEGRATIONS.md §3.2](docs/INTEGRATIONS.md)).
- [x] Adapter-author docs: [INTEGRATIONS.md §3](docs/INTEGRATIONS.md).
- [ ] **Coordinate with Jupiter to write the Metis DEX adapter crate** (lives in their adapter SDK, not this repo). Hand them the INTEGRATIONS.md link + `@cipher-quants/sdk` npm package once published.

### 3.5 User action items (out of dev-team scope)
- [ ] Jupiter-side contact (Telegram/Discord)
- [ ] Edge environment onboarding
- [ ] Mainnet production registration

---

## 4. Infrastructure (PoC → production migration)

### 4.1 RPC provider
- **PoC first choice**: Helius Developer $49/mo + Helius Sender (Jito tip-only). Details in [docs/OPERATIONS.md §13.1](docs/OPERATIONS.md).
- **Requirement**: the keeper abstracts the RPC behind an `RpcAdapter` interface — providers must be swappable at any time.

#### Action items
- [ ] Provision a Helius Developer account + API key
- [ ] Define the keeper's `RpcAdapter` interface (concrete impls: Helius / QuickNode / dedicated Triton, ...)
- [ ] Set up p99 RPC-latency monitoring (alert when > 300ms → consider dedicated)

### 4.2 Oracle worker key management

- **PoC policy**: `.env` + an isolated machine (LUKS disk encryption recommended). Details in [docs/OPERATIONS.md §13.2](docs/OPERATIONS.md).
- **Day-1 requirement**: 3-tier key separation — `oracle_worker_key` (hot, automated) ≠ `pool_admin_key` (warm, manual) ≠ `treasury_key` (cold, Ledger).
- **Migration path**:
  - On mainnet entry → **Turnkey** (TEE-based, first-class Solana support, free tier to start) or **AWS KMS native Ed25519** (GA 2025-11, ~$1/key/month).
  - Capital $500k+ → **Squads multisig (2-of-3)** for treasury.

#### Action items
- [x] `.env.example` shipped for keeper / api / app with 3-tier wallet path separation (`ORACLE_WALLET_PATH` / `ADMIN_WALLET_PATH` / `FEE_PAYER_WALLET_PATH`) + priority-fee knobs (`ORACLE_MODE_A/B_PRIORITY_FEE_MICROLAMPORTS`).
- [ ] Stand up an isolated VM (LUKS + SSH key-only + IP whitelist)
- [ ] (Mainnet entry) PoC migration to Turnkey or AWS KMS Ed25519

---

## 5. Docs / infra to write or review during development

Items that naturally surface while building. The PoC doesn't need to complete
all of these; the tracker exists to prevent omissions.

### 5.1 Math derivation doc (D1)
- Either as a header comment in `programs/protocol/src/math/curve.rs` or a separate `docs/MATH.md`
- Content: derivation of the linear-bps curve (Drift v3 reservation-price variant), the meaning of ExactIn rounding, why skew_offset is a mid_shift, the intended base-heavy / quote-heavy behavior
- Guide for choosing size_unit / depth_coef / target_base_bps when adding a new asset (using the Almgren impact model)

### 5.2 Curve kind / version migration (P1)
- v0 ships LinearBps only. Reserve a `curve_kind: u8` slot in PoolState's reserved area (or build a v2 migration instruction)
- Modularize math/curve.rs via trait/enum dispatch (`CurveKind::LinearBps`, later `CurveKind::PiecewiseQuadratic`, ...)
- On v2 entry: PoolState migration instruction or a separate v2 pool

### 5.3 Parameter-selection guide when adding new assets (D2)
- Procedure for assets beyond TSLAx / NVDAx / SPYx (e.g. AAPLx)
- Inputs: ADV (USD), σ (daily vol), spread baseline
- Outputs: recommended `size_unit`, `depth_coef_bps`, `max_depth_bps`, `target_base_bps`, `skew_coef_bps`
- Automation script for the Almgren impact model (Python notebook or a keeper CLI subcommand)

### 5.4 Parameter-sweep infrastructure (P3)
- Hyperparameter grid sweep in the Stage 1 simulator (e.g. hysteresis N=60s/90s/120s × TTL_A=1/2 × depth_coef=0.8/1.5/2.5)
- Ingest results into ClickHouse → visualize per-policy KPIs vs sweep grid for all 4 policies
- Add a grid-runner module to the simulator

### 5.5 Simulator ↔ real program cross-validation (P2)
- After Stage 2 devnet entry, compare simulator P4 vs devnet P4 under identical NBBO / adversary conditions
- Verify *bit-for-bit* match on pricing decisions, mode-switch timing, fill outcomes (where feasible)
- Calibrate the simulator when divergences are found

### 5.6 Math-module abstraction (D3)
- Abstract LinearBps functions in `math/curve.rs` behind `pub trait Curve { fn evaluate(...) -> Result<u64>; }`
- For now it's 1 trait + 1 impl. Adding another impl in v2 will feel natural
- Risk of over-engineering at v0; decide once we're inside the code (skip if it doesn't pay off)

---

## 6. Changelog

| Version | Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                              |
|---|---|---|
| v0.6    | 2026-05-15 | §5.7 dropped `close_pool` — emptying the vault via `admin_withdraw_inventory` is enough; leaving PoolState rent locked forever is acceptable.                                                                                    |
| v0.5    | 2026-05-15 | New §5 — docs / infra to write or review during development (math derivation, curve-kind migration, asset-addition guide, parameter sweep, simulator-program cross-validation, math-module abstraction).                          |
| v0.4    | 2026-05-15 | New §4 Infrastructure — RPC provider (Helius + abstraction layer) and key-management PoC policy (.env + isolated machine, 3-tier split, Turnkey / AWS KMS migration path). Operational parameter defaults moved to docs/OPERATIONS.md. |
| v0.3    | 2026-05-15 | §1 free-data-source-first decision (Finnhub free + Yahoo) + abstraction-layer requirement. §3 Jupiter-integration responsibility split codified (dev team = interface compatibility only, user = registration & negotiation).      |
| v0.2    | 2026-05-15 | Absorbed external-dependency items from the old open-questions tracker (Chainlink xStocks Data Streams, Jupiter integration, data licensing). Consolidated into 3 categories.                                                    |
| v0.1    | 2026-05-15 | Initial draft — PoC free data sources + Backed-meeting tracker.                                                                                                                                                                  |
