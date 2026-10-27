import crypto from "node:crypto";
import type { HoldingType } from "@/lib/domain";
import {
  ConnectorError,
  type BrokerActivity,
  type BrokerActivityKind,
  type BrokerConnector,
  type BrokerPosition,
  type FetchHistoryInput,
  type FetchLike,
} from "./types";

/**
 * Trading 212 public API (v0), read endpoints only:
 *   /equity/account/info, /equity/account/cash, /equity/portfolio,
 *   /equity/metadata/instruments, and for history /equity/history/orders,
 *   /equity/history/dividends and /history/transactions.
 * Docs: https://docs.trading212.com/api
 *
 * Auth is HTTP Basic with the API key as username and the API secret as
 * password; a bare key in the Authorization header answers 401.
 *
 * Every endpoint has its own, tight rate limit (account info 1/30 s,
 * instruments 1/50 s…) and answers 429 the moment one is crossed, so the two
 * slow-moving answers are cached: account info per key for the life of the
 * process, the instrument list per environment for 12 hours.
 */

const UA = "wallet (self-hosted; +https://github.com/Clanker-Labs/wallet)";
const INSTRUMENTS_TTL_MS = 12 * 3_600_000;

interface Instrument {
  ticker: string;
  name: string;
  currency: string;
  type: string;
}

const instrumentCache = new Map<string, { at: number; byTicker: Map<string, Instrument> }>();
const accountInfoCache = new Map<string, { id: string | null; currency: string }>();

/** Test hook. */
export function resetTrading212CachesForTests() {
  instrumentCache.clear();
  accountInfoCache.clear();
}

export function baseUrl(environment: string): string {
  return `https://${environment === "demo" ? "demo" : "live"}.trading212.com/api/v0`;
}

// ── Ticker → Yahoo Finance symbol ─────────────────────────────────────────
// Trading 212 encodes the venue in the ticker: AAPL_US_EQ (US), VUSAl_EQ
// (London), SAPd_EQ (Xetra). The trailing lowercase letter is the venue.

const VENUE_SUFFIXES: Record<string, string> = {
  l: ".L",
  d: ".DE",
  e: ".DE",
  a: ".AS",
  p: ".PA",
  b: ".BR",
  q: ".LS",
  m: ".MC",
  i: ".MI",
  s: ".SW",
  v: ".VI",
  h: ".HE",
  c: ".CO",
  o: ".OL",
  t: ".ST",
  w: ".WA",
};

const CURRENCY_SUFFIXES: Record<string, string> = {
  GBP: ".L",
  GBX: ".L",
  EUR: ".DE",
  CHF: ".SW",
  SEK: ".ST",
  NOK: ".OL",
  DKK: ".CO",
  PLN: ".WA",
};

const TICKER_RE = /^([A-Za-z0-9._-]+?)(?:_([A-Z]{2}))?_([A-Z]+)$/;

/** Best-effort Trading 212 ticker → Yahoo Finance symbol (null when it isn't an equity-like ticker). */
export function toYahooSymbol(ticker: string, currency = ""): string | null {
  const m = TICKER_RE.exec(ticker);
  if (!m) return null;
  const [, symbol, country] = m;
  // Yahoo writes share classes with a dash, Trading 212 with a dot (BRK.B → BRK-B).
  if (country === "US") return symbol.toUpperCase().replace(/[._]/g, "-");
  const last = symbol.at(-1)!;
  if (symbol.length > 1 && last !== last.toUpperCase() && VENUE_SUFFIXES[last]) {
    return `${symbol.slice(0, -1).toUpperCase()}${VENUE_SUFFIXES[last]}`;
  }
  return `${symbol.toUpperCase()}${CURRENCY_SUFFIXES[currency.toUpperCase()] ?? ""}`;
}

/** Pence (and other minor-unit quotes) → major currency and divisor. */
export function majorUnit(currency: string): [string, number] {
  switch (currency) {
    case "GBX":
    case "GBp":
      return ["GBP", 100];
    case "ZAc":
      return ["ZAR", 100];
    case "ILA":
      return ["ILS", 100];
    default:
      return [currency.toUpperCase(), 1];
  }
}

