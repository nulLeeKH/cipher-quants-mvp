import { Buffer } from "node:buffer";

import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import { computeFreshness } from "../freshness.ts";
import { assembleSwapTx } from "../swap_tx.ts";
import type { ApiRuntime } from "../runtime.ts";
import type {
  ApiStatus,
  SwapRequest,
  SwapResponse,
} from "../http/contracts.ts";

export type SwapServiceResult = {
  status: ApiStatus;
  body: unknown;
  log?: { quoteId: string };
};

export async function createSwap(
  runtime: ApiRuntime,
  body: SwapRequest,
): Promise<SwapServiceResult> {
  const {
    config,
    connection,
    program,
    quoteSigner,
    quoteStore,
    sdk,
    sdkAccounts,
    sdkInstructions,
    metrics,
  } = runtime;

  const pending = quoteStore.get(body.quoteId);
  if (!pending) {
    metrics.swapClientFail += 1;
    return { status: 404, body: { error: "Unknown or expired quoteId" } };
  }

  // The userPubkey on /swap must match the userPubkey baked into /quote.
  // Without this check a leaked quoteId could be redeemed by anyone.
  try {
    const requester = new PublicKey(body.userPubkey);
    if (!requester.equals(pending.userPk)) {
      metrics.swapClientFail += 1;
      return {
        status: 403,
        body: { error: "userPubkey does not match the quote's bound user" },
      };
    }
  } catch {
    metrics.swapClientFail += 1;
    return { status: 400, body: { error: "Invalid userPubkey" } };
  }

  // Last-look (Maker-side reject gate). The MM's signed ed25519 message is the
  // commitment, so signing is delayed until every check below passes.
  const { state: pool } = await sdkAccounts.fetchPoolState(
    program,
    config.baseMint!,
    config.quoteMint!,
  );

  if (pool.paused) {
    metrics.swapPausedReject += 1;
    return { status: 503, body: { error: "Pool is paused" } };
  }

  const currentSlot = await connection.getSlot();
  if (BigInt(currentSlot) >= pending.expirySlot) {
    metrics.swapExpiredReject += 1;
    return { status: 410, body: { error: "Quote expired" } };
  }

  const freshness = computeFreshness({
    lastOracleUpdateSlot: pool.lastOracleUpdateSlot.toNumber(),
    currentModeTtl: pool.currentModeTtl as number,
    paused: pool.paused,
    currentSlot,
  });
  if (freshness.fresh) {
    metrics.swapCurveFreshReject += 1;
    return {
      status: 409,
      body: {
        error: "Curve became fresh — use direct execute_swap (curve path)",
      },
    };
  }

  // Price drift check. CEIL division avoids under-reporting drift just past the
  // threshold, biasing rejection in the protocol's favour.
  const fairValueNow = BigInt(pool.fairValue.toString());
  const drift = fairValueNow > pending.fairValueAtQuote
    ? fairValueNow - pending.fairValueAtQuote
    : pending.fairValueAtQuote - fairValueNow;
  const driftBps = (drift * 10_000n + pending.fairValueAtQuote - 1n) /
    pending.fairValueAtQuote;
  if (driftBps > BigInt(config.mmMaxDriftBps)) {
    metrics.swapDriftReject += 1;
    return {
      status: 409,
      body: {
        error: "Price drift exceeded last-look threshold",
        driftBps: driftBps.toString(),
        maxBps: config.mmMaxDriftBps,
      },
    };
  }

  // Inventory recheck — vault may have drained between /quote and /swap.
  const balances = await sdkAccounts.fetchVaultBalances(
    program,
    pending.poolAddr,
    config.baseMint!,
    config.quoteMint!,
  );
  const availableOut = pending.direction === "buy"
    ? balances.baseAmount
    : balances.quoteAmount;
  if (availableOut < pending.outAmount) {
    metrics.swapInventoryReject += 1;
    return {
      status: 503,
      body: {
        error: "Inventory underflow at swap time",
        requested: pending.outAmount.toString(),
        available: availableOut.toString(),
        side: pending.direction === "buy" ? "base" : "quote",
      },
    };
  }

  // All last-look checks passed — sign now.
  const built = sdk.buildSignedQuoteWithVerifyIx(quoteSigner, {
    pool: pending.poolAddr,
    user: pending.userPk,
    direction: pending.direction,
    inputAmount: pending.inAmount,
    price: pending.price,
    expirySlot: pending.expirySlot,
    nonce: pending.nonce,
  });

  const baseVault = sdkAccounts.deriveVault(
    pending.poolAddr,
    config.baseMint!,
    program.programId,
  )[0];
  const quoteVault = sdkAccounts.deriveVault(
    pending.poolAddr,
    config.quoteMint!,
    program.programId,
  )[0];
  const userBaseAta = getAssociatedTokenAddressSync(
    config.baseMint!,
    pending.userPk,
  );
  const userQuoteAta = getAssociatedTokenAddressSync(
    config.quoteMint!,
    pending.userPk,
  );

  const swapIx = await sdkInstructions.createExecuteSwapIx(program, {
    user: pending.userPk,
    poolState: pending.poolAddr,
    baseVault,
    quoteVault,
    userBaseAta,
    userQuoteAta,
    inputAmount: new BN(pending.inAmount.toString()),
    direction: pending.direction,
    minOutput: new BN(pending.outAmount.toString()),
    signedQuote: built.signedQuote,
    quoteNonceMarker: pending.marker,
  });

  const { blockhash, lastValidBlockHeight } = await connection
    .getLatestBlockhash(
      "confirmed",
    );

  const assembled = assembleSwapTx({
    userPk: pending.userPk,
    poolAddr: pending.poolAddr,
    baseMint: config.baseMint!,
    quoteMint: config.quoteMint!,
    baseVault,
    quoteVault,
    verifyIx: built.verifyIx,
    swapIx,
    recentBlockhash: blockhash,
  });

  // Successful /swap consumes the quote; a second call must request a fresh
  // quote/nonce.
  quoteStore.delete(pending.quoteId);
  metrics.swapSuccess += 1;

  const response: SwapResponse = {
    quoteId: pending.quoteId,
    tx: assembled.txBase64,
    lastValidBlockHeight,
    components: {
      signedQuote: {
        pool: built.signedQuote.pool.toBase58(),
        user: built.signedQuote.user.toBase58(),
        direction: built.signedQuote.direction,
        inputAmount: built.signedQuote.inputAmount.toString(),
        price: built.signedQuote.price.toString(),
        expirySlot: built.signedQuote.expirySlot.toString(),
        nonce: built.signedQuote.nonce.toString(),
        signature: built.signedQuote.signature,
      },
      verifyIxBase64: Buffer.from(built.verifyIx.data).toString("base64"),
      quoteNonceMarker: pending.marker.toBase58(),
    },
  };

  return { status: 200, body: response, log: { quoteId: pending.quoteId } };
}
