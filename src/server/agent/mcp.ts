import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callTool, enabledTools } from "./tools";
import { systemPrompt } from "./prompt";

/** An MCP server exposing every wallet tool. Transport-agnostic. */
export function createWalletMcpServer(): McpServer {
  const server = new McpServer(
    { name: "wallet", version: "0.1.0" },
    {
      instructions:
        "Tools for the user's self-hosted Wallet app (net worth, budgets, transactions, reminders, simulations). " +
        "Start with get_overview. Amounts in tool results are in the user's currency units.",
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
        const res = await callTool(t.name, args);
        return { content: [{ type: "text" as const, text: res.content }], isError: !res.ok };
      },
    );
  }

  server.registerPrompt(
    "wallet_assistant",
    { title: "Wallet assistant", description: "Persona and house rules for analysing the user's finances" },
    () => ({ messages: [{ role: "user", content: { type: "text", text: systemPrompt("web") } }] }),
  );

  return server;
}
