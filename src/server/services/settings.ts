import { and, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { settings } from "@/server/db/schema";
import { defaultZone, todayISO } from "@/lib/dates";
import { isCurrencyCode, normalizeCurrency } from "@/lib/domain";

export interface AppSettings {
  /** Base currency everything is converted to. */
  currency: string;
  locale: string;
  timezone: string;
}

export const DEFAULT_SETTINGS = (): AppSettings => ({
  currency: process.env.WALLET_CURRENCY || "USD",
  locale: process.env.WALLET_LOCALE || "en-US",
  timezone: defaultZone(),
});

export function getSettings(uid: string): AppSettings {
  const rows = db().select().from(settings).where(eq(settings.userId, uid)).all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const d = DEFAULT_SETTINGS();
  return {
    currency: map.currency || d.currency,
    locale: map.locale || d.locale,
    timezone: map.timezone || d.timezone,
  };
}

export function setSetting(uid: string, key: keyof AppSettings, raw: string) {
  let value = raw.trim();
  if (key === "currency") {
    value = normalizeCurrency(value);
    if (!isCurrencyCode(value)) throw new Error("Currency must be a code like USD or EUR");
  }
  if (key === "timezone") {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
    } catch {
      throw new Error(`Unknown time zone: ${value}`);
    }
  }
  if (key === "locale") {
    try {
      new Intl.NumberFormat(value);
    } catch {
      throw new Error(`Unknown locale: ${value}`);
    }
  }
  db()
    .insert(settings)
    .values({ userId: uid, key, value })
    .onConflictDoUpdate({ target: [settings.userId, settings.key], set: { value } })
    .run();
}

export function clearSetting(uid: string, key: keyof AppSettings) {
  db().delete(settings).where(and(eq(settings.userId, uid), eq(settings.key, key))).run();
}

/** Today's date (YYYY-MM-DD) in the user's time zone. */
export function today(uid?: string): string {
  return todayISO(uid ? getSettings(uid).timezone : defaultZone());
}
