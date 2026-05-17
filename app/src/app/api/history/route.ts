import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";

import { parseEventsFromLogs, PROGRAM_ID } from "@cipher-quants/sdk";
import { verifySession } from "@/lib/auth/jwt";
import { readSessionCookie } from "@/lib/auth/cookies";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";

export async function GET(req: Request) {
  const token = readSessionCookie(req);
  if (!token) {
    return NextResponse.json({ error: "No session" }, { status: 401 });
  }
  try {
    await verifySession(token);
  } catch (e: any) {
    return NextResponse.json({ error: `Session invalid: ${e.message}` }, { status: 401 });
  }

  const url = new URL(req.url);
  const poolParam = url.searchParams.get("pool");
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10), 1), 50);
  if (!poolParam) {
    return NextResponse.json({ error: "pool query param required" }, { status: 400 });
  }
  let poolPk: PublicKey;
  try {
    poolPk = new PublicKey(poolParam);
  } catch {
    return NextResponse.json({ error: "invalid pool address" }, { status: 400 });
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const sigs = await connection.getSignaturesForAddress(poolPk, { limit });

  const items: any[] = [];
  for (const s of sigs) {
    const tx = await connection.getTransaction(s.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta?.logMessages) continue;
    const events = parseEventsFromLogs(tx.meta.logMessages);
    for (const ev of events) {
      items.push({
        signature: s.signature,
        slot: s.slot,
        blockTime: s.blockTime,
        name: ev.name,
        data: serializeEvent(ev.data),
      });
    }
  }
  return NextResponse.json({ programId: PROGRAM_ID.toBase58(), items });
}

function serializeEvent(d: any): any {
  if (d == null) return d;
  if (typeof d === "bigint") return d.toString();
  if (typeof d === "object") {
    if (typeof d.toBase58 === "function") return d.toBase58();
    if (typeof d.toString === "function" && d.constructor?.name === "BN") return d.toString();
    if (Array.isArray(d)) return d.map(serializeEvent);
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(d)) out[k] = serializeEvent(v);
    return out;
  }
  return d;
}
