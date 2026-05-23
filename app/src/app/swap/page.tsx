"use client";

import * as React from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { BN } from "@cipher-quants/sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Buffer } from "buffer";
import { ArrowDownUp, RefreshCw, ShieldAlert, Loader2 } from "lucide-react";

import {
  deriveVault,
  simulateSwap,
  PRICE_SCALE,
  ED25519_PROGRAM_ID,
  friendlyError,
  createExecuteSwapIx,
  type Side,
} from "@cipher-quants/sdk";

import { Nav } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useProgram } from "@/components/providers/program";
import { usePoolState } from "@/lib/hooks/usePoolState";
import { useCurveFreshness } from "@/lib/hooks/useCurveFreshness";
import { useMintInfo } from "@/lib/hooks/useMintInfo";
import { POOL_CONFIG, API_BASE_URL } from "@/lib/pool-config";
import {
  formatTokenAmount,
  formatPrice,
  bpsToPct,
  shortAddr,
  isValidPubkeyString,
  parseDecimalAmount,
} from "@/lib/utils";

const DEFAULT_SLIPPAGE_BPS = 50;

// Priority-fee defaults (microLamports per CU).
//   0     → no compute-unit-price ix (cheapest, lowest landing odds)
//   1_000 → ~1× SOL-fee uplift at ~50 k CU per swap; safe devnet default
// During contested mainnet slots, 50_000 (≈ keeper Mode A) is a reasonable
// floor for RFQ swaps where landing in-slot matters.
const DEFAULT_PRIORITY_FEE_MICROLAMPORTS = 1_000;

