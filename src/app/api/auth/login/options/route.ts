import { beginLogin } from "@/server/services/passkeys";
import { authError, rp, setChallengeCookie } from "../../_shared";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  try {
    const { challengeId, options } = await beginLogin(await rp(request), body?.mode === "phone" ? "phone" : "device");
    await setChallengeCookie(challengeId);
    return Response.json(options);
  } catch (e) {
    return authError(e);
  }
}
