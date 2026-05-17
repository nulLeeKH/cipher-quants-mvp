"use client";

import * as React from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { AlertTriangle, Loader2 } from "lucide-react";

import {
  createSetPausedIx,
  createRotateOracleSignerIx,
  createRotateAdminIx,
  friendlyError,
} from "@cipher-quants/sdk";

import { AdminGuard } from "@/components/admin/AdminGuard";
import { AdminNav } from "@/components/admin/AdminNav";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { useProgram } from "@/components/providers/program";
import { usePoolState } from "@/lib/hooks/usePoolState";
import { POOL_CONFIG } from "@/lib/pool-config";
import { isValidPubkeyString, shortAddr } from "@/lib/utils";

export default function AdminActionsPage() {
  return (
    <AdminGuard>
      <AdminNav />
      <ActionsView />
    </AdminGuard>
  );
}

function ActionsView() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { signingProgram } = useProgram();
  const { toast } = useToast();

  const baseMint = POOL_CONFIG.baseMint;
  const quoteMint = POOL_CONFIG.quoteMint;
  const [baseMintInput, setBaseMintInput] = React.useState(baseMint?.toBase58() ?? "");
  const [quoteMintInput, setQuoteMintInput] = React.useState(quoteMint?.toBase58() ?? "");
  const bm = isValidPubkeyString(baseMintInput) ? new PublicKey(baseMintInput) : null;
  const qm = isValidPubkeyString(quoteMintInput) ? new PublicKey(quoteMintInput) : null;
  const { pool, poolAddress, refresh } = usePoolState(bm, qm, 8_000);

  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = React.useState<null | {
    title: string;
    description: string;
    action: () => Promise<void>;
  }>(null);

  async function runIx(label: string, build: () => Promise<Transaction>) {
    if (!publicKey || !signingProgram) {
      toast({ title: "Wallet not connected", variant: "destructive" });
      return;
    }
    setBusy(label);
    try {
      const tx = await build();
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      toast({
        title: `${label} succeeded`,
        description: shortAddr(sig, 8, 8),
        variant: "success",
      });
      void refresh();
    } catch (e: any) {
      toast({
        title: `${label} failed`,
        description: friendlyError(e),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
      setConfirmDialog(null);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // set_paused
  // ────────────────────────────────────────────────────────────────────
  const togglePaused = async () => {
    if (!pool || !poolAddress || !publicKey || !signingProgram) return;
    const next = !pool.state.paused;
    await runIx(next ? "Pause pool" : "Resume pool", async () => {
      const ix = await createSetPausedIx(signingProgram, {
        admin: publicKey,
        poolState: poolAddress,
        paused: next,
      });
      return new Transaction().add(ix);
    });
  };

  // ────────────────────────────────────────────────────────────────────
  // rotate_oracle_signer
  // ────────────────────────────────────────────────────────────────────
  const [newOracleSigner, setNewOracleSigner] = React.useState("");
  const rotateOracleSigner = async () => {
    if (!pool || !poolAddress || !publicKey || !signingProgram) return;
    if (!isValidPubkeyString(newOracleSigner)) {
      toast({ title: "Invalid pubkey", variant: "destructive" });
      return;
    }
    const nextPk = new PublicKey(newOracleSigner);
    await runIx("Rotate oracle signer", async () => {
      const ix = await createRotateOracleSignerIx(signingProgram, {
        admin: publicKey,
        poolState: poolAddress,
        newAuthorizedOracleSigner: nextPk,
      });
      return new Transaction().add(ix);
    });
    setNewOracleSigner("");
  };

  // ────────────────────────────────────────────────────────────────────
  // rotate_admin
  // ────────────────────────────────────────────────────────────────────
  const [newAdmin, setNewAdmin] = React.useState("");
  const rotateAdmin = async () => {
    if (!pool || !poolAddress || !publicKey || !signingProgram) return;
    if (!isValidPubkeyString(newAdmin)) {
      toast({ title: "Invalid pubkey", variant: "destructive" });
      return;
    }
    const nextPk = new PublicKey(newAdmin);
    await runIx("Rotate admin", async () => {
      const ix = await createRotateAdminIx(signingProgram, {
        admin: publicKey,
        poolState: poolAddress,
        newAdmin: nextPk,
      });
      return new Transaction().add(ix);
    });
    setNewAdmin("");
  };

  return (
    <main className="container mx-auto max-w-3xl px-4 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Actions</h1>
        <p className="text-sm text-muted-foreground">Admin-only state mutations</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Pair</CardTitle>
          <CardDescription>Pool mints</CardDescription>
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

      {/* Pause toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            Pause / Resume{" "}
            {pool?.state?.paused ? (
              <Badge variant="destructive">Currently paused</Badge>
            ) : (
              <Badge variant="success">Active</Badge>
            )}
          </CardTitle>
          <CardDescription>Halts execute_swap immediately. Reversible.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button
            variant={pool?.state?.paused ? "default" : "destructive"}
            onClick={() =>
              setConfirmDialog({
                title: pool?.state?.paused ? "Resume pool?" : "Pause pool?",
                description: pool?.state?.paused
                  ? "Re-enables swap execution."
                  : "Stops all swaps until resumed. Existing positions are unaffected.",
                action: togglePaused,
              })
            }
            disabled={!pool || busy != null}
          >
            {busy === "Pause pool" || busy === "Resume pool" ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Submitting…
              </>
            ) : pool?.state?.paused ? (
              "Resume pool"
            ) : (
              "Pause pool"
            )}
          </Button>
        </CardFooter>
      </Card>

      {/* Rotate oracle signer */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rotate oracle signer</CardTitle>
          <CardDescription>
            Current:{" "}
            <span className="font-mono">
              {pool ? shortAddr(pool.state.authorizedOracleSigner.toBase58(), 10, 10) : "—"}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="new-oracle">New authorized oracle signer</Label>
          <Input
            id="new-oracle"
            value={newOracleSigner}
            onChange={(e) => setNewOracleSigner(e.target.value.trim())}
            placeholder="Pubkey"
            spellCheck={false}
          />
        </CardContent>
        <CardFooter>
          <Button
            disabled={!pool || !isValidPubkeyString(newOracleSigner) || busy != null}
            onClick={() =>
              setConfirmDialog({
                title: "Rotate oracle signer?",
                description: `Authorized signer becomes ${shortAddr(newOracleSigner, 10, 10)}. Existing pending oracle pushes from the old key will fail.`,
                action: rotateOracleSigner,
              })
            }
          >
            {busy === "Rotate oracle signer" ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Submitting…
              </>
            ) : (
              "Rotate"
            )}
          </Button>
        </CardFooter>
      </Card>

      {/* Rotate admin */}
      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" />
            Rotate admin
          </CardTitle>
          <CardDescription>
            Current:{" "}
            <span className="font-mono">
              {pool ? shortAddr(pool.state.admin.toBase58(), 10, 10) : "—"}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="new-admin">New admin pubkey</Label>
          <Input
            id="new-admin"
            value={newAdmin}
            onChange={(e) => setNewAdmin(e.target.value.trim())}
            placeholder="Pubkey"
            spellCheck={false}
          />
          <div className="text-xs text-destructive flex items-start gap-2 mt-1">
            <AlertTriangle className="size-3.5 mt-0.5 flex-shrink-0" />
            Irreversible. The current admin loses all privileges after this transaction confirms.
          </div>
        </CardContent>
        <CardFooter>
          <Button
            variant="destructive"
            disabled={!pool || !isValidPubkeyString(newAdmin) || busy != null}
            onClick={() =>
              setConfirmDialog({
                title: "Rotate admin?",
                description: `Admin becomes ${shortAddr(newAdmin, 10, 10)}. This action is IRREVERSIBLE — you cannot undo it without the new admin's cooperation.`,
                action: rotateAdmin,
              })
            }
          >
            {busy === "Rotate admin" ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Submitting…
              </>
            ) : (
              "Rotate admin"
            )}
          </Button>
        </CardFooter>
      </Card>

      <Dialog
        open={confirmDialog != null}
        onClose={() => setConfirmDialog(null)}
        title={confirmDialog?.title}
        description={confirmDialog?.description}
      >
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={() => setConfirmDialog(null)} disabled={busy != null}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void confirmDialog?.action()}
            disabled={busy != null}
          >
            {busy ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Submitting…
              </>
            ) : (
              "Confirm"
            )}
          </Button>
        </div>
      </Dialog>
    </main>
  );
}
