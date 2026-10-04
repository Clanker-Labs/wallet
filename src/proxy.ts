import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, apiTokenEnabled, validBearer, validSession } from "@/server/auth";

/**
 * Gatekeeper (runs on the Node.js runtime):
 * - /api/mcp and /api/tools always require the API token (they expose write tools).
 * - Other /api routes accept the API token or a UI session.
 * - Pages require a UI session when WALLET_PASSWORD is set.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  const bearer = request.headers.get("authorization");

  if (pathname === "/api/health") return NextResponse.next();

  if (pathname.startsWith("/api/mcp") || pathname.startsWith("/api/tools")) {
    if (!apiTokenEnabled()) {
      return NextResponse.json(
        { error: "Set WALLET_API_TOKEN to enable this endpoint, then send it as a Bearer token." },
        { status: 503 },
      );
    }
    if (!validBearer(bearer)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    if (validBearer(bearer) || validSession(session)) return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (pathname === "/login" || validSession(session)) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
