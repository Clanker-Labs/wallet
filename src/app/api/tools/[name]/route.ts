import { callTool } from "@/server/agent/tools";

export const dynamic = "force-dynamic";

/** POST /api/tools/<name> with the tool input as JSON body → tool result JSON. */
export async function POST(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const input = await request.json().catch(() => ({}));
  const res = await callTool(name, input);
  if (!res.ok) return Response.json({ error: res.content }, { status: 400 });
  return new Response(res.content, { headers: { "Content-Type": "application/json" } });
}
