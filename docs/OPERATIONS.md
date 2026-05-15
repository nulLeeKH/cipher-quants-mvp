# Operations

> Off-chain components (price engine, oracle worker, RFQ webhook, inventory
> manager) and 3-tier operating policy, per-application mode mapping, plus
> research methodology (RQs + baseline policies + adversarial bot + measurement).
> The "engine" side + research-output side, distinct from the on-chain contract.

**Related docs:** [ARCHITECTURE.md](ARCHITECTURE.md) · [SPECIFICATION.md](SPECIFICATION.md) · [../CLAUDE.md](../CLAUDE.md)

---

## 1. 3-tier mode definition

| Mode               | Worker state | Oracle TTL (v0 locked)       | Push cadence       | When                         |
|---|---|---|---|---|
| **A** Aggressive   | Active       | **1 slot (~400ms)**          | 100–200ms           | High-volatility windows      |
| **B** Light Hybrid | Reactive     | **3 slots (~1.2s)**          | When thresholds hit | Normal trading               |
| **C** RFQ Only     | Sleep        | **0** (forced stale)         | 0                   | Market closed / no trades    |

Design intent: the MM toggles its own oracle by cost-benefit. Mode A is
expensive but secures cancel priority; Mode C is nearly free and allows 24/7
trading. TTL values get tuned with the Stage 1 backtest.

### 1.1 Hysteresis policy (v0 defaults)

Anti-flapping policy. Basis: MRS-GARCH literature (minute-scale regime dwell
times of 1–3 minutes) + PropAMM operating patterns.

| Item                  | Value                                                                                                                                                                                                                       |
|---|---|
| **Upgrade A←B (promote to Aggressive)**       | RV Z-score > +1.5 OR NBBO 1-slot jump > 15 bps (xStocks) / > 30 bps (long-tail crypto)                                                   |
| **Demote toward C / Upgrade to RFQ-only**     | RV Z-score > +3.0 OR NBBO 1-slot jump > 40 bps OR Pyth conf/price > 25 bps                                                                |
| **Downgrade A→B (hysteresis)**                | "Quiet" signal sustained for **180 seconds**                                                                                              |
| **Downgrade B→C**                              | "Quiet" signal sustained for **90 seconds**                                                                                               |
| **"Quiet" quantitative definition (AND)**     | (a) 5-min RV Z-score ≤ +0.5, (b) NBBO mid 30-second cumulative move ≤ 8 bps, (c) abort/cancel rate ≤ 5% over the last 60 seconds          |
| **Cool-down (downgrade)**                     | Only evaluate a downgrade after at least **30 seconds** in the current mode (anti-oscillation)                                            |
| **Off-hours multiplier**                      | Outside xStocks regular hours, multiply hysteresis N by ×1.5–2                                                                            |

---

## 2. Mode-switch triggers

### 2.1 Time-based (schedule)
- 30 min before / after US market open → **Mode A**
- 30 min before / after US market close → **Mode A**
- Normal trading hours → **Mode B**
- Outside market hours → **Mode C**
- Weekends / holidays → **Mode C**

### 2.2 Event-based (calendar)
- ±30 min around earnings releases → **Mode A**
- ±30 min around FOMC / NFP / CPI / GDP releases → **Mode A**

### 2.3 Reactive (real-time detection)
- 5-min realized vol of the underlying exceeds the threshold → **Mode A**
- On-chain volume Z-score exceeds the threshold → **Mode A**
- NBBO moves ≥ K bps within N seconds → **Mode A**
- Basis (NBBO vs Raydium pool) deviates by N stdev → **Mode A or reject**
- All signals quiet for N minutes → **downgrade to Mode B or C**

### 2.4 On-chain reflection of mode transitions

Mode transitions are **expressed via the `new_ttl` argument of `update_oracle`**, not a standalone instruction.

- Mode A: `new_ttl = 1` (v0 default)
- Mode B: `new_ttl = 3` (v0 default)
- Mode C: `new_ttl = 0` (and stop pushing entirely)

Advantage of this design: the mode transition and the price update share the
same transaction, so they're atomic. Stage 1 tuning may move to A=2, B=5,
etc. (within the `MAX_TTL_SLOTS=8` cap).

---

## 3. Price Engine

### 3.1 Inputs (PoC first choice; see [TODO.md §1](../TODO.md))
- **Finnhub free + Yahoo unofficial** — primary price source (NBBO proxy via last trade ± synthetic spread).
- **Pyth equities feed** — sanity / cross-check
- **Raydium pool price** — basis extraction.
- **(post-PoC) Backed Finance API** — inventory + redemption cost (pre Stage 3).
- **Event calendar** — earnings, macro release times.

> **Data-source abstraction is mandatory**: the price engine accepts inputs via a `PriceSource` trait/interface so concrete implementations (Finnhub / Polygon.io / Chainlink xStocks ...) can be swapped. This is the PoC decision that keeps migration open ([TODO.md §1.1](../TODO.md)).

### 3.2 Outputs
- `update_oracle` transaction payload (Mode A/B)
- RFQ webhook responses (every mode)
- Mode-switch decisions (state machine)

### 3.3 Fair-value synthesis

