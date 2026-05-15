"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";

import { Nav } from "@/components/nav";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { useAdminSession } from "@/lib/auth/session";
import { formatChallengeMessage } from "@/lib/auth/message";
import { POOL_CONFIG } from "@/lib/pool-config";
import { shortAddr, isValidPubkeyString } from "@/lib/utils";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

export default function AdminLoginPage() {
  const router = useRouter();
  const { publicKey, signMessage, signTransaction, wallet } = useWallet();
  const { connection } = useConnection();
  const { session, hydrated, refresh } = useAdminSession();
  const { toast } = useToast();

  const [baseMint, setBaseMint] = React.useState(POOL_CONFIG.baseMint?.toBase58() ?? "");
  const [quoteMint, setQuoteMint] = React.useState(POOL_CONFIG.quoteMint?.toBase58() ?? "");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (hydrated && session) router.replace("/admin");
  }, [hydrated, session, router]);

  async function authenticate() {
    if (!publicKey) {
      toast({ title: "Connect wallet first", variant: "destructive" });
      return;
    }
    const canSignMessage = typeof signMessage === "function";
    const canSignTransaction = typeof signTransaction === "function";
    if (!canSignMessage && !canSignTransaction) {
      toast({
        title: "Wallet cannot sign",
        description: `${wallet?.adapter.name ?? "Wallet"} supports neither signMessage nor signTransaction.`,
        variant: "destructive",
      });
      return;
    }

    setBusy(true);
    try {
      // 1) Get challenge from server
      const challengeResp = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        credentials: "same-origin",
      });
      if (!challengeResp.ok) throw new Error(`challenge: ${challengeResp.statusText}`);
      const { token: challengeToken, nonce, issuedAt } = await challengeResp.json();

      const message = formatChallengeMessage({
        nonce,
        pool: undefined,
        pubkey: publicKey.toBase58(),
        issuedAt,
      });
      const messageBytes = new TextEncoder().encode(message);

      const verifyBody: Record<string, unknown> = {
        challengeToken,
        pubkey: publicKey.toBase58(),
        issuedAt,
        baseMint: isValidPubkeyString(baseMint) ? baseMint : undefined,
        quoteMint: isValidPubkeyString(quoteMint) ? quoteMint : undefined,
      };

      if (canSignMessage) {
        // ────── Path A: signMessage (Phantom/Solflare/Backpack) ──────
        const signature = await signMessage!(messageBytes);
        verifyBody.kind = "message";
        verifyBody.signature = btoa(String.fromCharCode(...signature));
      } else {
        // ────── Path B: signTransaction with Memo ix (Ledger) ──────
        const memoIx = new TransactionInstruction({
          keys: [],
          programId: MEMO_PROGRAM_ID,
          data: Buffer.from(messageBytes),
        });
        const tx = new Transaction().add(memoIx);
        tx.feePayer = publicKey;
        // recentBlockhash required for tx serialization
        const { blockhash } = await connection.getLatestBlockhash("finalized");
        tx.recentBlockhash = blockhash;

        const signed = await signTransaction!(tx);
        verifyBody.kind = "transaction";
        verifyBody.transaction = signed
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString("base64");
      }

      // 2) Verify on server (sets httpOnly cookie on success)
      const verifyResp = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(verifyBody),
        credentials: "same-origin",
      });
      if (!verifyResp.ok) {
        const data = await verifyResp.json().catch(() => ({}));
        throw new Error(data.error ?? verifyResp.statusText);
      }

      // 3) Pull new session from /me and navigate
      await refresh();
      toast({ title: "Signed in", variant: "success" });
      router.replace("/admin");
    } catch (e: any) {
      toast({
        title: "Authentication failed",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  const usingLedger =
    publicKey && typeof signMessage !== "function" && typeof signTransaction === "function";

  return (
    <>
      <Nav />
      <main className="container mx-auto max-w-md px-4 py-12">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-primary" />
              <CardTitle>Admin sign-in</CardTitle>
            </div>
            <CardDescription>
              Verify wallet ownership and admin authority via signed challenge.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!publicKey ? (
              <div className="flex justify-center py-2">
                <WalletMultiButton
                  style={{
                    backgroundColor: "hsl(var(--primary))",
                    color: "hsl(var(--primary-foreground))",
                    height: "40px",
                    padding: "0 16px",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: 500,
                  }}
                />
              </div>
            ) : (
              <div className="text-xs text-muted-foreground space-y-1">
                <div>
                  Signing as <span className="font-mono">{shortAddr(publicKey.toBase58())}</span>
                </div>
                {usingLedger && (
                  <div className="text-foreground">
                    <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px]">
                      Ledger mode
                    </span>{" "}
                    Will sign a Memo transaction instead of an arbitrary message.
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="base">Base mint (optional — for admin check)</Label>
              <Input
                id="base"
                value={baseMint}
                onChange={(e) => setBaseMint(e.target.value.trim())}
                placeholder="Base mint pubkey"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quote">Quote mint</Label>
              <Input
                id="quote"
                value={quoteMint}
                onChange={(e) => setQuoteMint(e.target.value.trim())}
                placeholder="Quote mint pubkey"
                spellCheck={false}
              />
            </div>

            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
              <ShieldAlert className="size-4 text-warning mt-0.5 flex-shrink-0" />
              <div>
                If you supply base/quote mints, the server reads the pool and rejects sign-in unless your wallet matches <code className="font-mono">pool.admin</code>. Leave blank for a generic session token.
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button
              className="w-full"
              disabled={!publicKey || busy}
              onClick={() => void authenticate()}
            >
              {busy ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Signing…
                </>
              ) : (
                "Sign challenge & sign in"
              )}
            </Button>
          </CardFooter>
        </Card>
      </main>
    </>
  );
}
