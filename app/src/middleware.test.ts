/**
 * @jest-environment node
 */
// Edge middleware unit tests. Stubs out verifySession + NextResponse so we
// can assert routing decisions without touching jose at all.

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";

// Track redirects + next() pass-throughs via simple sentinels.
class RedirectSentinel {
  constructor(public url: URL) {}
}
class NextSentinel {}

jest.mock("next/server", () => ({
  NextResponse: {
    next: () => new NextSentinel(),
    redirect: (url: URL) => new RedirectSentinel(url),
  },
}));

const verifySessionMock = jest.fn();
jest.mock("@/lib/auth/jwt", () => ({
  verifySession: (token: string) => verifySessionMock(token),
}));

// Import AFTER mocks register.
import { middleware } from "./middleware";

type MockReq = {
  nextUrl: URL;
  cookies: { get: (name: string) => { value: string } | undefined };
};

function mkReq(pathname: string, sessionCookie?: string): MockReq {
  const url = new URL(`http://localhost${pathname}`);
  // NextURL exposes a `.clone()` that returns a fresh URL with `.pathname`
  // and `.searchParams` mutable. The whatwg URL constructor copy is enough.
  (url as URL & { clone: () => URL }).clone = () => new URL(url.toString());
  return {
    nextUrl: url,
    cookies: {
      get: (n: string) =>
        n === SESSION_COOKIE_NAME && sessionCookie
          ? { value: sessionCookie }
          : undefined,
    },
  };
}

describe("admin middleware", () => {
  beforeEach(() => {
    verifySessionMock.mockReset();
  });

  it("/admin/login is always reachable (no session required)", async () => {
    const res = await middleware(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mkReq("/admin/login") as any,
    );
    expect(res).toBeInstanceOf(NextSentinel);
    expect(verifySessionMock).not.toHaveBeenCalled();
  });

  it("/admin/login/something also reachable", async () => {
    const res = await middleware(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mkReq("/admin/login/forgot") as any,
    );
    expect(res).toBeInstanceOf(NextSentinel);
  });

  it("missing cookie on protected path → redirect to login", async () => {
    const res = (await middleware(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mkReq("/admin/inventory") as any,
    )) as unknown as RedirectSentinel;
    expect(res).toBeInstanceOf(RedirectSentinel);
    expect(res.url.pathname).toBe("/admin/login");
    expect(res.url.searchParams.get("next")).toBe("/admin/inventory");
  });

  it("valid session passes through", async () => {
    verifySessionMock.mockResolvedValueOnce({ sub: "admin" });
    const res = await middleware(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mkReq("/admin/inventory", "valid.jwt.token") as any,
    );
    expect(res).toBeInstanceOf(NextSentinel);
    expect(verifySessionMock).toHaveBeenCalledWith("valid.jwt.token");
  });

  it("verifySession rejection redirects to login (preserving `next`)", async () => {
    verifySessionMock.mockRejectedValueOnce(new Error("expired"));
    const res = (await middleware(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mkReq("/admin/actions", "expired.jwt") as any,
    )) as unknown as RedirectSentinel;
    expect(res).toBeInstanceOf(RedirectSentinel);
    expect(res.url.pathname).toBe("/admin/login");
    expect(res.url.searchParams.get("next")).toBe("/admin/actions");
  });
});
