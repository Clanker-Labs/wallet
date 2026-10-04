import { finishLogin } from "@/server/services/passkeys";
import { startSession } from "@/server/session";
import { authError, rp, takeChallengeCookie } from "../../_shared";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.response) return authError(new Error("Invalid request"));
  try {
    const user = await finishLogin(await rp(request), await takeChallengeCookie(), body.response);
    await startSession(user.id);
    return Response.json({ ok: true, user: { id: user.id, name: user.name } });
  } catch (e) {
    return authError(e, 401);
  }
}