```
fair_value_synth = w_nbbo × NBBO_mid + w_basis × (raydium_mid − basis_adjustment)
```

- Default: `w_nbbo = 1`, `w_basis = 0`
- If basis is abnormal, adjust weights or reject the trade.
- Confidence-weighted (factors per-source latency / staleness).

### 3.4 Spread determination

```
spread = base_spread
       + redemption_cost_floor       // Backed redeem cost
       + inventory_premium           // current inventory imbalance
       + volatility_premium          // based on 5-min RV
       + toxic_flow_premium          // detection-based
```

In Mode A the `volatility_premium` shrinks thanks to cancel priority. That
delta is the price benefit the user receives in PropAMM mode.

---

## 4. Oracle Worker

### 4.1 Activation conditions
- Active only when entering Mode A/B.
- Mode C is sleep (cost = 0).

### 4.2 Tech stack
- Solana RPC: prefer Helius / Triton (low latency needed).
- Use Jito tip-per-CU for the priority lane.
- Nonce sequencing (off-chain state).
- In Mode B, push only when thresholds are exceeded (long idle intervals).

### 4.3 CU + cost budget

| Item                          | Estimate                                                                |
|---|---|
| `update_oracle` CU per call   | ~5–10k (HumidiFi reference ~143 CU; needs our own measurement)          |
| Jito tip                      | 0.0001–0.001 SOL/tx (depends on volatility)                             |
| Mode A 1-hour uptime          | **~$30–50** (xStocks size)                                              |
| Mode B 1-hour uptime          | **~$5–10**                                                              |

### 4.4 Oracle-nonce issuance policy (single-writer)

`update_oracle`'s `new_nonce` is monotonically enforced + verified on-chain.
**But if the automated worker and an admin manual push issue different nonces
*simultaneously*, you can hit a race condition.** Policy:

- **The automated oracle worker is the single writer for nonces.** Admin manual pushes go *through the worker* (send the worker a command), or *pause the worker first* and then push manually.
- Worker nonce sequencing: off-chain DB or in-memory counter. On boot, read `pool_state.oracle_nonce` from chain and start at +1.
- For emergencies where admin must bypass the worker: lock the worker (`worker stop`) → 1–2 manual admin pushes → restart the worker (reading the chain nonce again on restart).
- "Force mode switch" actions in the admin dashboard are also implemented as **commands to the worker** (HTTP/IPC signal → worker pushes with the right nonce). The admin key never calls `update_oracle` directly.

This blocks nonce-collision race conditions.

### 4.5 Cancel-priority operating pattern

```
1. Price engine detects a large NBBO move (e.g., K bps within T seconds).
2. Immediately produces an update_oracle tx + bumps Jito tip (priority lane).
3. Lands before stale-quote sniper txs in the same slot.
4. The sniper's swap tx is priced against the new fair_value → minimal loss.
```

Operational KPIs: number of triggers during Mode A uptime, avoided-loss / triggering-cost ratio. (Details in §11.3 RQ4.)

---

## 5. RFQ Webhook

> **Where it runs**: independent [api/](../api/) Deno HTTP server (Hono). *Separate* from the keeper — the keeper does write (oracle push) only, while the api server does read+sign (quote issuance) 24/7. Shares the oracle hot key (or can be split into a dedicated quote_signer).

### 5.1 Standard
JupiterZ webhook spec:
- `POST /quote`
- `POST /swap`
- `GET /tokens`
- `GET /health` (liveness; outside the JupiterZ spec but useful operationally)

### 5.2 SLA
- 250ms response
- Sustain a 95% fill rate

### 5.3 Rejection policy (v0 defaults)

Basis: safety margin against the JupiterZ 95% fulfill rule + Hashflow MM's "5-second RV > 2σ" standard + 2-slot lookahead matching sniper detection lag.

| Scenario                                            | Action            | Quantitative threshold                                                                       |
|---|---|---|
| Mode about to enter Active (oracle imminent fresh)  | **Reject**        | Lookahead 800 ms (2 slots). If the next push is scheduled within 800 ms, reject.              |
| Volatility spike detected                           | **Reject**        | 5-second RV Z-score > +2.0                                                                    |
| NBBO short-term jump                                | **Reject**        | NBBO 200 ms move > 12 bps (xStocks) / > 25 bps (long-tail crypto)                              |
| Oracle confidence degraded                          | **Reject**        | Pyth confidence/price > 20 bps                                                                |
| RPC latency degraded                                | **Reject**        | Measured quote-response roundtrip > 150 ms                                                     |
| Inventory at limit                                  | **One-sided reject** | skew > 60% of cap                                                                          |
| Toxic-taker pattern detected                        | **Optional reject** | Decided after Stage 1 RQ1/RQ5 analysis                                                       |
| **Rejection rate cap (safety net)**                 | —                 | 5-minute rolling rejection rate < **30%** (back-solved from JupiterZ 95% fulfill)              |

> HTTP response: return `404 Not Found` within 250 ms (JupiterZ standard, no penalty).

### 5.4 Run scope
The RFQ webhook runs **24/7** (api/ HTTP server). In Mode A/B, users can *trade
directly via the curve*, so webhook calls are lower; the webhook is **the
primary responder during Mode C** (market closed / weekends). The keeper sleeps
in Mode C, but the api/ server keeps running.

