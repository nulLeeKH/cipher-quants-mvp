# Incident Response

> What to do when something breaks in production. Pre-incident planning + the
> specific runbooks for the most-likely failures.
>
> Audience: operators on-call. Each playbook reads top-down and ends with a
> verification checklist.

**Related**: [OPERATIONS.md](OPERATIONS.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [SPECIFICATION.md](SPECIFICATION.md)

---

## 0. Pre-incident checklist (verify monthly)

- [ ] Admin key and oracle hot key are on **separate** machines / KMS realms.
- [ ] Treasury / cold key is on a **Ledger or multisig**, never online.
- [ ] You can reach the admin key in **< 5 minutes** to call `set_paused`.
- [ ] `pnpm validator:up` works from a clean clone (rehearsal restore drill).
- [ ] Metrics token + alert routing tested in the last 30 days.
- [ ] Backup of `target/deploy/protocol-keypair.json` exists in cold storage.

---

## 1. Severity classification

| Severity | Trigger                                                                                  | Response                                                                |
|----------|------------------------------------------------------------------------------------------|-------------------------------------------------------------------------|
| **SEV-1**| Active loss in progress (oracle key compromise, vault drained, fair_value way off)        | Pause within 5 min. Page everyone. Public post-mortem within 72h.        |
| **SEV-2**| Service down / degraded (RFQ webhook 5xx > 5min, keeper not pushing, RPC unreachable)     | Mitigate within 30 min. Status update within 1h.                         |
| **SEV-3**| Single-component degradation (rate-limit spike, single-pool stuck, dashboard down)        | Investigate within 4h. Fix in business hours.                            |

The "5-minute pause" SLO is the hard one — design every operational change to
preserve it. Operating below that bar is the single largest risk multiplier.

---

## 2. Playbook: suspected oracle-key compromise (SEV-1)

**Symptoms**: pushed `update_oracle` you didn't author; nonce jumped without
keeper logs explaining it; unusual fair_value movement against the price
engine's view.

### Step 1 — Pause (under 60 seconds)

```bash
# From any machine with the admin key:
solana --url <RPC_URL> program show <PROGRAM_ID>
# Sanity-check the program ID matches; then build + send the set_paused ix.
# Pinocchio has no `anchor run` analogue — call the SDK builder directly:
node -e '
  const { Connection, Keypair, Transaction } = require("@solana/web3.js");
  const sdk = require("@cipher-quants/sdk");
  (async () => {
    const conn = new Connection(process.env.RPC_URL, "confirmed");
    const admin = Keypair.fromSecretKey(Uint8Array.from(require(process.env.ADMIN_WALLET_PATH)));
    const ix = await sdk.createSetPausedIx(
      new sdk.Program(new sdk.AnchorProvider(conn, new sdk.Wallet(admin))),
      { admin: admin.publicKey, poolState: new sdk.PublicKey(process.env.POOL), paused: true },
    );
    const sig = await conn.sendTransaction(new Transaction().add(ix), [admin]);
    console.log("paused", sig);
  })();
'
```

(Or wire it into the `keeper` CLI as a subcommand; the instruction itself is
in `programs/protocol/src/instructions/set_paused.rs`.)

**Verify**: fetch the pool, check `paused == true`. New `execute_swap` calls
now reject with `PoolPaused (6203)`.

### Step 2 — Rotate the oracle key (under 5 minutes)

1. Generate the new keypair on a clean host:
   ```bash
   solana-keygen new --outfile /var/lib/cipher-quants/keys/oracle-new.json
   chmod 600 /var/lib/cipher-quants/keys/oracle-new.json
   ```
2. Issue `rotate_oracle_signer(new_oracle_pubkey)` from the admin key.
3. Wait one slot, confirm `pool_state.authorized_oracle_signer == new pubkey`.
4. Stop the keeper, swap `ORACLE_WALLET_PATH`, start the keeper.

The previous key is now powerless (any in-flight `update_oracle` it pushes
fails with `UnauthorizedOracle (6200)`).

### Step 3 — Investigate before unpausing

- Pull the last 100 `OracleUpdated` events: `pnpm cu:measure -- --skip-test` (uses the same log path) and grep for `OracleUpdated`.
- Compare the suspect `update_oracle` payloads against the keeper's own log.
- If the compromise predates rotation, treasury is *not* at risk (oracle key cannot withdraw); confirm by reading `pool_state.admin` is unchanged.

### Step 4 — Unpause

Once the investigation finishes and the new oracle signer is verified live,
call `set_paused(false)`. Confirm one successful curve-path `execute_swap`
before announcing recovery.

### Step 5 — Post-mortem

Write a SEV-1 post-mortem within 72 hours. Include: timeline (UTC), root
cause, what worked, what didn't, action items with owners + deadlines.

---

## 3. Playbook: admin-key compromise (SEV-1)

**Symptoms**: unexpected `set_paused` / `rotate_oracle_signer` /
`admin_withdraw_inventory` / `rotate_admin` event on chain.

### Step 1 — Pause (if not already paused)

If the attacker has paused, leave it paused. If they're draining inventory,
they can do that without pausing — proceed to step 2 immediately.

### Step 2 — Use the 2-step admin rotation

The on-chain program supports `propose_admin` + `accept_admin` (see
[SPECIFICATION.md §3.7](SPECIFICATION.md)). If the **legitimate admin still
has the key**, propose a fresh admin under a Squads multisig you control:

1. Generate the new admin key (Ledger or Squads).
2. From the compromised admin: `propose_admin(new_admin_pubkey)` — creates
   the `admin_proposal` PDA.
3. From the new admin: `accept_admin()` — swaps in atomically.
4. Verify `pool_state.admin == new pubkey`.

**If both copies of the admin key are gone**, the pool is *not* recoverable
from chain. Drain whatever inventory remains via the attacker (if cooperative
— bug bounty), and document the loss.

### Step 3 — Rotate every key the attacker may have seen

Even unrelated keys on the same host should be rotated. Assume the host is
compromised end-to-end.

---

## 4. Playbook: vault drain via `execute_swap` exploit (SEV-1)

**Symptoms**: vault balance dropping faster than legitimate trade volume
justifies; user trades pulling far more than the curve should allow.

### Step 1 — Pause (under 60 seconds)

As §2.1.

### Step 2 — Capture evidence

- Snapshot the affected pool's last 1,000 `SwapExecuted` events.
- Capture `vault.amount` of base + quote at the moment of pause.
- Save the program binary (`target/deploy/protocol.so`) at the deployed slot.

### Step 3 — Reproduce locally

```bash
pnpm validator:up
# Replay the suspicious tx (use solana CLI `solana confirm <sig> -v`)
# Or build a Jest test that replays the inputs against the local validator
```

This step is the long pole. Until the bug is isolated, the pool stays paused.

### Step 4 — Patch + deploy + unpause

- Land the fix in `programs/protocol/`.
- Bump the on-chain program (verifiable build, `./scripts/build.sh mainnet`).
- Re-verify the local-validator repro now fails.
- Unpause.

---

## 5. Playbook: keeper not pushing (SEV-2)

**Symptoms**: `last_oracle_update_slot` lags by 1+ minute while Mode is A/B;
RFQ webhook returns `404 — curve fresh, use direct execute_swap` rarely.

### Step 1 — Triage

```bash
# Is the keeper process up?
ps -ef | grep keeper-bot

# When did it last push?
solana --url <RPC_URL> account <POOL_STATE_PUBKEY> \
  | grep last_oracle_update_slot

# Is the RPC healthy?
curl -fs <RPC_URL> -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

### Step 2 — Apply the right fix

| Symptom                                | Fix                                                                             |
|----------------------------------------|---------------------------------------------------------------------------------|
| Process is down                        | Restart. Check for OOM / disk-full in syslog.                                   |
| Process is up but logging "push failed"| Inspect the error. If "blockhash not found" → restart. If "InvalidArgument" on nonce → `keeper` auto-resyncs after 5 consecutive failures, give it 30s. |
| RPC down                               | Failover to backup RPC. Worker reads RPC_URL from env, so SIGHUP isn't enough — restart with new env. |
| Mode is C correctly (market closed)    | No action needed; downgrade to SEV-3 / close.                                   |

### Step 3 — Verify recovery

Watch one Mode-A cycle — `update_oracle` should land every 200–400ms. The
nonce should strictly increase. If you see nonce gaps or reuse, escalate to
SEV-1 (potential key compromise or duplicate writer).

---

## 6. Playbook: RFQ webhook degraded (SEV-2)

**Symptoms**: `/quote` p95 > 250ms (the JupiterZ SLA), 5xx responses, or
`Insufficient inventory` rejects spiking.

### Triage flow

1. Hit `/health` — if 503, the process is down → restart.
2. Hit `/metrics` with the bearer token — check `cipher_quote_latency_ms{quantile="0.95"}` and the `*_fail_total` counters.
3. If `quote_inventory_fail` is climbing, inventory rebalancing is overdue — call `admin_withdraw_inventory` / replenish.
4. If latency p95 > 250ms with no inventory issues, the bottleneck is the RPC. Check `connection.getSlot()` latency manually; failover if needed.

---

## 7. Key Rotation Runbooks

### 7.1 Oracle hot key (scheduled rotation, no incident)

Cadence recommendation: every **90 days** in production.

```bash
# 1. Generate
solana-keygen new --outfile /tmp/oracle-next.json
NEW_PK=$(solana address -k /tmp/oracle-next.json)

# 2. Rotate on-chain (admin key)
keeper admin rotate-oracle-signer --new-pubkey "$NEW_PK"   # via your admin script
# OR build the instruction manually with sdk createRotateOracleSignerIx

# 3. Verify
solana account <POOL_STATE_PUBKEY> --output json \
  | jq -r '.authorizedOracleSigner'   # must equal $NEW_PK

# 4. Atomically swap on the keeper host
sudo install -m 600 /tmp/oracle-next.json /var/lib/cipher-quants/keys/oracle.json
systemctl restart cipher-quants-keeper

# 5. Confirm first push happens within 1 min
journalctl -u cipher-quants-keeper -f | grep "push success"

# 6. Destroy the old key
shred -u /var/lib/cipher-quants/keys/oracle.json.bak
```

### 7.2 Admin key (planned handoff, e.g. moving to Squads multisig)

Use the 2-step propose+accept flow:

```bash
# From the CURRENT admin key:
keeper admin propose-rotation --new-admin "<NEW_ADMIN_PUBKEY>"

# Verify the proposal exists on-chain:
solana account <ADMIN_PROPOSAL_PDA>   # exists after step above

# From the NEW admin (after operator verification):
keeper admin accept-rotation

# Verify
solana account <POOL_STATE_PUBKEY> --output json | jq -r '.admin'   # = NEW
```

If the new admin never accepts, the proposal can be cancelled by the current
admin via `cancel_admin_proposal` — no automatic timeout.

### 7.3 Treasury key

Treasury keys (cold) should never be rotated except on suspected
compromise. Use Squads multisig from day one to avoid single-key rotation
risk.

---

## 8. Communication templates

### SEV-1 initial announcement (within 5 min of pause)

> Cipher Quants is currently paused while we investigate a SEV-1 incident.
> The settlement contract is in a safe state (no further trades will
> execute). Funds in user wallets are unaffected. Updates every 30 min.

### SEV-1 resolution

> The earlier incident is resolved. Root cause: <one-sentence summary>.
> Trading has resumed at <timestamp>. A full post-mortem will be published
> within 72 hours.

---

## 9. Tabletop exercise quarterly

Pick one scenario per quarter and run through it on staging:
- Q1: oracle key rotation
- Q2: admin handoff to Squads
- Q3: keeper crash + recovery
- Q4: full vault-drain repro on local validator

Document time-to-recovery; if any step exceeds the SLO, file a defect against
the runbook itself.
