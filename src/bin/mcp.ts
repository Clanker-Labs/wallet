/**
 * Wallet MCP server over stdio — plug it into Claude Code, Codex, Claude
 * Desktop or any MCP client:
 *
 *   claude mcp add wallet -- node /path/to/wallet/bin/wallet-mcp.mjs
 *
 * (bin/wallet-mcp.mjs wraps this file so it works from any working directory.)
 * Local, no token: acts as WALLET_USER_ID, or the owner (first account).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWalletMcpServer } from "@/server/agent/mcp";
import { db, dbPath } from "@/server/db/client";
import { defaultUser } from "@/server/services/users";
import { ensureFreshRates } from "@/server/services/fx";

db(); // open + migrate before accepting calls
void ensureFreshRates();
const server = createWalletMcpServer(() => defaultUser().id);
await server.connect(new StdioServerTransport());
// stdout is the protocol channel: log to stderr only.
console.error(`wallet MCP server ready (db: ${dbPath()})`);
