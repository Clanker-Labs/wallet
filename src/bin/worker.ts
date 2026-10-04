/**
 * Telegram worker: answers bot commands and delivers reminders.
 *
 *   npm run worker              long-poll for messages + reminder tick every 30 s
 *   npm run worker -- --once    run one reminder tick and exit (for cron)
 *   npm run worker -- --test    send a test message to every allowed chat and exit
 */
import fs from "node:fs";
import { db, dbPath } from "@/server/db/client";
import { refreshMarketData as refreshMarket } from "@/server/services/market";
import { listUsers } from "@/server/services/users";
import { allowedChatIds, createApi, TelegramError, type TelegramApi } from "@/server/telegram/api";
import { handleUpdate, type BotContext } from "@/server/telegram/bot";
import { BOT_COMMANDS } from "@/server/telegram/messages";
import { tick } from "@/server/telegram/scheduler";

const POLL_TIMEOUT_SEC = 25;
const TICK_EVERY_MS = 30_000;
const MARKET_EVERY_MS = 60 * 60_000;

/** Daily FX rates + market prices, then today's value of holdings-based accounts. */
async function refreshMarketData() {
  for (const line of (await refreshMarket()).log) log(line);
}

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Like Next.js: .env.local wins over .env, and real env vars win over both. */
function loadEnvFiles() {
  for (const file of [".env.local", ".env"]) {
    if (fs.existsSync(file)) process.loadEnvFile(file);
  }
}

const SETUP_GUIDE = `
wallet · Telegram setup
  1. In Telegram, talk to @BotFather → /newbot → copy the bot token.
  2. Add it to .env:   TELEGRAM_BOT_TOKEN=123456:ABC...
  3. Run the worker:   npm run worker
  4. In the web app:   Settings → Telegram → "Generate link code", then send /start CODE to your bot.
`;

async function sendTest(api: TelegramApi, chatIds: number[]) {
  let ok = true;
  for (const chatId of chatIds) {
    try {
      await api.sendMessage(chatId, "✅ wallet bot connected");
      log(`✅ test message sent to chat ${chatId}`);
    } catch (e) {
      ok = false;
      log(`❌ chat ${chatId}: ${errorText(e)}`);
    }
  }
  return ok;
}

async function runForever(api: TelegramApi, chatIds: number[]) {
  const me = await api.getMe();
  await api.setMyCommands(BOT_COMMANDS.map(({ command, description }) => ({ command, description })));
  log(
    `🤖 @${me.username} online · db ${dbPath()} · ${chatIds.length ? `owner chats ${chatIds.join(", ")}` : "chats linked from Settings → Telegram"}`,
  );

  const controller = new AbortController();
  const ctx: BotContext = { api, allowedChatIds: chatIds, botUsername: me.username, signal: controller.signal, log };
  const inflight = new Set<Promise<void>>();

  let ticking = false;
  const runTick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const s = await tick(new Date(), api, chatIds, log);
      if (s.failed) log(`⚠️ ${s.failed} reminder(s) not delivered, retrying next tick`);
    } catch (e) {
      log(`⚠️ scheduler: ${errorText(e)}`);
    } finally {
      ticking = false;
    }
  };
  void runTick();
  const timer = setInterval(runTick, TICK_EVERY_MS);
  // Exchange rates and market prices: refresh in the background, record daily values.
  void refreshMarketData();
  const marketTimer = setInterval(refreshMarketData, MARKET_EVERY_MS);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) process.exit(1); // second Ctrl-C: don't wait
    stopping = true;
    log(`${signal} received, shutting down…`);
    clearInterval(timer);
    clearInterval(marketTimer);
    controller.abort();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  let offset = 0;
  let backoffMs = 1_000;
  while (!stopping) {
    try {
      const updates = await api.getUpdates(offset, POLL_TIMEOUT_SEC, controller.signal);
      backoffMs = 1_000;
      for (const update of updates) {
        offset = update.update_id + 1;
        // Not awaited: a slow agent answer must not block buttons or other commands.
        const p: Promise<void> = handleUpdate(update, ctx).finally(() => inflight.delete(p));
        inflight.add(p);
      }
    } catch (e) {
      if (stopping) break;
      const hint =
        e instanceof TelegramError && e.code === 409 ? " (another worker is polling, or a webhook is set)" : "";
      log(`⚠️ polling: ${errorText(e)}${hint} — retrying in ${backoffMs / 1000}s`);
      await sleep(backoffMs, controller.signal);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }

  // Let in-flight handlers finish briefly, and confirm the last batch so it isn't replayed.
  await Promise.race([Promise.allSettled([...inflight]), sleep(5_000)]);
  await api.getUpdates(offset, 0).catch(() => {});
  log("👋 bye");
}

async function main() {
  loadEnvFiles();
  const args = new Set(process.argv.slice(2));
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = allowedChatIds();

  if (!token) {
    console.error(`TELEGRAM_BOT_TOKEN is not set.\n${SETUP_GUIDE}`);
    process.exit(1);
  }
  // TELEGRAM_API_URL: optional, for a self-hosted Bot API server.
  const api = createApi(token, { baseUrl: process.env.TELEGRAM_API_URL || undefined });

  db(); // open & migrate before anything else

  if (args.has("--test")) {
    const targets = [...new Set([...chatIds, ...listUsers().flatMap((u) => (u.telegramChatId ? [u.telegramChatId] : []))])];
    process.exit((await sendTest(api, targets)) ? 0 : 1);
  }
  if (args.has("--once")) {
    const s = await tick(new Date(), api, chatIds, log);
    log(`tick done · sent ${s.sent} · nagged ${s.nagged} · failed ${s.failed}`);
    process.exit(s.failed ? 1 : 0);
  }
  await runForever(api, chatIds);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof TelegramError && e.code === 401 ? "TELEGRAM_BOT_TOKEN was rejected by Telegram (401)." : e);
  process.exit(1);
});
