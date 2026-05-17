"use client";

import * as React from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { BN } from "@cipher-quants/sdk";
import { ArrowDownToLine, ArrowUpFromLine, Loader2 } from "lucide-react";

import {
  deriveVault,
  createAdminWithdrawInventoryIx,
  friendlyError,
} from "@cipher-quants/sdk";

import { AdminGuard } from "@/components/admin/AdminGuard";
import { AdminNav } from "@/components/admin/AdminNav";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useProgram } from "@/components/providers/program";
import { usePoolState } from "@/lib/hooks/usePoolState";
import { useMintInfo } from "@/lib/hooks/useMintInfo";
import { POOL_CONFIG } from "@/lib/pool-config";
import {
  formatTokenAmount,
  isValidPubkeyString,
  parseDecimalAmount,
  shortAddr,
} from "@/lib/utils";

export default function AdminInventoryPage() {
  return (
    <AdminGuard>
      <AdminNav />
      <InventoryView />
    </AdminGuard>
  );
}

function InventoryView() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { signingProgram, readonlyProgram } = useProgram();
  const { toast } = useToast();

  const [baseMintInput, setBaseMintInput] = React.useState(POOL_CONFIG.baseMint?.toBase58() ?? "");
  const [quoteMintInput, setQuoteMintInput] = React.useState(POOL_CONFIG.quoteMint?.toBase58() ?? "");
  const bm = isValidPubkeyString(baseMintInput) ? new PublicKey(baseMintInput) : null;
  const qm = isValidPubkeyString(quoteMintInput) ? new PublicKey(quoteMintInput) : null;
  const { pool, poolAddress, refresh } = usePoolState(bm, qm, 6_000);
  const { base: baseMintInfo, quote: quoteMintInfo } = useMintInfo(bm, qm);
  const baseDecimals = baseMintInfo?.decimals ?? null;
  const quoteDecimals = quoteMintInfo?.decimals ?? null;

  const [vault, setVault] = React.useState<{ base: bigint; quote: bigint }>({ base: 0n, quote: 0n });

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!pool || !poolAddress || !bm || !qm) return;
      const [bv] = deriveVault(poolAddress, bm, readonlyProgram.programId);
      const [qv] = deriveVault(poolAddress, qm, readonlyProgram.programId);
      try {
        const [ba, qa] = await Promise.all([
          connection.getTokenAccountBalance(bv).catch(() => null),
          connection.getTokenAccountBalance(qv).catch(() => null),
        ]);
        if (cancelled) return;
        setVault({
          base: ba ? BigInt(ba.value.amount) : 0n,
          quote: qa ? BigInt(qa.value.amount) : 0n,
        });
      } catch { /* ignore */ }
    }
    void load();
    const id = window.setInterval(load, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connection, pool, poolAddress, bm, qm, readonlyProgram.programId]);

  // ────────────────────────────────────────────────────────────────────
  // Deposit (SPL transfer admin ATA → vault)
  // ────────────────────────────────────────────────────────────────────
  const [depositSide, setDepositSide] = React.useState<"base" | "quote">("base");
  const [depositAmount, setDepositAmount] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);

  async function doDeposit() {
    if (!publicKey || !pool || !poolAddress || !bm || !qm || !signingProgram) return;
    const depDecimals = depositSide === "base" ? baseDecimals : quoteDecimals;
    if (depDecimals == null) {
      toast({ title: "Mint decimals not loaded yet", variant: "destructive" });
      return;
    }
    const amt = parseDecimalAmount(depositAmount, depDecimals);
    if (amt == null || amt <= 0n) {
      toast({ title: "Enter a positive amount", variant: "destructive" });
      return;
    }
    setBusy("deposit");
    try {
      const mint = depositSide === "base" ? bm : qm;
      const [vaultPda] = deriveVault(poolAddress, mint, signingProgram.programId);
      const adminAta = getAssociatedTokenAddressSync(mint, publicKey);

      const tx = new Transaction();
      tx.add(
        createTransferInstruction(adminAta, vaultPda, publicKey, amt)
      );
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      toast({ title: "Deposit confirmed", description: shortAddr(sig, 8, 8), variant: "success" });
      setDepositAmount("");
      void refresh();
    } catch (e: any) {
      toast({ title: "Deposit failed", description: friendlyError(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Withdraw
  // ────────────────────────────────────────────────────────────────────
  const [withdrawBase, setWithdrawBase] = React.useState("");
  const [withdrawQuote, setWithdrawQuote] = React.useState("");

  async function doWithdraw() {
    if (!publicKey || !pool || !poolAddress || !bm || !qm || !signingProgram) return;
    if (baseDecimals == null || quoteDecimals == null) {
      toast({ title: "Mint decimals not loaded yet", variant: "destructive" });
      return;
    }
    const baseAmt = withdrawBase.trim()
      ? (parseDecimalAmount(withdrawBase, baseDecimals) ?? -1n)
      : 0n;
    const quoteAmt = withdrawQuote.trim()
      ? (parseDecimalAmount(withdrawQuote, quoteDecimals) ?? -1n)
      : 0n;
    if (baseAmt < 0n || quoteAmt < 0n) {
      toast({ title: "Invalid amount", variant: "destructive" });
      return;
    }
    if (baseAmt === 0n && quoteAmt === 0n) {
      toast({ title: "Both amounts are zero", variant: "destructive" });
      return;
    }
    setBusy("withdraw");
    try {
      const [baseVault] = deriveVault(poolAddress, bm, signingProgram.programId);
      const [quoteVault] = deriveVault(poolAddress, qm, signingProgram.programId);
      const adminBaseAta = getAssociatedTokenAddressSync(bm, publicKey);
      const adminQuoteAta = getAssociatedTokenAddressSync(qm, publicKey);

      const tx = new Transaction();
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(publicKey, adminBaseAta, publicKey, bm),
        createAssociatedTokenAccountIdempotentInstruction(publicKey, adminQuoteAta, publicKey, qm)
      );
      const withdrawIx = await createAdminWithdrawInventoryIx(signingProgram, {
        admin: publicKey,
        poolState: poolAddress,
        baseVault,
        quoteVault,
        adminBaseAta,
        adminQuoteAta,
        withdrawBaseAmount: new BN(baseAmt.toString()),
        withdrawQuoteAmount: new BN(quoteAmt.toString()),
      });
      tx.add(withdrawIx);

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      toast({ title: "Withdraw confirmed", description: shortAddr(sig, 8, 8), variant: "success" });
      setWithdrawBase("");
      setWithdrawQuote("");
      void refresh();
    } catch (e: any) {
      toast({ title: "Withdraw failed", description: friendlyError(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="container mx-auto max-w-3xl px-4 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Inventory</h1>
        <p className="text-sm text-muted-foreground">
          Deposit (SPL Token transfer) or withdraw via admin_withdraw_inventory
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Pair</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="bm">Base mint</Label>
            <Input id="bm" value={baseMintInput} onChange={(e) => setBaseMintInput(e.target.value.trim())} spellCheck={false} />
          </div>
          <div>
            <Label htmlFor="qm">Quote mint</Label>
            <Input id="qm" value={quoteMintInput} onChange={(e) => setQuoteMintInput(e.target.value.trim())} spellCheck={false} />
          </div>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardDescription>
              Base vault {baseDecimals != null && <span className="text-[10px]">({baseDecimals}dp)</span>}
            </CardDescription>
            <CardTitle className="text-2xl font-mono">
              {baseDecimals != null ? formatTokenAmount(vault.base, baseDecimals, 6) : "—"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>
              Quote vault {quoteDecimals != null && <span className="text-[10px]">({quoteDecimals}dp)</span>}
            </CardDescription>
            <CardTitle className="text-2xl font-mono">
              {quoteDecimals != null ? formatTokenAmount(vault.quote, quoteDecimals, 6) : "—"}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Deposit */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ArrowDownToLine className="size-4" />
            Deposit
          </CardTitle>
          <CardDescription>SPL Token transfer from your wallet ATA → pool vault PDA</CardDescription>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="dep-side">Side</Label>
            <Select
              id="dep-side"
              value={depositSide}
              onChange={(e) => setDepositSide(e.target.value as "base" | "quote")}
            >
              <option value="base">Base</option>
              <option value="quote">Quote</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="dep-amt">Amount</Label>
            <Input id="dep-amt" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={() => void doDeposit()} disabled={busy != null || !pool}>
            {busy === "deposit" ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Depositing…
              </>
            ) : (
              "Deposit"
            )}
          </Button>
        </CardFooter>
      </Card>

      {/* Withdraw */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ArrowUpFromLine className="size-4" />
            Withdraw
          </CardTitle>
          <CardDescription>admin_withdraw_inventory — both amounts may be zero except one</CardDescription>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="w-base">Base amount</Label>
            <Input id="w-base" value={withdrawBase} onChange={(e) => setWithdrawBase(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </div>
          <div>
            <Label htmlFor="w-quote">Quote amount</Label>
            <Input id="w-quote" value={withdrawQuote} onChange={(e) => setWithdrawQuote(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={() => void doWithdraw()} disabled={busy != null || !pool}>
            {busy === "withdraw" ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Withdrawing…
              </>
            ) : (
              "Withdraw"
            )}
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