> If the webhook responds while the curve is fresh, users hit a *timing
> conflict* (per §3.1 the quote is ignored and settlement uses the curve).
> When the API server detects a fresh curve it returns `404` so the user is
> guided to the *direct curve path*.

---

## 6. Inventory Manager

### 6.1 Monitoring targets
- Ratio of `base_vault.amount` / `quote_vault.amount` (no reserves field in PoolState — vaults are the single source of truth).
- External hedge positions (if any).
- Backed redemption queue state.

### 6.2 Action triggers
- One side of the vault drops below threshold → **request Backed redeem** (PoC: buy on market).
- Inventory risk exceeds limit → **force-widen spread**.
- Imminent rebalance required → **reject quotes** (one direction).

### 6.3 Rebalance pathway
- **xStocks**: Backed mint/redeem (hour-scale latency).
- **Long-tail crypto**: issuer direct deposit or OTC swap.

### 6.4 Per-asset initial depth coefficients (applied at pool init)

v0 defaults for `DepthParams { depth_coef_bps, size_unit, max_depth_bps }`.
Basis: Almgren TAQ impact model (σ scaling: TSLA ≈ 3× SPY) + 2–3× on-chain
liquidity-premium widening for xStocks.

| Bucket                | Asset             | size_unit (USD notional)             | depth_coef_bps | max_depth_bps |
|---|---|---|---|---|
| Large-cap ETF         | SPYx              | $10,000 → raw-token equivalent        | 0.8            | 40            |
| Mega-cap individual   | NVDAx             | $5,000  → raw-token equivalent        | 1.5            | 80            |
| Mega-cap individual   | TSLAx             | $5,000  → raw-token equivalent        | 2.5            | 150           |
| Long-tail crypto      | (per token)       | ADV × 0.1% in USD                     | 5–15           | 300–500       |

> **Off-hours multiplier**: outside xStocks regular hours apply `depth_coef × 2.5`, `max_depth × 2`. The oracle worker pushes these updates on mode transitions.
> **Per-asset segregation is mandatory** — at minimum 3 buckets (SPY-class / mega-cap individual / long-tail crypto).
> Revisit the concave (square-root) curve after 6 months of backtests (currently linear + cap).

---

## 7. Data ingestion / telemetry

Needed for the research deliverables + operational monitoring:

| Data                                                       | Target store (proposal)            | Retention   |
|---|---|---|
| Full NBBO tick stream                                      | ClickHouse / Parquet               | 12 months   |
| Mode-transition events                                     | ClickHouse                         | unlimited   |
| Every `update_oracle` tx                                   | Solana RPC + our own logs          | unlimited   |
| Every `execute_swap` outcome (price, mode, fill status)    | ClickHouse                         | unlimited   |
| Adversarial-bot attempts / fills                           | ClickHouse                         | unlimited   |
| Inventory state time series                                | ClickHouse                         | 12 months   |

Dashboards: Grafana or Metabase. Pre-design the per-RQ KPI panels (§11.4 metrics).

---

## 8. Operating cost (monthly)

| Item                                | Estimate         |
|---|---|
| Polygon.io NBBO | $200–2,000 |
| Solana RPC (Helius/Triton) | $200–500 |
| Data ingestion (ClickHouse)         | $100–300         |
| Compute (engine, bot, telemetry)    | $200–400         |
| **Total**                           | **$700–3,200/mo**|

Additionally: Solana tx fees + Jito tips (Mode A uptime dependent; see §4.3).

---

## 9. Status of operating-policy decisions

### 9.1 Locked (reflected in code/spec/v0 defaults)
- **Two-source priority**: if the curve is fresh, ignore the quote (SPECIFICATION §3.3).
- **TTL values**: A=1, B=3, C=0 (§1).
- **Sanity bound**: not applied — defense is cancel priority.
- **Quote replay**: per-quote PDA + close reclaim.
- **Mode-switch triggers**: §2.
- **Mode hysteresis policy**: §1.1 (v0 defaults — RV Z-score, NBBO move, "quiet" AND definition, downgrade N=90/180s).
- **RFQ rejection thresholds**: §5.3 (v0 defaults — lookahead 800 ms, RV Z > +2, NBBO 200ms move > 12/25 bps, rejection-rate cap 30%).
- **Per-asset depth-coefficient buckets**: §6.4 (SPY / NVDA / TSLA / long-tail, 4 buckets).
- **Adversarial-bot quantitative parameters**: §11.5 (4 trader types with fixed seeds).
- **RPC provider**: §13.1 (Helius Developer + Helius Sender, abstraction layer mandatory).
- **Oracle key management**: §13.2 (PoC = .env + isolated machine, 3-tier key separation from day 1, migration path documented).

### 9.2 Additional tuning needed before Stage 1 entry

| Item                                                        | Notes                                            |
|---|---|
| Toxic-taker rejection threshold                          | Depends on RQ1/RQ5 analysis                                  |
| Simulator fallback when NBBO is unavailable              | Mitigates free-source limits ([TODO.md §1](../TODO.md))     |

