import { asc, eq, max } from "drizzle-orm";
import { db } from "@/server/db/client";
import { fxRates } from "@/server/db/schema";
import { normalizeCurrency } from "@/lib/domain";
import { todayISO } from "@/lib/dates";

/**
 * Exchange rates, stored as "units of currency per 1 USD" per day. Fetched
 * daily from free, keyless sources (fawazahmed0 currency-api: 200+ fiat,
 * crypto and metals; Frankfurter/ECB as fallback). Conversions read only the
 * DB, so they stay synchronous and work offline with the last known rates.
 */

type FetchLike = typeof fetch;

export interface RatesPayload {
  date: string;
  /** Units of each currency per 1 USD, keys uppercase. */
  perUsd: Record<string, number>;
}

const SOURCES: { name: string; url: (date: string) => string; parse: (json: unknown) => RatesPayload | null }[] = [
  {
    name: "currency-api (jsdelivr)",
    url: (date) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.min.json`,
    parse: parseCurrencyApi,
  },
  {
    name: "currency-api (pages.dev)",
    url: (date) => `https://${date}.currency-api.pages.dev/v1/currencies/usd.min.json`,
    parse: parseCurrencyApi,
  },
  {
    name: "frankfurter",
    url: (date) => `https://api.frankfurter.dev/v1/${date}?base=USD`,
    parse: (json) => {
      const j = json as { date?: string; rates?: Record<string, number> };
      if (!j?.date || !j.rates) return null;
      return { date: j.date, perUsd: { ...upperKeys(j.rates), USD: 1 } };
    },
  },
];

function upperKeys(obj: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) if (typeof v === "number" && v > 0) out[k.toUpperCase()] = v;
  return out;
}

export function parseCurrencyApi(json: unknown): RatesPayload | null {
  const j = json as { date?: string; usd?: Record<string, number> };
  if (!j?.date || !j.usd) return null;
  return { date: j.date, perUsd: { ...upperKeys(j.usd), USD: 1 } };
}

/** Fetch one day of rates ("latest" or YYYY-MM-DD), trying each source in turn. */
export async function fetchRates(date = "latest", fetchImpl: FetchLike = fetch): Promise<RatesPayload> {
  const errors: string[] = [];
  for (const source of SOURCES) {
    try {
      const res = await fetchImpl(source.url(date), { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = source.parse(await res.json());
      if (!parsed || Object.keys(parsed.perUsd).length < 5) throw new Error("unexpected payload");
      return parsed;
    } catch (e) {
      errors.push(`${source.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`Could not fetch exchange rates (${errors.join("; ")})`);
}

export function storeRates(payload: RatesPayload) {
  const stmt = db().$client.prepare("INSERT OR REPLACE INTO fx_rates (currency, date, per_usd) VALUES (?, ?, ?)");
  db().$client.transaction(() => {
    for (const [currency, perUsd] of Object.entries(payload.perUsd)) stmt.run(currency, payload.date, perUsd);
  })();
}

export function latestFxDate(): string | null {
  return db().select({ d: max(fxRates.date) }).from(fxRates).get()?.d ?? null;
}

let lastAttempt = 0;
let inflight: Promise<void> | null = null;

/**
 * Refresh today's rates if the stored ones are older than a day. Throttled
 * (one attempt per 6 h per process); never throws.
 */
export function ensureFreshRates(opts: { force?: boolean; fetchImpl?: FetchLike } = {}): Promise<void> {
  const latest = latestFxDate();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const stale = !latest || latest < yesterday;
  if (!opts.force && (!stale || Date.now() - lastAttempt < 6 * 3_600_000)) return Promise.resolve();
  if (inflight) return inflight;
  lastAttempt = Date.now();
  inflight = fetchRates("latest", opts.fetchImpl)
    .then(storeRates)
    .catch((e) => console.warn(`[fx] ${e instanceof Error ? e.message : e}`))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Fetch rates for past dates we don't have yet (e.g. month-ends for history). */
export async function backfillRates(dates: string[], fetchImpl: FetchLike = fetch) {
  const have = new Set(
    db().$client.prepare("SELECT DISTINCT date FROM fx_rates").all().map((r) => (r as { date: string }).date),
  );
  let fetched = 0;
  for (const date of [...new Set(dates)].sort()) {
    if (have.has(date) || date > todayISO("UTC")) continue;
    try {
      storeRates(await fetchRates(date, fetchImpl));
      fetched++;
    } catch (e) {
      console.warn(`[fx] ${date}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return fetched;
}

/**
 * Converter bound to the DB's rates. Missing rates are recorded in `missing`
 * (and converted as 0) so callers can warn instead of silently mixing currencies.
 */
export function fxConverter() {
  const stmtOnOrBefore = db().$client.prepare(
    "SELECT per_usd AS r FROM fx_rates WHERE currency = ? AND date <= ? ORDER BY date DESC LIMIT 1",
  );
  const stmtEarliest = db().$client.prepare(
    "SELECT per_usd AS r FROM fx_rates WHERE currency = ? ORDER BY date ASC LIMIT 1",
  );
  const cache = new Map<string, number | null>();
  const missing = new Set<string>();

  function perUsd(currency: string, date: string): number | null {
    if (currency === "USD") return 1;
    const key = `${currency}|${date}`;
    if (!cache.has(key)) {
      const row = (stmtOnOrBefore.get(currency, date) ?? stmtEarliest.get(currency)) as { r: number } | undefined;
      cache.set(key, row?.r ?? null);
    }
    return cache.get(key)!;
  }

  return {
    missing,
    /** Rate to multiply an amount in `from` by to get `to`, or null if unknown. */
    rate(from: string, to: string, date: string): number | null {
      const f = normalizeCurrency(from);
      const t = normalizeCurrency(to);
      if (f === t) return 1;
      const rf = perUsd(f, date);
      const rt = perUsd(t, date);
      if (rf === null) missing.add(f);
      if (rt === null) missing.add(t);
      return rf === null || rt === null ? null : rt / rf;
    },
    convertCents(cents: number, from: string, to: string, date: string): number {
      if (cents === 0) return 0;
      const r = this.rate(from, to, date);
      return r === null ? 0 : Math.round(cents * r);
    },
    convert(amount: number, from: string, to: string, date: string): number {
      const r = this.rate(from, to, date);
      return r === null ? 0 : amount * r;
    },
  };
}
export type FxConverter = ReturnType<typeof fxConverter>;

/** Latest stored rates for a set of currencies against a base, for display. */
export function latestRates(base: string, currencies: string[]) {
  const date = latestFxDate();
  if (!date) return { date: null, rates: {} as Record<string, number | null> };
  const fx = fxConverter();
  return { date, rates: Object.fromEntries(currencies.map((c) => [c, fx.rate(c, base, date)])) };
}

/** Currency codes available on the latest rates date. */
export function knownCurrencies(): string[] {
  const date = latestFxDate();
  if (!date) return ["USD"];
  return db()
    .select({ c: fxRates.currency })
    .from(fxRates)
    .where(eq(fxRates.date, date))
    .orderBy(asc(fxRates.currency))
    .all()
    .map((r) => r.c);
}