function holdingType(t212Type: string): HoldingType {
  switch (t212Type.toUpperCase()) {
    case "STOCK":
      return "stock";
    case "ETF":
      return "etf";
    case "FUND":
      return "fund";
    case "BOND":
      return "bond";
    case "CRYPTO":
    case "CRYPTOCURRENCY":
      return "crypto";
    default:
      return "other";
  }
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

// ── HTTP ──────────────────────────────────────────────────────────────────

function authHeader(credentials: Record<string, string>): string {
  const key = credentials.apiKey?.trim();
  const secret = credentials.apiSecret?.trim();
  if (!key || !secret) throw new ConnectorError("Trading 212 needs both the API key and the API secret");
  return "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
}

async function get(path: string, auth: string, environment: string, fetchImpl: FetchLike): Promise<unknown> {
  return request(`${baseUrl(environment)}${path}`, path, auth, fetchImpl);
}

async function request(url: string, path: string, auth: string, fetchImpl: FetchLike, forbidden?: string): Promise<unknown> {
  let res: Response | null = null;
  let lastError: unknown = null;
  // One retry for network errors and 5xx; a 429 is reported, not waited out.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      res = await fetchImpl(url, {
        headers: { Authorization: auth, Accept: "application/json", "User-Agent": UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status < 500) break;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
      res = null;
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1_000));
  }
  if (!res) throw new ConnectorError(`Trading 212 unreachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  if (res.status === 401) throw new ConnectorError("Trading 212 rejected the API key and secret (401)", 401);
  if (res.status === 403) {
    throw new ConnectorError(
      forbidden ??
      `This API key lacks a permission wallet needs for ${path} (403). Enable Account data, Portfolio and Metadata on the key.`,
      403,
    );
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after")) || Number(res.headers.get("x-ratelimit-reset")) || 0;
    throw new ConnectorError(`Trading 212 rate limit on ${path}${wait > 0 && wait < 3600 ? ` — try again in ${Math.ceil(wait)} s` : " — try again in a minute"}`, 429);
  }
  if (!res.ok) throw new ConnectorError(`Trading 212 error ${res.status} on ${path}`, res.status);
  return res.json();
}

async function accountInfo(auth: string, environment: string, fetchImpl: FetchLike) {
  const cacheKey = crypto.createHash("sha256").update(`${environment}|${auth}`).digest("hex");
  const hit = accountInfoCache.get(cacheKey);
  if (hit) return hit;
  const data = ((await get("/equity/account/info", auth, environment, fetchImpl)) ?? {}) as Record<string, unknown>;
  const currency = String(data.currencyCode ?? "").toUpperCase();
  if (!currency) throw new ConnectorError("Trading 212 did not report the account currency");
  const info = { id: data.id !== undefined && data.id !== null ? String(data.id) : null, currency };
  accountInfoCache.set(cacheKey, info);
  return info;
}

async function instruments(auth: string, environment: string, fetchImpl: FetchLike): Promise<Map<string, Instrument>> {
  const hit = instrumentCache.get(environment);
  if (hit && Date.now() - hit.at < INSTRUMENTS_TTL_MS) return hit.byTicker;
  const rows = await get("/equity/metadata/instruments", auth, environment, fetchImpl);
  const byTicker = new Map<string, Instrument>();
  for (const r of Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []) {
    const ticker = String(r.ticker ?? "");
    if (!ticker) continue;
    byTicker.set(ticker, {
      ticker,
      name: String(r.name || r.shortName || ticker),
      currency: String(r.currencyCode ?? ""),
      type: String(r.type ?? ""),
    });
  }
  instrumentCache.set(environment, { at: Date.now(), byTicker });
  return byTicker;
}

// ── History ───────────────────────────────────────────────────────────────
// Three paginated endpoints, newest first, `limit` ≤ 50, each with its own
// limit of 20 requests a minute: they are paged side by side, each one paced.

/** Pause between two pages of the same endpoint (20 a minute, with room to spare). */
export const HISTORY_PAGE_PAUSE_MS = 3_200;
/** Safety stop: 400 pages × 50 is 20,000 events per endpoint and run. */
const HISTORY_MAX_PAGES = 400;
const HISTORY_FORBIDDEN =
  "This API key can't read history (403). Enable the History permissions on the key — Orders history, Dividends and Transactions — to import past trades.";

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));

/** One /equity/history/orders item → a trade, or null (not filled, no fill). Reads the current and the older flat shape. */
export function parseOrder(item: unknown): BrokerActivity | null {
  const it = obj(item);
  if (it.order !== undefined || it.fill !== undefined) {
    const order = obj(it.order);
    const fill = it.fill ? obj(it.fill) : null;
    if (!fill || String(order.status ?? "FILLED").toUpperCase() !== "FILLED") return null;
    const id = str(fill.id) ?? str(order.id);
    const at = str(fill.filledAt) ?? str(order.createdAt);
    let quantity = num(fill.quantity);
    if (!id || !at || quantity === null || quantity === 0) return null;
    const side = String(order.side ?? "").toUpperCase();
    if (side === "SELL" && quantity > 0) quantity = -quantity;
    if (side === "BUY" && quantity < 0) quantity = -quantity;
    const inst = obj(order.instrument);
    const ticker = str(order.ticker) ?? str(inst.ticker);
    const rawCurrency = str(inst.currency) ?? str(order.currency) ?? "";
    const [priceCurrency, divisor] = majorUnit(rawCurrency);
    const rawPrice = num(fill.price);
    const wallet = obj(fill.walletImpact);
    const net = num(wallet.netValue);
    const value = net !== null ? Math.abs(net) : Math.abs(num(order.filledValue) ?? (rawPrice ?? 0) * Math.abs(quantity));
    return {
      kind: "trade",
      externalId: id,
      at,
      ticker,
      symbol: ticker ? toYahooSymbol(ticker, rawCurrency) : null,
      name: str(inst.name) ?? ticker,
      quantity,
      price: rawPrice === null ? null : rawPrice / divisor,
      priceCurrency: priceCurrency || null,
      cash: quantity > 0 ? -value : value,
      currency: (str(wallet.currency) ?? str(order.currency) ?? priceCurrency).toUpperCase(),
      realized: num(wallet.realisedProfitLoss),
    };
  }
  // Older flat shape: { id, ticker, status, filledQuantity, fillPrice, filledValue, dateExecuted, … }.
  if (String(it.status ?? "").toUpperCase() !== "FILLED") return null;
  const id = str(it.fillId) ?? str(it.id);
  const at = str(it.dateExecuted) ?? str(it.dateModified) ?? str(it.dateCreated);
  const quantity = num(it.filledQuantity);
  if (!id || !at || quantity === null || quantity === 0) return null;
  const ticker = str(it.ticker);
  const price = num(it.fillPrice);
  const value = Math.abs(num(it.filledValue) ?? (price ?? 0) * Math.abs(quantity));
  return {
    kind: "trade",
    externalId: id,
    at,
    ticker,
    symbol: ticker ? toYahooSymbol(ticker) : null,
    name: ticker,
    quantity,
    price,
    priceCurrency: null,
    cash: quantity > 0 ? -value : value,
    currency: "",
    realized: null,
  };
}

export function parseDividend(item: unknown): BrokerActivity | null {
  const it = obj(item);
  const id = str(it.reference);
  const at = str(it.paidOn);
  const amount = num(it.amount);
  if (!id || !at || amount === null) return null;
  const inst = obj(it.instrument);
  const ticker = str(it.ticker) ?? str(inst.ticker);
  return {
    kind: "dividend",
    externalId: id,
    at,
    ticker,
    symbol: ticker ? toYahooSymbol(ticker, str(inst.currency) ?? "") : null,
    name: str(inst.name) ?? ticker,
    quantity: null,
    price: null,
    priceCurrency: null,
    cash: amount,
    currency: (str(it.currency) ?? "").toUpperCase(),
    realized: null,
  };
}

const TRANSACTION_KINDS: Record<string, BrokerActivityKind> = {
  DEPOSIT: "deposit",
  WITHDRAW: "withdrawal",
  WITHDRAWAL: "withdrawal",
  FEE: "fee",
  INTEREST_ON_FREE_CASH: "interest",
  INTEREST: "interest",
};

export function parseTransaction(item: unknown): BrokerActivity | null {
  const it = obj(item);
  const id = str(it.reference);
  const at = str(it.dateTime);
  let amount = num(it.amount);
  if (!id || !at || amount === null) return null;
  const type = String(it.type ?? "").toUpperCase();
  // A transfer between Trading 212 accounts is money in or out all the same.
  let kind: BrokerActivityKind = TRANSACTION_KINDS[type] ?? (type === "TRANSFER" ? (amount < 0 ? "withdrawal" : "deposit") : "other");
  if ((kind === "withdrawal" || kind === "fee") && amount > 0) amount = -amount;
  if (kind === "deposit" && amount < 0) kind = "withdrawal";
  return {
    kind,
    externalId: id,
    at,
    ticker: null,
    symbol: null,
    name: kind === "other" ? type || null : null,
    quantity: null,
    price: null,
    priceCurrency: null,
    cash: amount,
    currency: (str(it.currency) ?? "").toUpperCase(),
    realized: null,
  };
}

type PagedInput = FetchHistoryInput & { auth: string; fetchImpl: FetchLike };

async function pageAll(firstPath: string, parse: (item: unknown) => BrokerActivity | null, input: PagedInput) {
  const host = `https://${input.environment === "demo" ? "demo" : "live"}.trading212.com`;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const activities: BrokerActivity[] = [];
  let path: string | null = `/api/v0${firstPath}`;
  for (let page = 0; path; page++) {
    if (page >= HISTORY_MAX_PAGES) return { activities, incomplete: true, warning: `${firstPath}: stopped after ${page} pages` };
    if (page > 0) await sleep(HISTORY_PAGE_PAUSE_MS);
    let body: Record<string, unknown>;
    try {
      body = obj(await request(`${host}${path}`, firstPath.split("?")[0], input.auth, input.fetchImpl, HISTORY_FORBIDDEN));
    } catch (e) {
      // A bad key or a missing permission is the user's to fix; anything else (rate limit,
      // outage) ends this endpoint early, keeping what came, and the next run continues.
      if (e instanceof ConnectorError && (e.status === 401 || e.status === 403)) throw e;
      return { activities, incomplete: true, warning: e instanceof Error ? e.message : String(e) };
    }
    const items = Array.isArray(body.items) ? body.items : [];
    const parsed = items.map(parse).filter((a): a is BrokerActivity => a !== null);
    activities.push(...parsed);
    if (input.isKnown && parsed.length && parsed.every((a) => input.isKnown!(a.kind, a.externalId))) break;
    const next = str(body.nextPagePath);
    // Only ever follow a path on the same API, never a URL the response names.
    path = next && items.length && /^\/api\/v0\//.test(next) ? next : null;
  }
  return { activities, incomplete: false, warning: null };
}

