"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useAdminSession } from "@/lib/auth/session";
import { Skeleton } from "@/components/ui/skeleton";

export function AdminGuard({ children }: { children: React.ReactNode }) {
  const { session, hydrated } = useAdminSession();
  const router = useRouter();

  React.useEffect(() => {
    if (hydrated && !session) {
      router.replace("/admin/login");
    }
  }, [hydrated, session, router]);

  if (!hydrated) {
    return (
      <div className="container mx-auto max-w-2xl px-4 py-12 space-y-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (!session) return null;
  return <>{children}</>;
}
