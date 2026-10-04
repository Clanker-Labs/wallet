import { exportAll } from "@/server/services/export";
import { today } from "@/server/services/settings";

export const dynamic = "force-dynamic";

/** GET /api/export → every table (except agent transcripts) as a JSON download. */
export function GET() {
  const body = JSON.stringify(exportAll(), null, 2);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="wallet-export-${today()}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
