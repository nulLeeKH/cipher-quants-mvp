"use client";

import * as React from "react";

// ============================================================================
// Admin session hook (cookie-based)
// ============================================================================
// The session JWT lives in an httpOnly cookie set by /api/auth/verify.
// Client cannot read it directly — we discover state via /api/auth/me.
// Cookie is auto-sent with same-origin requests by the browser.

export interface AdminSession {
  pubkey: string;
  pool?: string;
  exp?: number;
}

interface SessionState {
  session: AdminSession | null;
  hydrated: boolean;
}

interface UseAdminSession extends SessionState {
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

export function useAdminSession(): UseAdminSession {
  const [state, setState] = React.useState<SessionState>({
    session: null,
    hydrated: false,
  });

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (res.ok) {
        const data = await res.json();
        setState({
          session: { pubkey: data.pubkey, pool: data.pool, exp: data.exp },
          hydrated: true,
        });
      } else {
        setState({ session: null, hydrated: true });
      }
    } catch {
      setState({ session: null, hydrated: true });
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = React.useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      /* best-effort */
    }
    setState({ session: null, hydrated: true });
  }, []);

  return { ...state, refresh, signOut };
}
