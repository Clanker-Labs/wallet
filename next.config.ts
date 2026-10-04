import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hosted: build a standalone server bundle for Docker.
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
