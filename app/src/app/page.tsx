import Link from "next/link";

import { Nav } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";

export default function Home() {
  return (
    <>
      <Nav />
      <main className="container mx-auto max-w-6xl px-4 py-12 md:py-20">
        <section className="text-center max-w-3xl mx-auto">
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight">
            Hybrid <span className="text-muted-foreground">PropAMM-RFQ</span> venue
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Switching settlement between an MM-controlled on-chain curve and signed RFQ
            quotes based on quote freshness. Built for tokenized RWAs and long-tail assets.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link href="/swap">
              <Button size="lg">Open Swap</Button>
            </Link>
            <a
              href="https://github.com/blir/cipher-quants-program"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="lg" variant="outline">
                Docs
              </Button>
            </a>
          </div>
        </section>

        <section className="mt-20 grid gap-6 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Mode A — calm</CardTitle>
              <CardDescription>TTL=1 slot. MM curve fresh, lowest slippage.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Frequent oracle pushes keep the curve essentially live; minimal RFQ fallback
              traffic.
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Mode B — volatile</CardTitle>
              <CardDescription>TTL=3 slots. Wider spread, adaptive ramp.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Oracle pacing relaxes; RFQ webhook fills gaps as the curve goes stale.
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Mode C — closed</CardTitle>
              <CardDescription>TTL=0 (curve disabled). RFQ-only.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Market session closed for RWAs. All settlement runs via signed quotes.
            </CardContent>
          </Card>
        </section>
      </main>
    </>
  );
}
