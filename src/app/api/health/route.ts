import { db } from "@/server/db/client";

export const dynamic = "force-dynamic";

export function GET() {
  db().$client.prepare("SELECT 1").get();
  return Response.json({ ok: true });
}
