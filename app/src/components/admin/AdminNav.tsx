"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";

import { cn, shortAddr } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAdminSession } from "@/lib/auth/session";

const LINKS = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/actions", label: "Actions" },
  { href: "/admin/inventory", label: "Inventory" },
];

export function AdminNav() {
  const pathname = usePathname();
  const { session, signOut } = useAdminSession();

  return (
    <div className="border-b bg-muted/20">
      <div className="container mx-auto max-w-6xl px-4 py-2 flex items-center gap-4 text-sm">
        <span className="font-medium text-foreground">Admin</span>
        <nav className="flex items-center gap-4">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "transition-colors hover:text-foreground/80",
                pathname === l.href ? "text-foreground" : "text-foreground/60"
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-mono">
            {session ? shortAddr(session.pubkey) : ""}
          </span>
          <Button variant="ghost" size="sm" onClick={signOut} aria-label="Sign out">
            <LogOut className="size-3.5 mr-1.5" />
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
