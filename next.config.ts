import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hosted: build a standalone server bundle for Docker.
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  // Bank CSV imports go through a server action.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
};

export default nextConfig;
