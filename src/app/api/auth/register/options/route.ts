import { z } from "zod";
import { signupAllowed } from "@/server/auth";
import { beginRegistration } from "@/server/services/passkeys";
import { countUsers } from "@/server/services/users";
import { currentUser } from "@/server/session";
import { authError, rp, setChallengeCookie } from "../../_shared";

const body = z.object({ name: z.string().trim().max(60).optional(), mode: z.enum(["device", "phone"]).default("device") });

/** Start creating a passkey: a new account, or an extra passkey for the signed-in user. */
export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return authError(new Error("Invalid request"));
  const user = await currentUser();
  if (!user) {
    if (!signupAllowed(countUsers())) return authError(new Error("Sign-ups are closed on this wallet."), 403);
    if (!parsed.data.name) return authError(new Error("Tell us your name first."));
  }
  try {
    const { challengeId, options } = await beginRegistration(await rp(request), {
      mode: parsed.data.mode,
      name: parsed.data.name,
      user: user ?? undefined,
    });
    await setChallengeCookie(challengeId);
    return Response.json(options);
  } catch (e) {
    return authError(e);
  }
}
