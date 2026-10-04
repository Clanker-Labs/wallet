import { deleteConversation, getConversation, transcript } from "@/server/agent/conversations";
import { apiUser } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const conversation = getConversation(user.id, id);
  if (!conversation) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ conversation, messages: transcript(id) });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  deleteConversation(user.id, id);
  return new Response(null, { status: 204 });
}
