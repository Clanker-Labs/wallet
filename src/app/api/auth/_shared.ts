import { cookies, headers } from "next/headers";
import { CHALLENGE_COOKIE } from "@/server/auth";
import { relyingParty } from "@/server/services/passkeys";
import { isSecureRequest } from "@/server/session";

export async function rp(request: Request) {
  return relyingParty(request.url, await headers());
}

export async function setChallengeCookie(id: string) {
  (await cookies()).set(CHALLENGE_COOKIE, id, {
    httpOnly: true,
    sameSite: "strict",
    secure: await isSecureRequest(),
    path: "/api/auth",
    maxAge: 300,
  });
}

export async function takeChallengeCookie(): Promise<string | undefined> {
  const jar = await cookies();
  const id = jar.get(CHALLENGE_COOKIE)?.value;
  jar.delete({ name: CHALLENGE_COOKIE, path: "/api/auth" });
  return id;
}

export function authError(e: unknown, status = 400) {
  const message = e instanceof Error ? e.message : String(e);
  return Response.json({ error: message }, { status });
}
