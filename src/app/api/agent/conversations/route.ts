import { listConversations } from "@/server/agent/conversations";
import { apiUser } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(listConversations(user.id, 50));
}
