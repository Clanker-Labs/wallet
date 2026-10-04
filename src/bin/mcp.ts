/**
 * Wallet MCP server over stdio — plug it into Claude Code, Codex, Claude
 * Desktop or any MCP client:
 *
 *   claude mcp add wallet -- npx tsx /path/to/wallet/src/bin/mcp.ts
 *
 * Reads/writes the same SQLite file as the web app (WALLET_DB_PATH).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWalletMcpServer } from "@/server/agent/mcp";
import { db, dbPath } from "@/server/db/client";

db(); // open + migrate before accepting calls
const server = createWalletMcpServer();
await server.connect(new StdioServerTransport());
// stdout is the protocol channel: log to stderr only.
console.error(`wallet MCP server ready (db: ${dbPath()})`);
