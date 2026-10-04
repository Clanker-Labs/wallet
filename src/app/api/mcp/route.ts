import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createWalletMcpServer } from "@/server/agent/mcp";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Remote MCP endpoint (Streamable HTTP, stateless). Requires
 * `Authorization: Bearer $WALLET_API_TOKEN` (enforced in proxy.ts).
 *
 *   claude mcp add --transport http wallet https://wallet.example.com/api/mcp \
 *     --header "Authorization: Bearer $WALLET_API_TOKEN"
 */
async function handle(request: Request) {
  const server = createWalletMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Stateless: one server per request.
    void transport.close();
    void server.close();
  }
}

export { handle as GET, handle as POST, handle as DELETE };
