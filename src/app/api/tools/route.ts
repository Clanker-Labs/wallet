import { z } from "zod";
import { enabledTools } from "@/server/agent/tools";

export const dynamic = "force-dynamic";

/** List tools with their JSON Schemas — a plain-HTTP alternative to MCP. */
export function GET() {
  return Response.json(
    enabledTools().map((t) => {
      const { $schema: _s, ...inputSchema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
      return { name: t.name, title: t.title, description: t.description, readOnly: t.readOnly, inputSchema };
    }),
  );
}
