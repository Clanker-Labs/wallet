import fs from "node:fs";
import { backupPath } from "@/server/services/backup";
import { apiUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/backups/<name> → download one backup (the owner only: it holds every user's data). */
export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const user = await apiUser(request);
  if (!user || user.role !== "owner") return Response.json({ error: "Only the owner can download backups" }, { status: 403 });
  let file: string;
  try {
    file = backupPath((await params).name);
  } catch {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (!fs.existsSync(file)) return Response.json({ error: "Not found" }, { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Disposition": `attachment; filename="${(await params).name}"`,
      "Cache-Control": "no-store",
    },
  });
}
