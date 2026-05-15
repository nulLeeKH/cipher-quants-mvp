/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
