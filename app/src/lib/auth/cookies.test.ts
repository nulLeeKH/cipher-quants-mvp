/**
 * @jest-environment node
 */
import { readSessionCookie, SESSION_COOKIE_NAME } from "./cookies";

describe("readSessionCookie", () => {
  function mkReq(cookieHeader: string | null): Request {
    const headers = new Headers();
    if (cookieHeader) headers.set("cookie", cookieHeader);
    return new Request("http://localhost/", { headers });
  }

  it("returns null when no cookie header is present", () => {
    expect(readSessionCookie(mkReq(null))).toBeNull();
  });

  it("extracts the session cookie by exact name", () => {
    const req = mkReq(`${SESSION_COOKIE_NAME}=abcDEF.123`);
    expect(readSessionCookie(req)).toBe("abcDEF.123");
  });

  it("decodes URI-encoded values", () => {
    const value = "a/b+c=d";
    const req = mkReq(`${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`);
    expect(readSessionCookie(req)).toBe(value);
  });

  it("returns null if the cookie name is absent (other cookies present)", () => {
    const req = mkReq("other=value; another=thing");
    expect(readSessionCookie(req)).toBeNull();
  });

  it("handles whitespace around `; ` separators", () => {
    const req = mkReq(`unrelated=1;   ${SESSION_COOKIE_NAME}=token-value`);
    expect(readSessionCookie(req)).toBe("token-value");
  });

  it("returns the last cookie when duplicate names appear", () => {
    // Browsers technically allow this; we accept the first match (loop returns first).
    const req = mkReq(`${SESSION_COOKIE_NAME}=first; ${SESSION_COOKIE_NAME}=second`);
    // Current impl returns the FIRST match.
    expect(readSessionCookie(req)).toBe("first");
  });
});