async function fetchHistory(input: FetchHistoryInput) {
  if (input.environment !== "live" && input.environment !== "demo") throw new ConnectorError(`Unknown Trading 212 environment “${input.environment}”`);
  const paged: PagedInput = { ...input, auth: authHeader(input.credentials), fetchImpl: input.fetchImpl ?? fetch };
  const parts = await Promise.all([
    pageAll("/equity/history/orders?limit=50", parseOrder, paged),
    pageAll("/equity/history/dividends?limit=50", parseDividend, paged),
    pageAll("/history/transactions?limit=50", parseTransaction, paged),
  ]);
  return {
    activities: parts.flatMap((p) => p.activities),
    incomplete: parts.some((p) => p.incomplete),
    warnings: parts.map((p) => p.warning).filter((w): w is string => !!w),
  };
}

// ── Connector ─────────────────────────────────────────────────────────────

export const trading212: BrokerConnector = {
  id: "trading212",
  name: "Trading 212",
  description: "Invest and ISA accounts: positions, average prices and free cash, synced hourly.",
  setupHint:
    "In the Trading 212 app: Settings → API (Beta) → Generate API key. Grant only the read permissions — Account data, Portfolio, Metadata, and History (orders, dividends, transactions) to import past trades. wallet never places orders, so leave Orders off.",
  docsUrl: "https://docs.trading212.com/api",
  environments: [
    { id: "live", label: "Live (real money)" },
    { id: "demo", label: "Practice (demo)" },
  ],
  credentialFields: [
    { key: "apiKey", label: "API key", secret: false, placeholder: "e.g. 3523019ZSBkxMNL…" },
    { key: "apiSecret", label: "API secret", secret: true },
  ],

  fetchHistory,

  async fetchSnapshot({ credentials, environment, fetchImpl = fetch }) {
    if (environment !== "live" && environment !== "demo") throw new ConnectorError(`Unknown Trading 212 environment “${environment}”`);
    const auth = authHeader(credentials);
    const info = await accountInfo(auth, environment, fetchImpl);
    const cash = ((await get("/equity/account/cash", auth, environment, fetchImpl)) ?? {}) as Record<string, unknown>;
    const rows = await get("/equity/portfolio", auth, environment, fetchImpl);
    const portfolio = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    const meta = portfolio.length ? await instruments(auth, environment, fetchImpl) : new Map<string, Instrument>();

    const warnings: string[] = [];
    const positions: BrokerPosition[] = [];
    for (const r of portfolio) {
      const ticker = String(r.ticker ?? "");
      const quantity = num(r.quantity) ?? 0;
      if (!ticker || quantity === 0) continue;
      const inst = meta.get(ticker);
      if (!inst?.currency) {
        // Without the quote currency a price can't be valued: skipping beats a wrong total.
        warnings.push(`${ticker}: no instrument data, skipped`);
        continue;
      }
      const [currency, divisor] = majorUnit(inst.currency);
      const avg = num(r.averagePrice);
      const price = num(r.currentPrice);
      positions.push({
        externalId: ticker,
        symbol: toYahooSymbol(ticker, inst.currency),
        name: inst.name,
        assetType: holdingType(inst.type),
        quantity,
        currency,
        averagePrice: avg === null ? null : avg / divisor,
        price: price === null ? null : price / divisor,
      });
    }

    // free = available to invest; pieCash = uninvested cash inside pies;
    // blocked = reserved for pending orders. All three are still cash.
    const cashTotal = (num(cash.free) ?? 0) + (num(cash.pieCash) ?? 0) + (num(cash.blocked) ?? 0);
    return { externalAccountId: info.id, currency: info.currency, cash: cashTotal, positions, warnings };
  },
};
