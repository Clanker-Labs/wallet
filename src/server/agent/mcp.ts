import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callTool, enabledTools } from "./tools";
import { systemPrompt } from "./prompt";

/**
 * An MCP server exposing every wallet tool, acting for one user (resolved
 * per call, so a server started before the first sign-up still works).
 */
export function createWalletMcpServer(resolveUserId: () => string): McpServer {
  const server = new McpServer(
    { name: "wallet", version: "0.2.0" },
    {
      instructions:
        "Tools for the user's self-hosted Wallet app (net worth, investments, budgets, transactions, reminders, simulations). " +
        "Start with get_overview. Amounts in tool results are in currency units; totals are in the user's base currency.",
    },
  );

  for (const t of enabledTools()) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
      },
      async (args: unknown) => {
        let userId: string;
        try {
          userId = resolveUserId();
        } catch (e) {
          return { content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
        }
        const res = await callTool({ userId }, t.name, args);
        return { content: [{ type: "text" as const, text: res.content }], isError: !res.ok };
      },
    );
  }

  server.registerPrompt(
    "wallet_assistant",
    { title: "Wallet assistant", description: "Persona and house rules for analysing the user's finances" },
    () => ({ messages: [{ role: "user", content: { type: "text", text: systemPrompt(resolveUserId(), "web") } }] }),
  );

  return server;
}
