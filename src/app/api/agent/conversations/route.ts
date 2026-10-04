import { listConversations } from "@/server/agent/conversations";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(listConversations(50));
}
