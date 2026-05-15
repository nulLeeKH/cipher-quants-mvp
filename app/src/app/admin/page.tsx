"use client";

import * as React from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { RefreshCw, Activity } from "lucide-react";

import {
  deriveVault,
  PRICE_SCALE,
} from "@solana-boilerplate/sdk";

import { AdminGuard } from "@/components/admin/AdminGuard";
import { AdminNav } from "@/components/admin/AdminNav";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useProgram } from "@/components/providers/program";
import { usePoolState } from "@/lib/hooks/usePoolState";
import { useCurveFreshness } from "@/lib/hooks/useCurveFreshness";
import { useMintInfo } from "@/lib/hooks/useMintInfo";
import { useAdminSession } from "@/lib/auth/session";
import { POOL_CONFIG } from "@/lib/pool-config";
import {
  formatPrice,
  formatTokenAmount,
  bpsToPct,
  shortAddr,
  isValidPubkeyString,
} from "@/lib/utils";

export default function AdminDashboardPage() {
  return (
    <AdminGuard>
      <AdminNav />
      <Dashboard />
    </AdminGuard>
  );
}

function Dashboard() {
  const { connection } = useConnection();
  const { readonlyProgram } = useProgram();
  const { session } = useAdminSession();

  const [baseMintInput, setBaseMintInput] = React.useState(POOL_CONFIG.baseMint?.toBase58() ?? "");
  const [quoteMintInput, setQuoteMintInput] = React.useState(POOL_CONFIG.quoteMint?.toBase58() ?? "");

  const baseMint = React.useMemo(
    () => (isValidPubkeyString(baseMintInput) ? new PublicKey(baseMintInput) : null),
    [baseMintInput]
  );
  const quoteMint = React.useMemo(
    () => (isValidPubkeyString(quoteMintInput) ? new PublicKey(quoteMintInput) : null),
    [quoteMintInput]
  );

  const { pool, poolAddress, refresh, loading, error } = usePoolState(baseMint, quoteMint, 4_000);
  const { base: baseMintInfo, quote: quoteMintInfo } = useMintInfo(baseMint, quoteMint);
  const baseDecimals = baseMintInfo?.decimals ?? null;
  const quoteDecimals = quoteMintInfo?.decimals ?? null;
  const freshness = useCurveFreshness(
    pool?.state?.lastOracleUpdateSlot ? BigInt(pool.state.lastOracleUpdateSlot.toString()) : null,
    pool?.state?.currentModeTtl ?? 0
  );

  const [vaultBalances, setVaultBalances] = React.useState<{ base: bigint; quote: bigint } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!pool || !poolAddress || !baseMint || !quoteMint) {
        setVaultBalances(null);
        return;
      }
      const [bv] = deriveVault(poolAddress, baseMint, readonlyProgram.programId);
      const [qv] = deriveVault(poolAddress, quoteMint, readonlyProgram.programId);
      try {
        const [ba, qa] = await Promise.all([
          connection.getTokenAccountBalance(bv),
          connection.getTokenAccountBalance(qv),
        ]);
        if (cancelled) return;
        setVaultBalances({
          base: BigInt(ba.value.amount),
          quote: BigInt(qa.value.amount),
        });
      } catch {
        if (!cancelled) setVaultBalances(null);
      }
    }
    void load();
    const id = window.setInterval(load, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connection, pool, poolAddress, baseMint, quoteMint, readonlyProgram.programId]);

  // Event history
  const [history, setHistory] = React.useState<any[] | null>(null);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [historyError, setHistoryError] = React.useState<string | null>(null);

  const loadHistory = React.useCallback(async () => {
    if (!session || !poolAddress) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await fetch(`/api/history?pool=${poolAddress.toBase58()}&limit=25`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? res.statusText);
      }
      const data = await res.json();
      setHistory(data.items);
    } catch (e: any) {
      setHistoryError(e.message);
    } finally {
      setHistoryLoading(false);
    }
  }, [session, poolAddress]);

  React.useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  return (
    <main className="container mx-auto max-w-5xl px-4 py-6 space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Pool dashboard</h1>
          <p className="text-sm text-muted-foreground">Live pool state, vaults, and event history</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="size-3.5 mr-2" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Pair</CardTitle>
          <CardDescription>Provide pool mints (env override available)</CardDescription>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-3">
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

      {error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="pt-6 text-sm text-destructive-foreground">
            {error}
          </CardContent>
        </Card>
      )}

      {loading && !pool ? (
        <Card>
          <CardContent className="pt-6 space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </CardContent>
        </Card>
      ) : pool ? (
        <>
          <div className="grid md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Status</CardDescription>
                <CardTitle className="flex items-center gap-2">
                  {pool.state.paused ? (
                    <Badge variant="destructive">Paused</Badge>
                  ) : freshness.ttl === 0 ? (
                    <Badge variant="warning">RFQ only</Badge>
                  ) : freshness.isFresh ? (
                    <Badge variant="success">Curve fresh</Badge>
                  ) : (
                    <Badge variant="warning">Stale → RFQ</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                TTL {pool.state.currentModeTtl} slots · age {freshness.ageSlots ?? "—"} slots
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Fair value</CardDescription>
                <CardTitle className="font-mono text-xl">
                  {formatPrice(BigInt(pool.state.fairValue.toString()), PRICE_SCALE)}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Spread {bpsToPct(pool.state.spreadBps)}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Oracle nonce</CardDescription>
                <CardTitle className="font-mono text-xl">
                  {pool.state.oracleNonce.toString()}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Slot {pool.state.lastOracleUpdateSlot.toString()}
              </CardContent>
            </Card>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Vault balances</CardTitle>
              </CardHeader>
              <CardContent className="font-mono text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Base</span>
                  <span>
                    {vaultBalances && baseDecimals != null
                      ? formatTokenAmount(vaultBalances.base, baseDecimals, 6)
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Quote</span>
                  <span>
                    {vaultBalances && quoteDecimals != null
                      ? formatTokenAmount(vaultBalances.quote, quoteDecimals, 6)
                      : "—"}
                  </span>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Identity</CardTitle>
              </CardHeader>
              <CardContent className="font-mono text-xs space-y-1">
                <Row label="Pool" value={poolAddress ? shortAddr(poolAddress.toBase58(), 10, 10) : "—"} />
                <Row label="Admin" value={shortAddr(pool.state.admin.toBase58(), 10, 10)} />
                <Row label="Oracle signer" value={shortAddr(pool.state.authorizedOracleSigner.toBase58(), 10, 10)} />
                <Row label="Base mint" value={shortAddr(pool.state.baseMint.toBase58(), 10, 10)} />
                <Row label="Quote mint" value={shortAddr(pool.state.quoteMint.toBase58(), 10, 10)} />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="size-4" />
                <CardTitle className="text-base">Event history</CardTitle>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void loadHistory()}>
                <RefreshCw className="size-3.5 mr-1.5" />
                Reload
              </Button>
            </CardHeader>
            <CardContent>
              {historyError && (
                <div className="text-sm text-destructive">{historyError}</div>
              )}
              {historyLoading && !history ? (
                <Skeleton className="h-32 w-full" />
              ) : history && history.length > 0 ? (
                <div className="space-y-2 max-h-[420px] overflow-y-auto">
                  {history.map((ev, i) => (
                    <div
                      key={`${ev.signature}-${i}`}
                      className="rounded-md border bg-muted/20 p-3 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <Badge variant="outline">{ev.name}</Badge>
                        <span className="font-mono text-muted-foreground">
                          slot {ev.slot}
                        </span>
                      </div>
                      <div className="font-mono text-muted-foreground break-all">
                        {shortAddr(ev.signature, 8, 8)}
                      </div>
                      <pre className="font-mono text-[10px] whitespace-pre-wrap break-all bg-background/60 p-2 rounded">
                        {JSON.stringify(ev.data, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">No events.</div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </main>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}
