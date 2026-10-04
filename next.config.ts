import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hosted: build a standalone server bundle for Docker.
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    // Bank CSV imports go through a server action.
    serverActions: { bodySizeLimit: "6mb" },
    // src/proxy.ts buffers request bodies; statements dropped on the assistant are up to 15 MB each.
    proxyClientMaxBodySize: "16mb",
  },
};

export default nextConfig;
