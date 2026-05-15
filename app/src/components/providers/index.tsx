"use client";

import * as React from "react";

import { ToastProvider } from "@/components/ui/toast";
import { ThemeProvider } from "./theme";
import { WalletContextProvider } from "./wallet";
import { ProgramProvider } from "./program";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <WalletContextProvider>
          <ProgramProvider>{children}</ProgramProvider>
        </WalletContextProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
