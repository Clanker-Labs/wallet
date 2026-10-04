import { exportAll } from "@/server/services/export";
import { today } from "@/server/services/settings";
import { apiUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/export → the signed-in user's data as a JSON download. */
export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = JSON.stringify(exportAll(user.id), null, 2);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="wallet-export-${today(user.id)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