### 9.3 Decisions required before Stage 2/3 entry

| Item                                                        | Notes                                            |
|---|---|
| Loss limit / kill-switch thresholds                         | Per-policy max drawdown                          |
| Key migration (Turnkey or AWS KMS Ed25519)                  | §13.2 migration path                             |
| Squads multisig (treasury cold key)                         | Capital ≥ $500k phase                            |
| Co-location / dedicated Triton                              | When p99 latency > 300ms                         |

---

## 10. Related code locations (locked)

| Component                                              | Location                  | Language                | When it runs                  |
|---|---|---|---|
| Oracle worker (push only)                              | `keeper/`                 | **Deno**                | While Mode A/B is active      |
| Data-source adapters (PriceSource)                     | `keeper/src/sources/`     | **Deno**                | Bound to the keeper           |
| Inventory manager (TODO Stage 2)                       | `keeper/` (separate task) | **Deno**                | 24/7                          |
| **RFQ webhook + quote signer**                         | `api/` (Deno + Hono)      | **Deno**                | **24/7** (owns Mode C)        |
| SDK helpers (RFQ serialize, ed25519, curve simulate)   | `sdk/src/`                | TypeScript              | Build-time only               |
| Frontend (admin + user)                                | `app/`                    | TypeScript / Next.js 14 | User-triggered                |

### Responsibility split

- **`keeper/`** = uses the oracle hot key to *write* (push `update_oracle`). Runs only while Mode A/B is active. Sleeps in Mode C → saves operational cost.
- **`api/`** = uses the oracle hot key (or `quote_signer`) to *sign quotes* + read on-chain state. Runs 24/7. Primary responder during Mode C (market closed / weekends).
- **Both currently share the oracle hot key** (PoC). In production we'll consider splitting into a dedicated `quote_signer` key + `rotate_oracle_signer`.

### Single-language stack (Deno)

Keeper and API both use Deno + the same SDK (CommonJS). The RPC libraries
(anchor, web3.js) work via Node compatibility. We do not split out a Python
price engine — Deno integrates PriceSource adapters directly.

---

## 11. Research methodology

The primary deliverable is quantitative research data, not an operating venue.
The RQs trump production-readiness.

### 11.1 Token scope

3 assets + 1 control:

| Asset                          | Role                       | Volatility character          |
|---|---|---|
| **TSLA**                       | High-vol, news-sensitive   | Stresses Mode A/B             |
| **NVDA**                       | High volume, high vol      | Volume-handling                |
| **SPY or KO**                  | Stable baseline            | Volatility control             |
| **(optional) 1 long-tail crypto** | Generalization check     | 24/7 reactive mode             |

### 11.2 Research Questions (RQs)

- **RQ1 — Structural advantage**: how does the hybrid design trade off spread, fill rate, MEV exposure, and operational cost vs always-on PropAMM, pure RFQ, and light hybrid?
- **RQ2 — Mode-switch accuracy**: what precision/recall does the automated mode-switch policy achieve against post-hoc-labeled "true volatility windows"?
- **RQ3 — Two-source oracle effect**: how much better does NBBO + Raydium basis synthesis defend against stale-quote losses vs single-source?
- **RQ4 — Cancel-priority effectiveness**: how often does cancel priority actually fire on xStocks, and does the avoided-loss amount justify the idle cost?
- **RQ5 — New attack vectors**: are there any new exploits the hybrid structure introduces? If so, can they be mitigated?

### 11.3 Four baseline policies (off-chain simulator comparison)

**On-chain we run P4 (Dynamic Hybrid) only.** The 4-policy comparison runs in
the **Stage 1 off-chain simulator** — NBBO replay + adversarial-bot
simulation (same input → per-policy output comparison).

**Why off-chain comparison?**
- Running 4 PoolState pools simultaneously on mainnet lets adversaries cherry-pick the best venue to attack → distorts the comparison.
- Real user flow also concentrates at the best-price venue via routers → P1/P2/P3 see almost no real fills → impossible to measure.
- The off-chain simulator gives cleaner controlled variables (same NBBO + same adversarial flow → all 4 policies see identical input).

| Policy                | Simulator behavior                                                                       | Baseline meaning                              |
|---|---|---|
| **P1** Pure RFQ       | Never evaluate the curve; always use the RFQ price.                                       | Minimal-infra baseline                        |
| **P2** Aquarium-style | Always-on curve. No RFQ fallback (reject trades when curve is stale).                     | Mimics HumidiFi Aquarium                      |
| **P3** Light Hybrid   | Threshold-triggered only. Assumes TTL=3 slots.                                            | Middle-ground                                 |
| **P4** Dynamic Hybrid | Automatic A/B/C switching. **(Proposed model, mainnet operating policy.)**                | Experimental arm                              |

> The simulator *reproduces* the settlement program's instruction logic but
> never makes real calls — pricing decisions, mode switching, RFQ-webhook
> rejection policy, etc., are faithfully reproduced in Deno/TypeScript for all
> 4 policies.
> Mainnet P4 operating data is used to *recalibrate* simulator assumptions
> (Jito tip effect, RPC latency distribution).

### 11.4 Metrics

