"use client";

import * as React from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { LedgerWalletAdapter } from "@solana/wallet-adapter-ledger";
import {
  SolanaMobileWalletAdapter,
  createDefaultAuthorizationResultCache,
  createDefaultAddressSelector,
  createDefaultWalletNotFoundHandler,
} from "@solana-mobile/wallet-adapter-mobile";
import type { Adapter } from "@solana/wallet-adapter-base";

import "@solana/wallet-adapter-react-ui/styles.css";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
const CLUSTER =
  (process.env.NEXT_PUBLIC_CLUSTER as
    | "mainnet-beta"
    | "devnet"
    | "testnet"
    | "localnet"
    | undefined) ?? "localnet";

// Map our cluster label to the MWA `Chain` value (CAIP-2). Localnet has no
// MWA equivalent, so fall back to devnet semantics — wallets simulate against
// devnet pubkeys, which is fine for local dev. The `Chain` type is local-only
// inside the package, so we type the constant via the constructor signature.
const MWA_CHAIN =
  CLUSTER === "mainnet-beta"
    ? "solana:mainnet"
    : CLUSTER === "testnet"
      ? "solana:testnet"
      : "solana:devnet";

export function WalletContextProvider({ children }: { children: React.ReactNode }) {
  const wallets = React.useMemo<Adapter[]>(() => {
    const list: Adapter[] = [
      // Wallet Standard discovers Phantom / Solflare / Backpack automatically
      // when their extension is installed; explicit adapters serve as a
      // fallback for environments without Wallet Standard injection.
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new LedgerWalletAdapter(),
    ];
    // Solana Mobile Wallet Adapter (Saga / Phantom mobile / Solflare mobile).
    // Browser-only — wrapping in a try/catch prevents SSR from blowing up.
    if (typeof window !== "undefined") {
      try {
        // Cast `chain` to bypass the locally-typed `Chain` (not exported).
        const mwaConfig = {
          chain: MWA_CHAIN as unknown as never,
          appIdentity: {
            name: "Cipher Quants",
            uri: window.location.origin,
            icon: "/favicon.ico",
          },
          authorizationResultCache: createDefaultAuthorizationResultCache(),
          addressSelector: createDefaultAddressSelector(),
          onWalletNotFound: createDefaultWalletNotFoundHandler(),
        };
        list.push(new SolanaMobileWalletAdapter(mwaConfig) as unknown as Adapter);
      } catch {
        // Silently ignore environments where MWA can't initialize (e.g. older
        // Safari / non-mobile contexts without the Wallet Standard backing).
      }
    }
    return list;
  }, []);

  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
