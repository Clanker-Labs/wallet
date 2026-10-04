"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, checkPassword, passwordEnabled, sessionValue } from "@/server/auth";

const NINETY_DAYS = 60 * 60 * 24 * 90;

/** Only same-site relative paths ("/budgets?month=…"); anything else goes home. */
function safeNext(raw: FormDataEntryValue | null): string {
  const s = typeof raw === "string" ? raw : "";
  if (!s.startsWith("/") || s.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(s)) return "/";
  try {
    const u = new URL(s, "http://wallet.invalid");
    if (u.origin !== "http://wallet.invalid" || u.pathname === "/login") return "/";
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return "/";
  }
}

export async function login(formData: FormData) {
  const next = safeNext(formData.get("next"));
  if (!passwordEnabled()) redirect(next);

  if (!checkPassword(String(formData.get("password") ?? ""))) {
    // A small delay makes online guessing slower.
    await new Promise((r) => setTimeout(r, 500));
    redirect(`/login?error=1${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`);
  }

  const h = await headers();
  const proto = (h.get("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  const secure = proto === "https" || (h.get("origin") ?? "").startsWith("https://");
  (await cookies()).set(SESSION_COOKIE, sessionValue(), {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: NINETY_DAYS,
  });
  redirect(next);
}