| RQ | Metric |
|---|---|
| **RQ1** | Spread bps (vs CEX), fill rate, MEV-loss bps, idle cost / volume                                            |
| **RQ2** | Mode-switch precision, recall, F1 (vs post-hoc labels)                                                       |
| **RQ3** | Stale-quote loss (single source vs 2-source synthesis)                                                       |
| **RQ4** | Cancel-priority trigger count, avoidance-benefit / triggering-cost ratio                                     |
| **RQ5** | Per-policy adversarial-bot PnL, count of newly-discovered exploitable patterns                               |

Additional operational KPIs: uptime, RFQ webhook latency p50/p95/p99, oracle-push success rate.

### 11.5 Adversarial bot model (v0 quantitative values)

4 trader simulations, applied identically across every policy (controlled
variables). Seeds fixed → reproducibility. Basis: Cont order-flow model
(Poisson + log-normal) + SEC microstructure standard lags + Helius MEV
research (Solana Jito economics).

#### Random retail
- **Arrival**: Poisson, **λ = 0.5/sec** per pair (regular hours), **0.15/sec** (off-hours)
- **Trade size**: Log-normal, **μ = log(800), σ = 1.2** USD notional (median ≈ $800, 95p ≈ $5,800)
- **Side**: Bernoulli p=0.5 (uninformed)
- **Cancel rate**: 0 (PoC is market orders only)

#### Informed trader
- **Signal detection lag**: Exponential, **mean = 350ms** (≈ 1 Solana slot)
- **Signal strength threshold**: trade only when expected mid-move > **20 bps** (xStocks) / **50 bps** (crypto)
- **Participation rate**: **8% of ADV** per opportunity, sliced into 5–10 child orders
- **Hit rate**: 60% of detected signals are profitable (TAQ-based informed flow studies calibrate)

#### Sandwicher
- **Minimum target trade size**: **$3,000 USD notional** (below this, Jito tip > expected sandwich PnL)
- **Gas tip strategy**: **Dynamic = 30% of expected sandwich PnL** (Jito tip), floor **10,000 lamports**, ceiling 0.01 SOL
- **Detection latency**: 1 slot (assumes mempool / leader-level visibility)
- **Slippage exploitation**: front-run by `min(victim slippage × 0.7, 50 bps)` price move

#### Stale quote sniper
- **Staleness detection lag**: constant **1 slot (400 ms)** after the oracle-push deadline
- **Attack budget per opportunity**: **min($25,000, depth-at-max-bps)** USD notional
- **Entry latency distribution**: Log-normal, **μ = log(80), σ = 0.4** ms (median 80ms RPC roundtrip)
- **Profitability filter**: attack only when stale-vs-fresh mid-diff > **15 bps + fee**

> If Stage 1 cannot discriminate between the 4 policies, sweep
> `informed.hit_rate` and `sniper.detection_lag` as a stress test.
> The sandwicher distribution can be recalibrated from real Jito MEV bundle
> data (jito.wtf dashboard, etc.).

### 11.6 Experimental stages

#### Stage 1 — Backtest (8 weeks)
- Download 12 months of historical NBBO (PoC free sources, [TODO.md §1](../TODO.md)).
- Evaluate **all 4 policies (P1–P4) in parallel** in our own simulator (off-chain; the settlement program is never invoked).
- Synthetic adversarial flow (apply the same input to all 4 policies).
- **Output**: first quantitative comparison across the 4 policies; first-pass threshold tuning.

#### Stage 2 — Devnet (4–6 weeks)
- Deploy **P4 only** to Solana devnet.
- Wire up the real-time NBBO feed; bring the oracle worker live.
- Adversarial bot live on devnet.
- **Output**: validate P4's behavior in the real Solana environment + validate the measurement pipeline.

#### Stage 3 — Mainnet small-scale (4–8 weeks)
- Deploy **P4 only** with small capital ($20–50k).
- Keep the adversarial bot running, selectively invite users.
- **Output**: mainnet-condition data for P4; recalibrate Stage 1 simulator assumptions (latency / Jito tip / slot jitter, ...).

### 11.7 Simulator requirements (Stage 1)

- Inputs: historical NBBO replay, simulation clock.
- Run the oracle-worker / RFQ-webhook logic for all 4 policies in the same process.
- Sync all 4 adversarial-bot instances to the same clock.
- Outputs: per-policy trade log, mode-transition log, PnL accounting.
- Artifacts: parquet → ClickHouse → analysis.

> Block-latency / Jito-tip effects are *assumed* in Stage 1 (tx land probability, slot-level latency). Stage 2/3 recalibrates from measurements.

### 11.8 Core-hypothesis verification checklist

Answer each iteratively across Stages 1 → 2 → 3:

- [ ] PropAMM intervention reduces idle cost vs always-on PropAMM (P2).
- [ ] No (or minimal) spread loss during the same windows.
- [ ] Cancel priority actually works during volatility windows (Stage 2/3).
- [ ] Mode-switch accuracy is sufficiently high vs post-hoc labels (quantitative threshold from Stage 1).
- [ ] No new attack vectors discovered, or they are mitigable.

---

## 12. Application cases — mode mapping

