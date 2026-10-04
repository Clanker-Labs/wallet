import { callTool } from "@/server/agent/tools";
import { apiUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/tools/<name> with the tool input as JSON body → tool result JSON. */
export async function POST(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await ctx.params;
  const input = await request.json().catch(() => ({}));
  const res = await callTool({ userId: user.id }, name, input);
  if (!res.ok) return Response.json({ error: res.content }, { status: 400 });
  return new Response(res.content, { headers: { "Content-Type": "application/json" } });
}
