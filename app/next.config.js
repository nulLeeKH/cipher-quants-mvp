/** @type {import('next').NextConfig} */

// ============================================================================
// Security headers (applied to every response by Next.js)
// ============================================================================
// CSP is intentionally restrictive but pragmatic:
//   - script-src self + 'unsafe-inline' for Next.js inline hydration scripts.
//     (Next is moving toward nonce-based; reconsider once that ships.)
//   - connect-src must include the RPC + API endpoints the app talks to.
//     Wildcards keep dev/prod flexibility; tighten via env var for prod.
//   - img-src and font-src: data:/blob: so wallet adapter logos render.
//   - frame-ancestors: none → click-jacking guard.
const RPC_HOST = process.env.NEXT_PUBLIC_RPC_URL ?? "";
const API_HOST = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
const WS_HOST = process.env.NEXT_PUBLIC_RPC_WS_URL ?? "";

function originOf(u) {
  if (!u) return "";
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}
const CONNECT_HOSTS = [originOf(RPC_HOST), originOf(API_HOST), originOf(WS_HOST)]
  .filter(Boolean)
  .join(" ");

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${CONNECT_HOSTS} wss: https:`.trim(),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  webpack: (config) => {
    // bigint+wallet adapter shims for browser
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    // pnpm workspaces: keep the SDK symlink path "in node_modules" so webpack
    // doesn't try to inject HMR runtime (`import.meta.webpackHot.accept()`)
    // into the pre-built CJS bundle.
    config.resolve.symlinks = false;
    return config;
  },
};

module.exports = nextConfig;
