import { snapshotHoldingAccounts } from "./accounts";
import { syncStaleConnections } from "./connections";
import { ensureFreshRates, ensureHistoricalRates } from "./fx";
import { refreshPrices } from "./prices";
import { listUsers } from "./users";
import { reconcileRecurring } from "./recurring";

/**
 * Exchange rates, market prices, brokerage syncs, then today's value of
 * every holdings-based account. Brokers go after prices so their own price
 * for today is the one that sticks. Shared by the worker (hourly) and the web app (throttled, after
 * responses), so an install without the Telegram worker stays current too.
 * Never throws; problems come back as messages.
 */
export async function refreshMarketData(opts: { fetchImpl?: typeof fetch } = {}): Promise<{ log: string[] }> {
  const log: string[] = [];
  try {
    const fx = await ensureFreshRates({ fetchImpl: opts.fetchImpl });
    if (fx.status === "updated") log.push(`💱 rates updated to ${fx.date}`);
    if (fx.status === "failed") log.push(`⚠️ rates: ${fx.error}`);
    const history = await ensureHistoricalRates({ fetchImpl: opts.fetchImpl });
    if (history.days || history.monthEnds) log.push(`💱 past rates filled: ${history.days} days, ${history.monthEnds} month-ends`);
    if (history.error) log.push(`⚠️ past rates: ${history.error}`);
    const prices = await refreshPrices({ fetchImpl: opts.fetchImpl });
    if (prices.updated.length) log.push(`📈 prices updated: ${prices.updated.join(", ")}`);
    if (prices.failed.length) log.push(`⚠️ prices: ${prices.failed.map((f) => f.error).join("; ")}`);
    log.push(...(await syncStaleConnections({ fetchImpl: opts.fetchImpl })).log);
    for (const u of listUsers()) {
      snapshotHoldingAccounts(u.id);
      reconcileRecurring(u.id); // moves late items on, links anything that arrived
    }
  } catch (e) {
    log.push(`⚠️ market data: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { log };
}

const WEB_EVERY_MS = 30 * 60_000;
let lastWebRun = 0;
let webRun: Promise<unknown> | null = null;

/** The web app's share: at most every 30 minutes per process, one run at a time. */
export function refreshMarketDataInBackground(now = Date.now()): Promise<unknown> {
  if (webRun) return webRun;
  if (now - lastWebRun < WEB_EVERY_MS) return Promise.resolve();
  lastWebRun = now;
  webRun = refreshMarketData()
    .then(({ log }) => {
      for (const line of log) if (line.startsWith("⚠️")) console.warn(`[market] ${line}`);
    })
    .finally(() => {
      webRun = null;
    });
  return webRun;
}
