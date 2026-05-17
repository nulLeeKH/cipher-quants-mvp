"use client";

import * as React from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import {
  AnchorProvider,
  PROGRAM_ID,
  Program,
  type Protocol,
  createProgram,
} from "@cipher-quants/sdk";
import { PublicKey } from "@solana/web3.js";

interface ProgramCtx {
  /** Read-only Program (always available; uses connection only). */
  readonlyProgram: Program<Protocol>;
  /** Signing Program (only when wallet connected). */
  signingProgram: Program<Protocol> | null;
  /** Configured program id (env override or SDK default). */
  programId: PublicKey;
}

const Context = React.createContext<ProgramCtx | undefined>(undefined);

const PROGRAM_ID_OVERRIDE = process.env.NEXT_PUBLIC_PROGRAM_ID;

export function ProgramProvider({ children }: { children: React.ReactNode }) {
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();

  const programId = React.useMemo(() => {
    if (PROGRAM_ID_OVERRIDE && PROGRAM_ID_OVERRIDE.length > 0) {
      try {
        return new PublicKey(PROGRAM_ID_OVERRIDE);
      } catch {
        // fall through to SDK default
      }
    }
    return PROGRAM_ID;
  }, []);

  const readonlyProgram = React.useMemo<Program<Protocol>>(() => {
    // Read-only provider: no signer needed. Use an empty wallet stub.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const readonlyWallet: any = {
      publicKey: PublicKey.default,
      signTransaction: async () => {
        throw new Error("read-only");
      },
      signAllTransactions: async () => {
        throw new Error("read-only");
      },
    };
    const provider = new AnchorProvider(connection, readonlyWallet, {
      commitment: "confirmed",
    });
    return new Program(provider, programId);
  }, [connection, programId]);

  const signingProgram = React.useMemo<Program<Protocol> | null>(() => {
    if (!anchorWallet) return null;
    const provider = new AnchorProvider(connection, anchorWallet, {
      commitment: "confirmed",
    });
    return createProgram(provider);
  }, [connection, anchorWallet]);

  const value = React.useMemo<ProgramCtx>(
    () => ({ readonlyProgram, signingProgram, programId }),
    [readonlyProgram, signingProgram, programId]
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useProgram() {
  const ctx = React.useContext(Context);
  if (!ctx) throw new Error("useProgram must be used within ProgramProvider");
  return ctx;
}