### 12.1 xStocks (primary target)

**Conditions**: US-listed equities (TSLA, NVDA, AAPL, ...); market hours 9:30–16:00 ET weekdays; volatility windows = open/close 30 min + earnings/macro events. Issuer = Backed Finance.

**Mode mapping**:
- Active 30-min market windows → **Mode A**
- Normal trading hours → **Mode B**
- After close + weekends → **Mode C**
- Event ±30 min → force-promote to **Mode A**

**Oracle sources**:
- Primary: Polygon.io NBBO (PoC uses free tier, [TODO.md §1](../TODO.md)) or Chainlink xStocks Data Streams (revisit in production)
- Secondary: Pyth equities (sanity)
- Tertiary: Raydium pool price (basis)

### 12.2 Long-tail crypto tokens (expansion target)

**Conditions**: ordinary SPL tokens. 24/7 market with active-time concentration. Volatility spikes are reactive (news, macro, new listings).

**Mode mapping**:
- Volatility / volume spike → **Mode A**
- Normal → **Mode B**
- Fully idle → **Mode C**
- No time schedule (everything reactive)

**Oracle sources**:
- Primary: Pyth (if the token is covered) or CEX prices (Binance, OKX public WS)
- Secondary: Raydium / Orca pool prices (basis)
- Tertiary: external aggregator (CoinGecko, ...) — sanity only

### 12.3 Generalization

The framework applies to any asset that meets:

1. Average volatility isn't high enough to justify 24/7 PropAMM.
2. Volatility spikes are sporadic (either predictable or reactive).
3. Baseline trade demand is always present (a level RFQ can handle).

xStocks are a special case where (1) is met by time structure and (2) is
predictable-spike. Long-tail crypto is a case where (2) is reactive. The
framework works as-is in both.

---

## 13. Infrastructure — RPC & key management

### 13.1 RPC provider (PoC v0)

**Principle**: an **RPC provider abstraction layer** is mandatory so providers can be swapped at any time. The keeper abstracts behind an `RpcAdapter` interface; the concrete provider is selected via an env var.

**PoC first choice (locked)**:

| Role                                                  | Provider                          | Cost                |
|---|---|---|
| Primary RPC (keeper, tx submit, account read)         | **Helius Developer** ($49/mo)     | $49/mo              |
| Frontend RPC (browser → Helius directly)              | **Helius Secure RPC** (domain-ACL endpoint) | included in same plan |
| Jito bundle submission                                 | **Helius Sender** (tip-only billing) | tip only (per-tx)   |
| Backup (failover)                                      | **QuickNode Build** ($49/mo)      | optional            |

→ PoC total **$49–100/mo**. Upgrade to dedicated Triton or our own Yellowstone validator at capital ≥ $500k or when p99 latency > 300 ms.

> The frontend hits Helius Secure RPC directly (browser → Helius) without a separate proxy. A domain ACL protects the API key against abuse. If we later need a custom-RPC option, introduce an API Gateway between the frontend and the RPC.

**Rationale**: 2026 benchmarks (Helius p50 ~140 ms, QuickNode 40–60 ms with shared 300 RPS cap). Helius has the richest Solana-native ecosystem (DAS / webhooks / LaserStream) → less infra code to write.

### 13.2 Oracle worker key management (PoC v0)

**Principle**: **PoC stage uses local management** (`.env` + an isolated host). The code and docs make the migration path explicit; upgrade when entering mainnet or scaling capital.

**PoC policy**:
1. The oracle worker private key lives on a **single isolated VM/host** in `.env` (LUKS disk encryption recommended).
2. The repo commits only `.env.example`; `.env` is gitignored.
3. SSH access is restricted (key-based + a single IP whitelist).
4. **3-tier key separation from day 1**: `oracle_worker_key` (hot, automated push) ≠ `pool_admin_key` (warm, manual admin ops) ≠ `treasury/rebalance_key` (cold, Ledger). Even if the hot key leaks, the treasury stays protected.

**Migration path (on mainnet entry or capital scale-up)**:

| Stage                              | Option                                                     | Cost                                |
|---|---|---|
| PoC                                | `.env` on an isolated host                                  | $0 (VM cost only)                   |
| Mainnet entry (first)              | **Turnkey** (TEE-based, first-class Solana, free tier)      | $0~                                 |
| Mainnet stabilization              | **AWS KMS native Ed25519** (GA 2025-11)                     | ~$1/key/mo + $0.03/10k req           |
| Capital ≥ $500k                    | Squads multisig (2-of-3) + AWS KMS / Turnkey combo          | —                                   |

**Industry standard since the Wintermute 2022 incident**: hot/warm/cold tier separation regardless of capital size, from day 1.

### 13.3 Action items

- [ ] Define the keeper's `RpcAdapter` interface + concrete Helius / QuickNode implementations.
- [ ] Write `.env.example` (`ORACLE_KEY_PATH`, `RPC_URL`, `JITO_TIP_KEY`, ...).
- [ ] Stand up the isolated host (LUKS recommended; at minimum SSH key-only).
- [ ] Document the 3-tier split: oracle worker / pool admin / treasury (cold key on Ledger before Stage 2 entry).
- [ ] (At mainnet entry) Plan migration to Turnkey or AWS KMS Ed25519.

