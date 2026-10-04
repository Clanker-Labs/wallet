import { finishRegistration } from "@/server/services/passkeys";
import { currentUser, startSession } from "@/server/session";
import { authError, rp, takeChallengeCookie } from "../../_shared";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.response) return authError(new Error("Invalid request"));
  try {
    const signedIn = await currentUser();
    const user = await finishRegistration(await rp(request), await takeChallengeCookie(), body.response, {
      label: typeof body.label === "string" ? body.label : undefined,
      signedInUser: signedIn ?? undefined,
    });
    if (!signedIn) await startSession(user.id);
    return Response.json({ ok: true, user: { id: user.id, name: user.name } });
  } catch (e) {
    return authError(e);
  }
}
