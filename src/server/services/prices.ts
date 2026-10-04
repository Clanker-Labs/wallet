import { db } from "@/server/db/client";
import { normalizeCurrency, type HoldingType } from "@/lib/domain";

/**
 * Market prices from Yahoo Finance's public chart/search endpoints (no key):
 * stocks, ETFs, funds, indices, crypto (BTC-USD), commodity futures (GC=F),
 * currencies. Stored daily in `prices`; valuations read only the DB.
 */

type FetchLike = typeof fetch;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

export interface PriceSeries {
  symbol: string;
  name: string | null;
  currency: string;
  assetType: HoldingType;
  closes: { date: string; close: number }[];
}

/** Minor-unit quotes (London pence etc.) → major currency and divisor. */
const MINOR_UNITS: Record<string, [string, number]> = { GBp: ["GBP", 100], GBX: ["GBP", 100], ZAc: ["ZAR", 100], ILA: ["ILS", 100] };

export function yahooTypeToHolding(type: string | undefined): HoldingType {
  switch ((type ?? "").toUpperCase()) {
    case "EQUITY":
      return "stock";
    case "ETF":
      return "etf";
    case "MUTUALFUND":
      return "fund";
    case "CRYPTOCURRENCY":
      return "crypto";
    case "FUTURE":
    case "COMMODITY":
      return "commodity";
    case "BOND":
      return "bond";
    default:
      return "other";
  }
}

export function parseYahooChart(json: unknown): PriceSeries | null {
  const result = (json as { chart?: { result?: Record<string, unknown>[] } })?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta as Record<string, unknown>;
  const rawCurrency = String(meta.currency ?? "USD");
  const [currency, divisor] = MINOR_UNITS[rawCurrency] ?? [normalizeCurrency(rawCurrency), 1];
  const offset = Number(meta.gmtoffset ?? 0);
  const timestamps = (result.timestamp as number[] | undefined) ?? [];
  const closes = ((result.indicators as { quote?: { close?: (number | null)[] }[] })?.quote?.[0]?.close ?? []) as (
    | number
    | null
  )[];
  const byDate = new Map<string, number>();
  timestamps.forEach((ts, i) => {
    const c = closes[i];
    if (typeof c === "number" && Number.isFinite(c)) {
      byDate.set(new Date((ts + offset) * 1000).toISOString().slice(0, 10), c / divisor);
    }
  });
  // The live price is more recent than the last daily bar during market hours.
  if (typeof meta.regularMarketPrice === "number" && typeof meta.regularMarketTime === "number") {
    byDate.set(
      new Date((meta.regularMarketTime + offset) * 1000).toISOString().slice(0, 10),
      meta.regularMarketPrice / divisor,
    );
  }
  return {
    symbol: String(meta.symbol ?? ""),
    name: (meta.longName ?? meta.shortName ?? null) as string | null,
    currency,
    assetType: yahooTypeToHolding(meta.instrumentType as string | undefined),
    closes: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close })),
  };
}

export async function fetchPriceSeries(symbol: string, range = "5d", fetchImpl: FetchLike = fetch): Promise<PriceSeries> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const series = parseYahooChart(await res.json());
  if (!series || !series.closes.length) throw new Error(`${symbol}: no price data`);
  return series;
}

export function storePrices(series: PriceSeries, symbol = series.symbol) {
  const stmt = db().$client.prepare(
    "INSERT OR REPLACE INTO prices (symbol, date, close, currency, fetched_at) VALUES (?, ?, ?, ?, ?)",
  );
  const now = Date.now();
  db().$client.transaction(() => {
    for (const p of series.closes) stmt.run(symbol.toUpperCase(), p.date, p.close, series.currency, now);
  })();
}

export interface SymbolMatch {
  symbol: string;
  name: string;
  assetType: HoldingType;
  exchange: string | null;
}

export async function searchSymbols(query: string, fetchImpl: FetchLike = fetch): Promise<SymbolMatch[]> {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`;
  const res = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Symbol search failed: HTTP ${res.status}`);
  const json = (await res.json()) as { quotes?: Record<string, string>[] };
  return (json.quotes ?? [])
    .filter((q) => q.symbol)
    .map((q) => ({
      symbol: q.symbol,
      name: q.longname || q.shortname || q.symbol,
      assetType: yahooTypeToHolding(q.quoteType),
      exchange: q.exchDisp || q.exchange || null,
    }));
}

/** Symbols held by anyone, with the time their last price was fetched. */
function trackedSymbols(): { symbol: string; fetchedAt: number | null }[] {
  return db()
    .$client.prepare(
      `SELECT h.symbol AS symbol, MAX(p.fetched_at) AS fetchedAt
       FROM (SELECT DISTINCT upper(symbol) AS symbol FROM holdings WHERE symbol IS NOT NULL) h
       LEFT JOIN prices p ON p.symbol = h.symbol
       GROUP BY h.symbol`,
    )
    .all() as { symbol: string; fetchedAt: number | null }[];
}

/**
 * Fetch recent prices for held symbols (or the given ones). Skips symbols
 * fetched in the last `maxAgeHours` unless forced. Never throws.
 */
export async function refreshPrices(
  opts: { symbols?: string[]; maxAgeHours?: number; range?: string; fetchImpl?: FetchLike } = {},
): Promise<{ updated: string[]; failed: { symbol: string; error: string }[] }> {
  const maxAge = (opts.maxAgeHours ?? 6) * 3_600_000;
  const targets = opts.symbols
    ? opts.symbols.map((s) => s.toUpperCase())
    : trackedSymbols()
        .filter((t) => !t.fetchedAt || Date.now() - t.fetchedAt > maxAge)
        .map((t) => t.symbol);
  const updated: string[] = [];
  const failed: { symbol: string; error: string }[] = [];
  for (const symbol of targets) {
    try {
      storePrices(await fetchPriceSeries(symbol, opts.range ?? "5d", opts.fetchImpl), symbol);
      updated.push(symbol);
    } catch (e) {
      failed.push({ symbol, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { updated, failed };
}

let lastAttempt = 0;
let inflight: Promise<unknown> | null = null;

/** Background refresh for the web app: at most every 30 minutes per process. */
export function ensureFreshPrices(): Promise<unknown> {
  if (inflight || Date.now() - lastAttempt < 30 * 60_000) return inflight ?? Promise.resolve();
  lastAttempt = Date.now();
  inflight = refreshPrices()
    .then((r) => {
      if (r.failed.length) console.warn(`[prices] ${r.failed.map((f) => f.error).join("; ")}`);
      return r;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Price lookup bound to the DB: latest close on or before a date. */
export function priceReader() {
  const stmt = db().$client.prepare(
    "SELECT close, currency, date FROM prices WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1",
  );
  const cache = new Map<string, { close: number; currency: string; date: string } | null>();
  return (symbol: string, date: string) => {
    const key = `${symbol.toUpperCase()}|${date}`;
    if (!cache.has(key)) cache.set(key, (stmt.get(symbol.toUpperCase(), date) as never) ?? null);
    return cache.get(key)!;
  };
}
export type PriceReader = ReturnType<typeof priceReader>;
