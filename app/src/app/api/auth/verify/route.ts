import { NextResponse } from "next/server";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { AnchorProvider, Program } from "@coral-xyz/anchor";

import {
  IDL,
  PROGRAM_ID,
  fetchPoolState,
  derivePoolState,
} from "@solana-boilerplate/sdk";

import { verifyChallenge, issueSession } from "@/lib/auth/jwt";
import { formatChallengeMessage } from "@/lib/auth/message";
import { setSessionCookie } from "@/lib/auth/cookies";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";

// Solana SPL Memo v2 program id
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// ============================================================================
// Request shape
// ============================================================================
// Two signing methods supported, discriminated by `kind`:
//
//   { kind: "message",     challengeToken, pubkey, signature, issuedAt }
//     — wallet.signMessage (Phantom/Solflare/Backpack)
//
//   { kind: "transaction", challengeToken, pubkey, transaction, issuedAt }
//     — wallet.signTransaction (Ledger). The transaction must contain a
//       single Memo ix whose utf8 data is the reconstructed challenge string,
//       and must be signed by feePayer == pubkey.

interface VerifyRequest {
  kind: "message" | "transaction";
  challengeToken: string;
  pubkey: string;
  issuedAt: string;
  signature?: string; // base64 (kind=message)
  transaction?: string; // base64 (kind=transaction)
  baseMint?: string;
  quoteMint?: string;
}

export async function POST(req: Request) {
  let body: VerifyRequest;
  try {
    body = (await req.json()) as VerifyRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 1) Verify challenge JWT
  let claims;
  try {
    claims = await verifyChallenge(body.challengeToken);
  } catch (e: any) {
    return NextResponse.json(
      { error: `Challenge invalid or expired: ${e.message}` },
      { status: 401 }
    );
  }

  let signerPk: PublicKey;
  try {
    signerPk = new PublicKey(body.pubkey);
  } catch {
    return NextResponse.json({ error: "Invalid pubkey" }, { status: 400 });
  }

  // 2) Reconstruct the expected challenge message
  const expectedMessage = formatChallengeMessage({
    nonce: claims.nonce,
    pool: claims.pool,
    pubkey: body.pubkey,
    issuedAt: body.issuedAt,
  });

  // 3) Verify signature by chosen method
  if (body.kind === "message") {
    if (!body.signature) {
      return NextResponse.json({ error: "Missing signature" }, { status: 400 });
    }
    let sigBytes: Uint8Array;
    try {
      sigBytes = Uint8Array.from(Buffer.from(body.signature, "base64"));
    } catch {
      return NextResponse.json({ error: "Invalid signature encoding" }, { status: 400 });
    }
    if (sigBytes.length !== 64) {
      return NextResponse.json({ error: "Signature must be 64 bytes" }, { status: 400 });
    }
    const messageBytes = new TextEncoder().encode(expectedMessage);
    const ok = nacl.sign.detached.verify(messageBytes, sigBytes, signerPk.toBytes());
    if (!ok) {
      return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
    }
  } else if (body.kind === "transaction") {
    if (!body.transaction) {
      return NextResponse.json({ error: "Missing transaction" }, { status: 400 });
    }
    let tx: Transaction;
    try {
      tx = Transaction.from(Buffer.from(body.transaction, "base64"));
    } catch (e: any) {
      return NextResponse.json(
        { error: `Could not deserialize transaction: ${e.message}` },
        { status: 400 }
      );
    }

    // feePayer must equal claimed pubkey
    if (!tx.feePayer || !tx.feePayer.equals(signerPk)) {
      return NextResponse.json(
        { error: "Transaction feePayer must equal claimed pubkey" },
        { status: 401 }
      );
    }

    // Locate Memo ix and check its data is the challenge string
    const memoIx = tx.instructions.find((ix) => ix.programId.equals(MEMO_PROGRAM_ID));
    if (!memoIx) {
      return NextResponse.json(
        { error: "Transaction missing Memo instruction" },
        { status: 401 }
      );
    }
    const memoText = new TextDecoder("utf-8", { fatal: true }).decode(memoIx.data);
    if (memoText !== expectedMessage) {
      return NextResponse.json(
        { error: "Memo data does not match challenge" },
        { status: 401 }
      );
    }

    // Verify the signature against the message bytes
    if (!tx.verifySignatures(true)) {
      return NextResponse.json(
        { error: "Transaction signature invalid" },
        { status: 401 }
      );
    }
  } else {
    return NextResponse.json({ error: "Unknown kind" }, { status: 400 });
  }

  // 4) Optional admin check
  let poolAddr: PublicKey | undefined;
  if (body.baseMint && body.quoteMint) {
    try {
      const baseMint = new PublicKey(body.baseMint);
      const quoteMint = new PublicKey(body.quoteMint);
      const [addr] = derivePoolState(baseMint, quoteMint, PROGRAM_ID);
      poolAddr = addr;

      const connection = new Connection(RPC_URL, "confirmed");
      const readonlyWallet = {
        publicKey: PublicKey.default,
        signTransaction: async () => {
          throw new Error("read-only");
        },
        signAllTransactions: async () => {
          throw new Error("read-only");
        },
      } as any;
      const provider = new AnchorProvider(connection, readonlyWallet, {
        commitment: "confirmed",
      });
      const program = new Program(IDL as any, provider);
      const pool = await fetchPoolState(program as any, baseMint, quoteMint);
      const adminPk: PublicKey = pool.state.admin;
      if (!adminPk.equals(signerPk)) {
        return NextResponse.json(
          { error: "Signer is not the pool admin" },
          { status: 403 }
        );
      }
    } catch (e: any) {
      return NextResponse.json(
        { error: `Pool admin check failed: ${e.message}` },
        { status: 500 }
      );
    }
  }

  // 5) Issue session JWT and set as httpOnly cookie
  const token = await issueSession(body.pubkey, poolAddr?.toBase58());
  const res = NextResponse.json({
    pubkey: body.pubkey,
    pool: poolAddr?.toBase58(),
  });
  setSessionCookie(res, token);
  return res;
}