export default function SwapPage() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { signingProgram, readonlyProgram } = useProgram();
  const { toast } = useToast();

  // Allow runtime overrides via inputs when env mints are absent
  const [baseMintInput, setBaseMintInput] = React.useState<string>(
    POOL_CONFIG.baseMint?.toBase58() ?? ""
  );
  const [quoteMintInput, setQuoteMintInput] = React.useState<string>(
    POOL_CONFIG.quoteMint?.toBase58() ?? ""
  );

  const baseMint = React.useMemo(
    () => (isValidPubkeyString(baseMintInput) ? new PublicKey(baseMintInput) : null),
    [baseMintInput]
  );
  const quoteMint = React.useMemo(
    () => (isValidPubkeyString(quoteMintInput) ? new PublicKey(quoteMintInput) : null),
    [quoteMintInput]
  );

  const { pool, poolAddress, loading: poolLoading, error: poolErr, refresh } = usePoolState(
    baseMint,
    quoteMint,
    5_000
  );
  const { base: baseMintInfo, quote: quoteMintInfo, error: mintErr } = useMintInfo(
    baseMint,
    quoteMint
  );
  const baseDecimals = baseMintInfo?.decimals ?? null;
  const quoteDecimals = quoteMintInfo?.decimals ?? null;

  const freshness = useCurveFreshness(
    pool?.state?.lastOracleUpdateSlot
      ? BigInt(pool.state.lastOracleUpdateSlot.toString())
      : null,
    pool?.state?.currentModeTtl ?? 0
  );

  const [direction, setDirection] = React.useState<Side>("buy");
  const inputDecimals = direction === "buy" ? quoteDecimals : baseDecimals;
  const outputDecimals = direction === "buy" ? baseDecimals : quoteDecimals;
  const [inputAmount, setInputAmount] = React.useState<string>("");
  const [slippageBps, setSlippageBps] = React.useState<string>(String(DEFAULT_SLIPPAGE_BPS));
  const [priorityFee, setPriorityFee] = React.useState<string>(
    String(DEFAULT_PRIORITY_FEE_MICROLAMPORTS)
  );
  const [submitting, setSubmitting] = React.useState<boolean>(false);
  const [vaultReserves, setVaultReserves] = React.useState<{ base: bigint; quote: bigint } | null>(null);

  // Priority-fee validation. Rejects non-numeric and absurd values; accepts 0
  // (skip the compute-unit-price ix entirely).
  const priorityFeeValidation = React.useMemo<
    { ok: true; microLamports: number } | { ok: false; error: string }
  >(() => {
    const raw = priorityFee.trim();
    if (raw === "") return { ok: true, microLamports: 0 };
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n))
      return { ok: false, error: "Must be a non-negative integer" };
    if (n < 0) return { ok: false, error: "Must be ≥ 0" };
    // Soft upper bound: 1 SOL per million CU is already absurd. Catch fat fingers.
    if (n > 10_000_000) return { ok: false, error: "Refusing > 10M µL/CU" };
    return { ok: true, microLamports: n };
  }, [priorityFee]);

  // Read vault balances on pool change (for client-side simulate)
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!pool || !baseMint || !quoteMint || !poolAddress) {
        setVaultReserves(null);
        return;
      }
      try {
        const [bv] = deriveVault(poolAddress, baseMint, readonlyProgram.programId);
        const [qv] = deriveVault(poolAddress, quoteMint, readonlyProgram.programId);
        const [ba, qa] = await Promise.all([
          connection.getTokenAccountBalance(bv).catch(() => null),
          connection.getTokenAccountBalance(qv).catch(() => null),
        ]);
        if (cancelled) return;
        setVaultReserves({
          base: ba ? BigInt(ba.value.amount) : 0n,
          quote: qa ? BigInt(qa.value.amount) : 0n,
        });
      } catch {
        if (!cancelled) setVaultReserves(null);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [connection, pool, poolAddress, baseMint, quoteMint, readonlyProgram.programId]);

  // Client-side ExactIn simulate (curve path only — RFQ price comes from /quote)
  const inputBig = React.useMemo(() => {
    if (inputDecimals == null) return null;
    return parseDecimalAmount(inputAmount, inputDecimals);
  }, [inputAmount, inputDecimals]);

  const simulation = React.useMemo(() => {
    if (!pool || !vaultReserves || inputBig == null) return null;
    try {
      const s = pool.state;
      return simulateSwap({
        fairValue: BigInt(s.fairValue.toString()),
        spreadBps: BigInt(s.spreadBps),
        depth: {
          depthCoefBps: BigInt(s.depthCurveParams.depthCoefBps),
          sizeUnit: BigInt(s.depthCurveParams.sizeUnit.toString()),
          maxDepthBps: BigInt(s.depthCurveParams.maxDepthBps),
        },
        skew: {
          targetBaseBps: BigInt(s.inventorySkewParams.targetBaseBps),
          skewCoefBps: BigInt(s.inventorySkewParams.skewCoefBps),
          maxSkewOffsetBps: BigInt(s.inventorySkewParams.maxSkewOffsetBps),
        },
        reservesBase: vaultReserves.base,
        reservesQuote: vaultReserves.quote,
        inputAmount: inputBig,
        direction,
      });
    } catch {
      return null;
    }
  }, [pool, vaultReserves, inputBig, direction]);

  // Slippage validation — do NOT silently fall back to 0 on invalid input.
  // A negative value yields 0% protection; >=10000 makes (10_000n - slipBps)
  // negative, so minOutput goes negative and the on-chain check is no-op.
  // Both are user-invisible footguns, so we reject them explicitly.
  const slippageValidation = React.useMemo<
    { ok: true; bps: bigint } | { ok: false; error: string }
  >(() => {
    const raw = slippageBps.trim();
    if (raw === "") return { ok: false, error: "Required" };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: "Must be a number" };
    if (n < 0) return { ok: false, error: "Must be >= 0" };
    if (n >= 10_000) return { ok: false, error: "Must be < 10000 (100%)" };
    return { ok: true, bps: BigInt(Math.floor(n)) };
  }, [slippageBps]);

  const minOutput = React.useMemo(() => {
    if (!simulation || !slippageValidation.ok) return 0n;
    return (simulation.outputAmount * (10_000n - slippageValidation.bps)) / 10_000n;
  }, [simulation, slippageValidation]);

  const inputTokenLabel = direction === "buy" ? "quote" : "base";
  const outputTokenLabel = direction === "buy" ? "base" : "quote";

  const onFlip = () =>
    setDirection((d) => (d === "buy" ? "sell" : "buy"));

  // ────────────────────────────────────────────────────────────────────
  // Submit handler
  // ────────────────────────────────────────────────────────────────────

  async function submitSwap() {
    if (!publicKey || !signingProgram) {
      toast({
        title: "Wallet not connected",
        description: "Connect a wallet to swap.",
        variant: "destructive",
      });
      return;
    }
    if (!pool || !poolAddress || !baseMint || !quoteMint) {
      toast({ title: "Pool not loaded", variant: "destructive" });
      return;
    }
    if (inputBig == null || inputBig <= 0n) {
      toast({ title: "Enter a positive amount", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const userBaseAta = getAssociatedTokenAddressSync(baseMint, publicKey);
      const userQuoteAta = getAssociatedTokenAddressSync(quoteMint, publicKey);
      const [baseVault] = deriveVault(poolAddress, baseMint, signingProgram.programId);
      const [quoteVault] = deriveVault(poolAddress, quoteMint, signingProgram.programId);

      const tx = new Transaction();

      // Prepend compute-unit-price ix when the user opted in (>0). 0 means
      // "let the validator pick" — fine for cheap clusters / dev.
      if (priorityFeeValidation.ok && priorityFeeValidation.microLamports > 0) {
        tx.add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFeeValidation.microLamports,
          })
        );
      }

      // Idempotent ATA creates for first-time users. No-op when both ATAs
      // already exist (~150 CU each); ~4 kCU each on first creation. Matches
      // the api server's /swap tx layout so the curve path here, the legacy
      // RFQ path below, and the JupiterZ-spec `tx` field all guarantee the
      // user's ATAs exist before `execute_swap` touches them.
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          userBaseAta,
          publicKey,
          baseMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          userQuoteAta,
          publicKey,
          quoteMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );

      if (freshness.isFresh) {
        // Curve path
        const ix = await createExecuteSwapIx(signingProgram, {
          user: publicKey,
          poolState: poolAddress,
          baseVault,
          quoteVault,
          userBaseAta,
          userQuoteAta,
          inputAmount: new BN(inputBig.toString()),
          direction,
          minOutput: new BN(minOutput.toString()),
          signedQuote: null,
        });
        tx.add(ix);
      } else {
        // RFQ path — JupiterZ two-step:
        //   1. POST /quote → price preview (NOT signed; MM has not committed)
        //   2. POST /swap  → MM re-checks state (last-look) and signs only if
        //                    the quote is still safe. The signed payload here
        //                    is the MM's commitment.
        const inputMint = direction === "buy" ? quoteMint : baseMint;
        const outputMint = direction === "buy" ? baseMint : quoteMint;
        const quoteResp = await fetch(`${API_BASE_URL}/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            inputMint: inputMint.toBase58(),
            outputMint: outputMint.toBase58(),
            inAmount: inputBig.toString(),
            userPubkey: publicKey.toBase58(),
          }),
        });
        if (!quoteResp.ok) {
          const errText = (await quoteResp.json().catch(() => ({})))?.error ?? quoteResp.statusText;
          throw new Error(`RFQ quote failed: ${errText}`);
        }
        const preview = await quoteResp.json();

        // Pre-flight expiry check — saves a /swap round-trip if the preview
        // already shows the quote is stale.
        const currentSlot = await connection.getSlot("confirmed");
        const quoteExpirySlot = Number(preview.expirySlot);
        if (Number.isFinite(quoteExpirySlot) && quoteExpirySlot <= currentSlot) {
          throw new Error(
            `Quote already expired (expiry=${quoteExpirySlot}, current=${currentSlot}). Try again.`
          );
        }

        // Redeem the preview at /swap. The MM signs here, after last-look
        // checks (drift, expiry, inventory). A 409/410/503 here means the
        // MM rejected — the user should request a fresh /quote.
        const swapResp = await fetch(`${API_BASE_URL}/swap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quoteId: preview.quoteId,
            userPubkey: publicKey.toBase58(),
          }),
        });
        if (!swapResp.ok) {
          const errText = (await swapResp.json().catch(() => ({})))?.error ?? swapResp.statusText;
          throw new Error(`Maker last-look rejected: ${errText}`);
        }
        const q = await swapResp.json();
        // `/swap` returns both the JupiterZ-spec `tx` (base64 VersionedTx
        // ready to sign + send) and an extra `components` block so callers
        // that prefer to assemble their own legacy `Transaction` shell can.
        // We stay on `components` here because the rest of this FE codepath
        // already adds priority-fee ix into the legacy Transaction wrapper.
        const sq = q.components.signedQuote;

        const signedQuote = {
          pool: new PublicKey(sq.pool),
          user: new PublicKey(sq.user),
          direction: sq.direction,
          inputAmount: new BN(sq.inputAmount),
          price: new BN(sq.price),
          expirySlot: new BN(sq.expirySlot),
          nonce: new BN(sq.nonce),
          signature: sq.signature,
        };

        // Verify ix from base64
        const verifyData = Uint8Array.from(atob(q.components.verifyIxBase64), (c) => c.charCodeAt(0));
        const verifyIx = new TransactionInstruction({
          keys: [],
          programId: new PublicKey(ED25519_PROGRAM_ID),
          data: Buffer.from(verifyData),
        });

        const quoteNonceMarker = new PublicKey(q.components.quoteNonceMarker);
        const swapIx = await createExecuteSwapIx(signingProgram, {
          user: publicKey,
          poolState: poolAddress,
          baseVault,
          quoteVault,
          userBaseAta,
          userQuoteAta,
          inputAmount: new BN(inputBig.toString()),
          direction,
          minOutput: new BN(minOutput.toString()),
          signedQuote,
          quoteNonceMarker,
        });
        tx.add(verifyIx, swapIx);
      }

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      toast({
        title: "Swap submitted",
        description: `Tx: ${shortAddr(sig, 8, 8)}`,
        variant: "success",
      });
      void refresh();
      setInputAmount("");
    } catch (e: any) {
      toast({
        title: "Swap failed",
        description: friendlyError(e),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────

  return (
    <>
      <Nav />
      <main className="container mx-auto max-w-2xl px-4 py-8">
        <h1 className="text-2xl font-bold mb-1">Swap</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Routes through the on-chain curve when fresh, or signed RFQ quotes otherwise.
        </p>

        {(!POOL_CONFIG.baseMint || !POOL_CONFIG.quoteMint) && (
          <Card className="mb-4 border-warning/40">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Pair selection</CardTitle>
              <CardDescription>
                Set NEXT_PUBLIC_BASE_MINT / NEXT_PUBLIC_QUOTE_MINT, or enter mints below.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              <div>
                <Label htmlFor="base-mint">Base mint</Label>
                <Input
                  id="base-mint"
                  value={baseMintInput}
                  onChange={(e) => setBaseMintInput(e.target.value.trim())}
                  placeholder="Base mint pubkey"
                  spellCheck={false}
                />
              </div>
              <div>
                <Label htmlFor="quote-mint">Quote mint</Label>
                <Input
                  id="quote-mint"
                  value={quoteMintInput}
                  onChange={(e) => setQuoteMintInput(e.target.value.trim())}
                  placeholder="Quote mint pubkey"
                  spellCheck={false}
                />
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-4 flex flex-row items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">
                {direction === "buy" ? "Buy base" : "Sell base"}
              </CardTitle>
              <CardDescription>ExactIn — you pay the input amount</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <FreshnessBadge isFresh={freshness.isFresh} ageSlots={freshness.ageSlots} ttl={freshness.ttl} paused={pool?.state?.paused ?? false} />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void refresh()}
                aria-label="Refresh"
              >
                <RefreshCw className="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {poolErr && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <ShieldAlert className="size-4 text-destructive mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium">Pool unavailable</div>
                  <div className="text-muted-foreground">{poolErr}</div>
                </div>
              </div>
            )}

            {pool?.state?.paused && (
              <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
                Pool is paused. Swaps are temporarily disabled.
              </div>
            )}

            {mintErr && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                Mint info unavailable: {mintErr}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="amount">
                You pay ({inputTokenLabel})
              </Label>
              <Input
                id="amount"
                value={inputAmount}
                onChange={(e) => setInputAmount(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                disabled={!pool}
              />
            </div>

            <div className="flex justify-center">
              <Button variant="outline" size="icon" onClick={onFlip} aria-label="Flip direction">
                <ArrowDownUp className="size-4" />
              </Button>
            </div>

            <div className="space-y-2">
              <Label>You receive (≈ {outputTokenLabel})</Label>
              <div className="flex h-10 items-center rounded-md border border-input bg-muted/40 px-3 text-sm font-mono">
                {simulation && outputDecimals != null
                  ? formatTokenAmount(simulation.outputAmount, outputDecimals, 6)
                  : poolLoading
                    ? <Skeleton className="h-4 w-24" />
                    : "—"}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Quote price" value={simulation ? formatPrice(simulation.price, PRICE_SCALE) : "—"} />
              <Stat
                label="Min out (slippage)"
                value={simulation && outputDecimals != null ? formatTokenAmount(minOutput, outputDecimals, 6) : "—"}
              />
              <Stat label="Spread" value={pool ? bpsToPct(pool.state.spreadBps) : "—"} />
              <Stat label="Mode TTL" value={pool ? `${pool.state.currentModeTtl} slots` : "—"} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="slippage">Slippage (bps)</Label>
                <Input
                  id="slippage"
                  value={slippageBps}
                  onChange={(e) => setSlippageBps(e.target.value)}
                  placeholder="50"
                  inputMode="numeric"
                  aria-invalid={!slippageValidation.ok}
                />
                {!slippageValidation.ok && (
                  <div className="text-xs text-destructive">
                    {slippageValidation.error}
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="priority-fee">
                  Priority fee (µL/CU)
                </Label>
                <Input
                  id="priority-fee"
                  value={priorityFee}
                  onChange={(e) => setPriorityFee(e.target.value)}
                  placeholder="1000"
                  inputMode="numeric"
                  aria-invalid={!priorityFeeValidation.ok}
                />
                {!priorityFeeValidation.ok ? (
                  <div className="text-xs text-destructive">
                    {priorityFeeValidation.error}
                  </div>
                ) : (
                  <div className="text-[10px] text-muted-foreground">
                    0 = none. Raise during congested slots.
                  </div>
                )}
              </div>
            </div>

            <Button
              className="w-full"
              size="lg"
              disabled={
                !publicKey ||
                !pool ||
                pool.state.paused ||
                submitting ||
                !simulation ||
                !slippageValidation.ok ||
                !priorityFeeValidation.ok
              }
              onClick={() => void submitSwap()}
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Submitting…
                </>
              ) : !publicKey ? (
                "Connect wallet"
              ) : !pool ? (
                "Loading pool…"
              ) : pool.state.paused ? (
                "Pool paused"
              ) : freshness.isFresh ? (
                "Swap via curve"
              ) : (
                "Swap via RFQ"
              )}
            </Button>
          </CardContent>
        </Card>

        {pool && (
          <Card className="mt-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Pool</CardTitle>
            </CardHeader>
            <CardContent className="text-xs grid grid-cols-2 gap-y-1 gap-x-4">
              <span className="text-muted-foreground">Address</span>
              <span className="font-mono truncate">{poolAddress ? shortAddr(poolAddress.toBase58(), 8, 8) : "—"}</span>
              <span className="text-muted-foreground">Fair value</span>
              <span className="font-mono">{formatPrice(BigInt(pool.state.fairValue.toString()), PRICE_SCALE)}</span>
              <span className="text-muted-foreground">Last oracle slot</span>
              <span className="font-mono">{pool.state.lastOracleUpdateSlot.toString()}</span>
              <span className="text-muted-foreground">Curve age</span>
              <span className="font-mono">{freshness.ageSlots ?? "—"} slots</span>
              <span className="text-muted-foreground">Base reserves</span>
              <span className="font-mono">
                {vaultReserves && baseDecimals != null
                  ? formatTokenAmount(vaultReserves.base, baseDecimals, 4)
                  : "—"}
              </span>
              <span className="text-muted-foreground">Quote reserves</span>
              <span className="font-mono">
                {vaultReserves && quoteDecimals != null
                  ? formatTokenAmount(vaultReserves.quote, quoteDecimals, 4)
                  : "—"}
              </span>
            </CardContent>
          </Card>
        )}
      </main>
    </>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-muted/20 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  );
}

function FreshnessBadge({
  isFresh,
  ageSlots,
  ttl,
  paused,
}: {
  isFresh: boolean;
  ageSlots: number | null;
  ttl: number;
  paused: boolean;
}) {
  if (paused) return <Badge variant="destructive">Paused</Badge>;
  if (ttl === 0) return <Badge variant="warning">RFQ only</Badge>;
  if (isFresh) return <Badge variant="success">Curve · {ageSlots ?? 0}/{ttl}</Badge>;
  return <Badge variant="warning">Stale → RFQ</Badge>;
}
