#!/usr/bin/env node
/**
 * Launch the wallet MCP server (stdio) from any working directory — MCP
 * clients like Claude Code and Codex start servers from their own cwd.
 *
 *   claude mcp add wallet -- node /path/to/wallet/bin/wallet-mcp.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

// Same env files as the web app; real environment variables win.
for (const file of [".env.local", ".env"]) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) continue;
  for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(p, "utf8")))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

register({ tsconfig: path.join(root, "tsconfig.json") });
await import(pathToFileURL(path.join(root, "src", "bin", "mcp.ts")).href);
