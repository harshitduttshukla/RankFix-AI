import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // AI drafting runs synchronously and can take up to AI_TIMEOUT_MS (180s); the
  // rewrite proxy defaults to 30s and would return a 500 before the API answers.
  experimental: { proxyTimeout: 200_000 },
  // Proxy API calls so auth cookies are first-party (same origin as the app).
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