---

## 14. Frontend (app/)

PoC scope: **Admin dashboard + a proper user swap UI**. Next.js 14 + Solana Wallet Adapter. Calls into the SDK.

### 14.1 Admin dashboard

For the operator's own use. Wallet auth restricts access to the `pool_state.admin` key.

| Panel                       | Display / action                                                                                                                                                                                |
|---|---|
| Pool state                  | All PoolState fields (fair_value, spread, depth, skew, oracle_nonce, last_update_slot, current_mode_ttl, paused)                                                                                  |
| Freshness                   | `current_slot - last_update_slot` vs TTL → fresh/stale color coding                                                                                                                              |
| Vault balances              | `base_vault.amount`, `quote_vault.amount` + ratio time-series chart + USD-notional conversion                                                                                                     |
| Inventory management        | **Deposit form** (admin's base/quote ATA → vault via a single SPL Token transfer wallet tx) / **Withdraw form** (calls `admin_withdraw_inventory`)                                               |
| Mode-transition log         | Most recent N `OracleUpdated` events (decoded from Anchor `emit!`) + mode changes                                                                                                                |
| Trade log                   | Most recent N `SwapExecuted` events (includes execution_price, mode, quote_nonce)                                                                                                                |
| Oracle-push statistics      | Pushes per hour, average latency, success rate                                                                                                                                                  |
| **Admin actions**           | `set_paused` toggle / `rotate_oracle_signer` / **`rotate_admin`** (⚠ confirmation modal: type the new admin pubkey twice) / **force mode toggle** (= send command to the worker; §4.4 single-writer) |

> **Force-mode-change UI safety policy**: the admin must not enter `fair_value` *directly*. Only the mode toggle is exposed (A/B/C buttons). In emergencies where fair_value must change, the standard path is to update the worker config + restart the worker. The admin never calls `update_oracle` directly, in line with the §4.4 single-writer policy.

> **`rotate_admin` UI safety policy**: a wrong pubkey permanently locks admin privileges. The UI must (a) require *re-entering the new pubkey to confirm*, (b) pre-validate that the new admin pubkey is a valid Solana address (32 bytes base58), and (c) warn "this action is irreversible". In production, prefer delegating admin to a Squads multisig.

> **Deposit UI**: symmetric to `admin_withdraw_inventory`. Display the admin's base/quote ATA balance → input the deposit amount → send a plain SPL Token `transfer` instruction (NOT a call to our program) to the vault. Any wallet behaves the same way (the SPL TokenAccount accepts deposits from anyone).

### 14.2 User Swap UI

Used as our own trading channel before / when JupiterZ registration is unavailable or rejected. Even after registration, the direct-trading option remains.

| Component                     | Function                                                                                                                                  |
|---|---|
| Wallet connect                | Solana Wallet Adapter                                                                                                                     |
| Token-pair selector           | base/quote pair (e.g., xTSLA/USDC)                                                                                                        |
| Direction (Buy/Sell) + input  | ExactIn interface, [SPECIFICATION.md §3.3](SPECIFICATION.md#33-execute_swap)                                                              |
| Quote display                 | Current mode (Curve/RFQ) + expected receive amount + price + slippage (min_output) slider                                                 |
| Auto-handle RFQ path          | When the curve is stale, the SDK calls the webhook + prepends ed25519 verify + builds execute_swap                                        |
| Trade result                  | Tx result (execution price, received amount, actual mode, slot)                                                                           |

### 14.3 Decisions (v0 locked)

| Item                         | Decision                                                                                                                                                  |
|---|---|
| **Mobile-responsive**                 | **Mobile-first from day 1.** Tailwind responsive utility classes (`sm:`, `md:`, `lg:`) applied consistently. Every page handles both mobile and desktop.                                                                                              |
| **Language**                          | **English-only (permanent).** No i18n planned.                                                                                                                                                                                                         |
| **Admin auth**                        | **Wallet-signing based (Ledger/Saga compatible)** — details in §14.4                                                                                                                                                                                   |
| **Trade history**                     | **PoC fetches via RPC directly** (`getSignaturesForAddress` + `getTransaction` + Anchor event decoding). Migrate to an indexer / ClickHouse later (when performance limits surface).                                                                   |
| **Dashboard metrics**                 | **Next.js API route + direct RPC** (PoC). The frontend calls **Helius Secure RPC directly** (domain ACL protects). No separate proxy.                                                                                                                  |
| **User UI mode-transition heads-up**  | **Not displayed** — the user sees only the current mode + quote and decides. When a mode transition is imminent, the RFQ webhook rejection (§5.3) protects them.                                                                                       |

### 14.4 Admin auth — wallet signing (Ledger/Saga compatible)

**Problem**: Ledger hardware wallets do not support *arbitrary message signing* (signMessage). SIWS (Sign-In With Solana) is message-based and therefore unsupported for Ledger admins.

**Solution**: a transaction-based challenge pattern.

1. The backend issues a challenge — `{nonce, timestamp, audience: "cipher-quants-admin", exp}` (valid for 5 min).
2. The frontend wraps the challenge in a **dry-run transaction**:
   - `SystemProgram.transfer(from=admin, to=admin, lamports=0)` (no-op)
   - `MemoProgram.create(json.stringify(challenge))`
   - `feePayer = admin`, `recentBlockhash` = something valid.
3. The admin wallet (Phantom/Solflare/Backpack/**Ledger**/**Saga**) calls `signTransaction` — Ledger handles tx signing fine.
4. The frontend POSTs the signed tx to the backend (the tx is never submitted to RPC).
5. The backend verifies:
   - The tx signature is an ed25519 signature by the `admin` pubkey.
   - The memo contains a challenge we issued, not expired.
   - The admin pubkey == `pool_state.admin` (on-chain lookup).
6. On success, issue a **JWT** (valid 1 hour) via HttpOnly cookie + Authorization header.
7. Subsequent admin API calls use the JWT.

**Security notes**:
- Challenge is server-issued → replay-resistant (nonce one-time, 5-min expiry).
- Audience claim → transactions from other dApps cannot be reused for our auth.
- JWT 1-hour expiry → no long-lived sessions.
- Sensitive on-chain actions (`set_paused`, `rotate_oracle_signer`, manual `update_oracle`) require a **separate** wallet transaction signature each time — even if the JWT is leaked, on-chain authority is independent.

### 14.5 Wallet-adapter support list (v0)

- **Phantom** (most common)
- **Solflare**
- **Backpack**
- **Ledger** (`@solana/wallet-adapter-ledger`) — compatible with admin tx-based auth
- **Solana Mobile Stack (Saga)** (`@solana-mobile/wallet-adapter-mobile`) — mobile-native
- **Wallet Standard** auto-detect (other compatible wallets)

> The Phantom mobile app also works via Wallet Standard.

### 14.6 Page / route layout

```
app/
├── app/
│   ├── page.tsx                  # Landing (brief intro + wallet connect)
│   ├── swap/
│   │   └── page.tsx              # User swap UI (§14.2). Mobile + desktop ready.
│   ├── admin/
│   │   ├── layout.tsx                  # JWT auth guard
│   │   ├── login/page.tsx              # Transaction-based challenge sign-in (§14.4)
│   │   ├── page.tsx                    # Admin dashboard (§14.1)
│   │   ├── pools/[pool]/page.tsx       # Per-pool detail
│   │   ├── inventory/page.tsx          # Vault deposit guide + admin_withdraw_inventory UI
│   │   └── actions/page.tsx            # pause / rotate / mode toggle (each action is a separate wallet tx)
│   └── api/
│       ├── auth/
│       │   ├── challenge/route.ts # POST: issue challenge
│       │   └── verify/route.ts    # POST: verify the signed tx → JWT
│       ├── metrics/route.ts       # Dashboard metrics (server-side RPC call results, formatted)
│       └── history/route.ts       # Trade history (RPC `getSignaturesForAddress` + decode)
├── components/                   # UI components (shadcn/ui)
├── lib/
│   ├── sdk.ts                    # @cipher-quants/sdk wrapper
│   ├── rpc.ts                    # Helius Secure RPC client (Connection factory)
│   ├── auth.ts                   # Admin auth (challenge signing + JWT lifecycle)
│   └── decode.ts                 # Anchor event/tx decoder
└── hooks/                        # React hooks (useWallet, usePoolState, etc.)
```

> No `/api/rpc/route.ts` — the frontend's `lib/rpc.ts` `Connection` calls the Helius Secure RPC endpoint directly. Helius enforces domain / Origin ACL. If the ACL becomes insufficient or a custom-RPC option is needed, evolve by adding an API Gateway later.

### 14.7 Locked decisions (applied during implementation)

| Item                         | Decision                                                                                                                                                  |
|---|---|
| Design system                | **Tailwind + shadcn/ui**                                                                                                                                  |
| Next.js router               | **App Router** (Next 14 default)                                                                                                                          |
| JWT signing key storage      | **`.env`** (`JWT_SECRET`). Fine for PoC. Revisit (Secrets Manager) at production time.                                                                    |
| Frontend RPC security        | **Helius Secure RPC** domain ACL — admin and user domains can have separate endpoints. No new API Gateway needed (introduce later if required).            |

### 14.8 UX details (handled during coding)

Things to naturally pick up as we build:

- **Friendly error messages for failed trades**: map on-chain errors to UI text (`NoFreshPriceSource` → "Try again in a moment", `SlippageExceeded` → "Adjust slippage tolerance", `QuoteExpired` → "Quote expired, request a new one").
- **Oracle-push failure alert**: if the nonce stalls for 5 minutes, raise a red alert on the admin dashboard (Slack/Discord webhook later).
- **Multi-pool comparison view**: when running multiple pools, the `/admin/page.tsx` lists per-pool volume, fill rate, mode, vault balance.
- **Stale-state polling**: `usePoolState` hook polls every 2 seconds or subscribes via WebSocket (Helius `accountSubscribe`).
- **Quote-expiry countdown**: on the user UI, show a progress bar based on `expiry_slot - current_slot` after a quote is received.
- **Mode-transition history graph**: time series of mode changes (recharts or similar).
