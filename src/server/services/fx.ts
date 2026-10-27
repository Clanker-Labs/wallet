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

export interface FxRefresh {
  /** updated: fetched now · fresh: stored rates are recent · throttled: tried recently · failed: every source failed */
  status: "updated" | "fresh" | "throttled" | "failed";
  /** Latest stored rates date after the attempt. */
  date: string | null;
  error?: string;
}

let lastAttempt = 0;
let inflight: Promise<FxRefresh> | null = null;

/**
 * Refresh today's rates if the stored ones are older than a day (or always
 * with `force`). Throttled to one attempt per 6 h per process unless forced;
 * never throws: conversions keep using the last stored rates.
 */
export function ensureFreshRates(opts: { force?: boolean; fetchImpl?: FetchLike } = {}): Promise<FxRefresh> {
  const latest = latestFxDate();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const stale = !latest || latest < yesterday;
  if (inflight) return inflight;
  if (!opts.force && !stale) return Promise.resolve({ status: "fresh", date: latest });
  if (!opts.force && Date.now() - lastAttempt < 6 * 3_600_000) return Promise.resolve({ status: "throttled", date: latest });
  lastAttempt = Date.now();
  inflight = fetchRates("latest", opts.fetchImpl)
    .then((payload): FxRefresh => {
      storeRates(payload);
      return { status: "updated", date: latestFxDate() };
    })
    .catch((e): FxRefresh => {
      const error = e instanceof Error ? e.message : String(e);
      console.warn(`[fx] ${error}`);
      return { status: "failed", date: latestFxDate(), error };
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Daily ECB rates for a date range in one call (Frankfurter time series).
 * Only the ~30 currencies the ECB publishes, and only on its working days.
 */
export async function fetchRateSeries(from: string, to: string, fetchImpl: FetchLike = fetch): Promise<RatesPayload[]> {
  const res = await fetchImpl(`https://api.frankfurter.dev/v1/${from}..${to}?base=USD`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`frankfurter series: HTTP ${res.status}`);
  const j = (await res.json()) as { rates?: Record<string, Record<string, number>> };
  if (!j?.rates) throw new Error("frankfurter series: unexpected payload");
  return Object.entries(j.rates).map(([date, r]) => ({ date, perUsd: { ...upperKeys(r), USD: 1 } }));
}

/** The earliest date any user's money needs a rate for (capped at 10 years back). */
function earliestNeededDate(): string | null {
  const row = db()
    .$client.prepare(
      `SELECT min(d) AS d FROM (
         SELECT min(date) AS d FROM transactions
         UNION ALL SELECT min(date) FROM balance_snapshots
         UNION ALL SELECT min(json_extract(loan_params, '$.startDate')) FROM accounts
         UNION ALL SELECT min(json_extract(gratuity_params, '$.startDate')) FROM accounts
       )`,
    )
    .get() as { d: string | null } | undefined;
  if (!row?.d) return null;
  const floor = new Date(Date.now() - 10 * 365 * 86_400_000).toISOString().slice(0, 10);
  return row.d < floor ? floor : row.d;
}

const monthEnds = (from: string, to: string) => {
  const out: string[] = [];
  const d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  for (;;) {
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    if (end >= to) break;
    out.push(end);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
};

/** What Frankfurter (the ECB reference rates) publishes; everything else needs currency-api. */
const ECB_CURRENCIES = new Set(
  "AUD BGN BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR".split(" "),
);

let lastHistoryRun = 0;

/**
 * Make past conversions use past rates. Without this, a 2024 EUR expense or
 * a year-old snapshot of a French flat is converted at the rate of the day
 * wallet was installed, and the chart shows no currency moves at all.
 *
 * Fills, from the earliest date anyone's data needs up to today: every ECB
 * working day (one Frankfurter call per year), plus month-end rates from
 * currency-api for the currencies the ECB lacks (AED, SAR, crypto…) that are
 * in use. Throttled to twice a day per process; never throws.
 */
export async function ensureHistoricalRates(opts: { force?: boolean; fetchImpl?: FetchLike; maxCalls?: number } = {}): Promise<{ days: number; monthEnds: number; error?: string }> {
  if (!opts.force && Date.now() - lastHistoryRun < 12 * 3_600_000) return { days: 0, monthEnds: 0 };
  lastHistoryRun = Date.now();
  const from = earliestNeededDate();
  const today = todayISO("UTC");
  if (!from || from >= today) return { days: 0, monthEnds: 0 };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const have = (currency: string, a: string, b: string) =>
    (db().$client.prepare("SELECT count(*) AS n FROM fx_rates WHERE currency = ? AND date BETWEEN ? AND ?").get(currency, a, b) as { n: number }).n;
  let days = 0;
  let filled = 0;
  const errors: string[] = [];
  // 1. ECB daily, year by year, only where EUR coverage is thin (< ~60% of working days).
  for (let y = Number(from.slice(0, 4)); y <= Number(today.slice(0, 4)); y++) {
    const a = y === Number(from.slice(0, 4)) ? from : `${y}-01-01`;
    const b = y === Number(today.slice(0, 4)) ? today : `${y}-12-31`;
    const workdays = Math.round(((Date.parse(b) - Date.parse(a)) / 86_400_000 + 1) * (5 / 7));
    if (have("EUR", a, b) >= workdays * 0.6) continue;
    try {
      const series = await fetchRateSeries(a, b, fetchImpl);
      // INSERT OR IGNORE: a richer currency-api day already stored keeps its rates.
      const stmt = db().$client.prepare("INSERT OR IGNORE INTO fx_rates (currency, date, per_usd) VALUES (?, ?, ?)");
      db().$client.transaction(() => {
        for (const p of series) for (const [c, r] of Object.entries(p.perUsd)) stmt.run(c, p.date, r);
      })();
      days += series.length;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  // 2. Month-ends for in-use currencies the ECB doesn't publish.
  const ecb = ECB_CURRENCIES;
  const inUse = (
    db()
      .$client.prepare(
        `SELECT DISTINCT upper(currency) AS c FROM accounts UNION SELECT upper(currency) FROM holdings
         UNION SELECT upper(currency) FROM transactions UNION SELECT upper(currency) FROM budgets WHERE currency IS NOT NULL`,
      )
      .all() as { c: string }[]
  ).map((r) => r.c);
  const exotic = inUse.filter((c) => c !== "USD" && !ecb.has(c));
  if (exotic.length) {
    let calls = 0;
    for (const date of monthEnds(from, today)) {
      if (exotic.every((c) => have(c, date, date) > 0)) continue;
      if (calls++ >= (opts.maxCalls ?? 36)) break; // the rest on the next run
      try {
        const p = await fetchRates(date, fetchImpl);
        const stmt = db().$client.prepare("INSERT OR IGNORE INTO fx_rates (currency, date, per_usd) VALUES (?, ?, ?)");
        db().$client.transaction(() => {
          for (const [c, r] of Object.entries(p.perUsd)) stmt.run(c, p.date, r);
        })();
        filled++;
      } catch (e) {
        errors.push(`${date}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (errors.length) console.warn(`[fx] history: ${errors.slice(0, 3).join("; ")}`);
  return { days, monthEnds: filled, ...(errors.length ? { error: errors[0] } : {}) };
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

/** Currencies a user's accounts, holdings and transactions are in, with where each appears. */
export function currenciesInUse(uid: string): { currency: string; usedIn: ("accounts" | "holdings" | "transactions")[] }[] {
  const rows = db()
    .$client.prepare(
      `SELECT upper(currency) AS currency, 'accounts' AS src FROM accounts WHERE user_id = @uid
       UNION SELECT upper(currency), 'holdings' FROM holdings WHERE user_id = @uid
       UNION SELECT upper(currency), 'transactions' FROM transactions WHERE user_id = @uid
       ORDER BY 1, 2`,
    )
    .all({ uid }) as { currency: string; src: "accounts" | "holdings" | "transactions" }[];
  const out = new Map<string, ("accounts" | "holdings" | "transactions")[]>();
  for (const r of rows) out.set(r.currency, [...(out.get(r.currency) ?? []), r.src]);
  return [...out].map(([currency, usedIn]) => ({ currency, usedIn }));
}
