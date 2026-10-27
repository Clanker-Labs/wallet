/**
 * Keeps prices, rates, brokerage syncs, the daily snapshot of investment
 * accounts and the daily backup going while nobody has the app open. Without it they only refresh
 * on a page view, and a week without visits is a week missing from the daily
 * net-worth chart. Node.js runtime only; WALLET_BACKGROUND_REFRESH=0 turns it
 * off (the Telegram worker does the same job hourly when it runs).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (/^(0|false|no|off)$/i.test(process.env.WALLET_BACKGROUND_REFRESH ?? "")) return;
  const g = globalThis as unknown as { __walletRefreshTimer?: NodeJS.Timeout };
  if (g.__walletRefreshTimer) return;
  const { refreshMarketDataInBackground } = await import("./server/services/market");
  const { ensureDailyBackup } = await import("./server/services/backup");
  const tick = () => {
    void refreshMarketDataInBackground().catch((e) => console.warn("[market] background refresh failed:", e));
    // A backup a day, kept 14 days plus 8 weekly copies (WALLET_BACKUPS=0 turns it off).
    if (!/^(0|false|no|off)$/i.test(process.env.WALLET_BACKUPS ?? "")) {
      try {
        ensureDailyBackup();
      } catch (e) {
        console.warn("[backup] daily backup failed:", e);
      }
    }
  };
  g.__walletRefreshTimer = setInterval(tick, 60 * 60_000);
  g.__walletRefreshTimer.unref?.();
  setTimeout(tick, 60_000).unref?.();
}
