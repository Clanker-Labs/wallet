import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { settings } from "@/server/db/schema";
import { defaultZone, todayISO } from "@/lib/dates";

export interface AppSettings {
  currency: string;
  locale: string;
  timezone: string;
}

const DEFAULTS = (): AppSettings => ({
  currency: process.env.WALLET_CURRENCY || "EUR",
  locale: process.env.WALLET_LOCALE || "en-IE",
  timezone: defaultZone(),
});

export function getSettings(): AppSettings {
  const rows = db().select().from(settings).all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const d = DEFAULTS();
  return {
    currency: map.currency || d.currency,
    locale: map.locale || d.locale,
    timezone: map.timezone || d.timezone,
  };
}

export function setSetting(key: keyof AppSettings, value: string) {
  if (key === "currency" && !/^[A-Z]{3}$/.test(value)) throw new Error("Currency must be an ISO code like EUR");
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
  const existing = db().select().from(settings).where(eq(settings.key, key)).get();
  if (existing) db().update(settings).set({ value }).where(eq(settings.key, key)).run();
  else db().insert(settings).values({ key, value }).run();
}

/** Today's date (YYYY-MM-DD) in the configured time zone. */
export function today(): string {
  return todayISO(getSettings().timezone);
}
