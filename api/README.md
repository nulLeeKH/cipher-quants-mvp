# API Server

24/7 RFQ webhook for the Cipher Quants Program — JupiterZ-compatible.

## Why separate from keeper?

- **Keeper** = oracle push only (during Mode A/B). Sleeps in Mode C.
- **API server** = RFQ webhook running 24/7. Especially responsible during *Mode C* (market closed / weekends) for responding to user / Jupiter-router quote requests.

Both currently share the oracle hot key (PoC) — in production, split into a
dedicated `quote_signer` key and rotate via `rotate_oracle_signer`.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness probe |
| GET | `/tokens` | Supported mints (base/quote) |
| POST   | `/quote`    | Request a signed RFQ quote (when the curve is stale)              |
| POST | `/swap` | Finalize — returns signedQuote + verifyIx for client tx build |

## Quote rejection policies

- Pool paused → 503
- Curve is *fresh* → 409 Conflict ("use direct execute_swap")
- inputMint/outputMint not in pool → 400
- inAmount ≤ 0 → 400

## Quick start

```bash
cd api
cp .env.example .env  # fill in
deno task dev
```

Test:
```bash
curl http://localhost:8080/health        # ok
curl http://localhost:8080/tokens        # [{mint, name, decimals}, ...]
curl -X POST http://localhost:8080/quote \
  -H 'Content-Type: application/json' \
  -d '{"inputMint":"...","outputMint":"...","inAmount":"1000","userPubkey":"..."}'
```

## Spec sync

- JupiterZ spec → validate the exact schema mapping via `jup-ag/rfq-webhook-toolkit` integration tests at Stage 2 entry.
- Quote pricing → currently a simple `fair_value ± half_spread`. v1 will add depth + skew.
- On-chain state read only — writes are the keeper's responsibility.
