import { snapshotHoldingAccounts } from "./accounts";
import { ensureFreshRates } from "./fx";
import { refreshPrices } from "./prices";
import { listUsers } from "./users";

/**
 * Exchange rates, market prices, then today's value of every holdings-based
 * account. Shared by the worker (hourly) and the web app (throttled, after
 * responses), so an install without the Telegram worker stays current too.
 * Never throws; problems come back as messages.
 */
export async function refreshMarketData(opts: { fetchImpl?: typeof fetch } = {}): Promise<{ log: string[] }> {
  const log: string[] = [];
  try {
    const fx = await ensureFreshRates({ fetchImpl: opts.fetchImpl });
    if (fx.status === "updated") log.push(`💱 rates updated to ${fx.date}`);
    if (fx.status === "failed") log.push(`⚠️ rates: ${fx.error}`);
    const prices = await refreshPrices({ fetchImpl: opts.fetchImpl });
    if (prices.updated.length) log.push(`📈 prices updated: ${prices.updated.join(", ")}`);
    if (prices.failed.length) log.push(`⚠️ prices: ${prices.failed.map((f) => f.error).join("; ")}`);
    for (const u of listUsers()) snapshotHoldingAccounts(u.id);
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
