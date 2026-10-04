import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, apiTokenEnabled, tokenlessAccess, validBearer } from "@/server/auth";

const PUBLIC_PAGES = ["/login", "/signup"];

/**
 * Optimistic gate (runs on the Node.js runtime): pages need a session cookie,
 * programmatic API calls need the bearer token when WALLET_API_TOKEN is set,
 * or else must come from this machine (see tokenlessAccess). Pages and route
 * handlers re-check the session against the database.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (pathname.startsWith("/api/")) {
    if (pathname.startsWith("/api/auth/") || pathname === "/api/health") return NextResponse.next();
    if (hasSession) return NextResponse.next(); // verified against the DB by the route
    if (apiTokenEnabled()) {
      if (validBearer(request.headers.get("authorization"))) return NextResponse.next();
      return NextResponse.json({ error: "Unauthorized: send Authorization: Bearer $WALLET_API_TOKEN" }, { status: 401 });
    }
    const local = tokenlessAccess(request.headers);
    if (local.ok) return NextResponse.next();
    return NextResponse.json({ error: local.reason }, { status: 403 });
  }

  if (hasSession || PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|icon-192.png|icon-512.png|apple-touch-icon.png|manifest.webmanifest).*)"],
};
