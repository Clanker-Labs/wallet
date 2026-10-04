import { redirect } from "next/navigation";
import { redeemMagicLink } from "@/server/services/magic-link";
import { startSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/auth/magic?code=… — one-time link from `npm run auth:link`. */
export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code") ?? "";
  const user = code ? redeemMagicLink(code) : null;
  if (!user) return new Response("This sign-in link is invalid or expired. Run `npm run auth:link` again.", { status: 401 });
  await startSession(user.id);
  redirect("/settings#security");
}
