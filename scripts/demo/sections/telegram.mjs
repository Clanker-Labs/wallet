// Telegram: the real /reminders page, then a replay of the real bot's output
// (scripts/demo/replay/telegram-transcript.json, made by telegram-transcript.ts).
//
//   node scripts/demo/sections/telegram.mjs               # reuses the transcript if present
//   node scripts/demo/sections/telegram.mjs --transcript  # re-runs the bot (and the claude-code agent) first
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MEDIA, ROOT, baseDb, joinClips, record, startServer } from "../lib.mjs";
import { REPLAY, REPLAY_ORIGIN, click, hover, serveReplay, wheel } from "../helpers-ai.mjs";

const TRANSCRIPT = path.join(REPLAY, "telegram-transcript.json");
const TMP = path.join(os.tmpdir(), "wallet-demo");
fs.mkdirSync(TMP, { recursive: true });

if (!fs.existsSync(TRANSCRIPT) || process.argv.includes("--transcript")) {
  const db = path.join(TMP, "telegram-transcript.db");
  for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
  fs.copyFileSync(baseDb(), db);
  execFileSync(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(REPLAY, "telegram-transcript.ts"), TRANSCRIPT], {
    cwd: ROOT,
    env: { ...process.env, WALLET_DB_PATH: db, WALLET_AGENT_PROVIDER: process.env.WALLET_AGENT_PROVIDER ?? "claude-code" },
    stdio: "inherit",
  });
  for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
}
const transcript = JSON.parse(fs.readFileSync(TRANSCRIPT, "utf8"));

// ── Part 1: the reminders page ───────────────────────────────────────────
const part1 = path.join(TMP, "telegram-1.mp4");
const server = await startServer({ name: "telegram", port: Number(process.env.PORT ?? 3313) });
try {
  await record(
    "telegram-1",
    async (rec) => {
      await rec.goto(server.loginUrl(), { waitFor: "text=Net worth" });
      await rec.goto(server.url + "/reminders", { waitFor: "text=Start from a preset" });
      // Start with the reminder list and the new-reminder form side by side.
      await rec.page.locator("text=Your reminders").first().evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 96));
      await rec.start();
      await rec.caption("Monthly money chores, as <b>Telegram</b> reminders", 600);
      await hover(rec, "text=re-sends every 24h until done", 800);
      await rec.pause(900);
      await click(rec, "text=Monthly: update balances (1st, 09:00, nag 24h)", { ms: 700, after: 400 });
      await wheel(rec, 230, 600);
      await hover(rec, `[aria-label="Nag until done"] [role="radio"]:has-text("24h")`, 700);
      await rec.pause(1500);
    },
    { out: part1, holdEnd: 0.4 },
  );
} finally {
  await server.stop();
}

// ── Part 2: the replay ───────────────────────────────────────────────────
const part2 = path.join(TMP, "telegram-2.mp4");
const readMs = (html) => Math.min(1700, Math.max(650, 300 + html.replace(/<[^>]+>/g, "").length * 6));

await record(
  "telegram-2",
  async (rec) => {
    const { page } = rec;
    await serveReplay(rec);
    await rec.goto(`${REPLAY_ORIGIN}/telegram.html`);
    const events = [...transcript.events];
    // Yesterday's reminder is already in the chat when the clip starts.
    const firstBot = events.findIndex((e) => e.type === "bot");
    await page.evaluate((history) => {
      for (const e of history) e.type === "date" ? replay.date(e.label, { instant: true }) : replay.bot(e, { instant: true });
    }, events.slice(0, firstBot + 1));
    events.splice(0, firstBot + 1);
    await page.mouse.move(900, 420);
    await rec.start();
    await rec.caption("Telegram <b>nags</b> until it's done · replayed from the real bot");
    await rec.pause(1000);

    let posterNext = false;
    for (const [i, e] of events.entries()) {
      const next = events[i + 1];
      switch (e.type) {
        case "date":
          await page.evaluate((l) => replay.date(l), e.label);
          await rec.pause(350);
          break;
        case "bot": {
          await page.evaluate((ev) => replay.bot(ev, { typingMs: 350 }), e);
          if (posterNext) {
            posterNext = false;
            await rec.pause(500);
            rec.poster();
          }
          const tall = await page.evaluate(() => {
            const rows = document.querySelectorAll(".row.in");
            const last = rows[rows.length - 1];
            return last.offsetHeight > document.getElementById("chat").clientHeight - 24;
          });
          if (!next) {
            // The assistant's answer: its top, then the rest, then settle.
            await rec.pause(2000);
            if (tall) await page.evaluate(() => replay.scrollToBottom(1700));
            await rec.pause(1100);
          } else if (tall) {
            await rec.pause(600);
            await page.evaluate(() => replay.scrollToBottom(1300));
            await rec.pause(600);
          } else {
            await rec.pause(readMs(e.html));
          }
          break;
        }
        case "user":
          if (e.text) {
            if (e.text.startsWith("/networth")) {
              await rec.caption("Net worth, budgets and spending <b>on the go</b>");
              posterNext = true;
            }
            await page.evaluate((t) => replay.type(t, 30), e.text);
            await click(rec, "#send", { after: 0, ms: 350 });
            await page.evaluate((ev) => replay.sendText(ev), e);
            await rec.pause(150);
          } else if (e.file) {
            await rec.caption("Send a statement: the <b>assistant</b> imports it");
            await click(rec, "#attach", { after: 250, ms: 550 });
            await page.evaluate((ev) => replay.sendFile(ev), e);
            await rec.pause(400);
          }
          break;
        case "tap": {
          if (e.button.includes("Update balances")) await rec.caption("Update every balance in a few quick replies");
          const sel = await page.evaluate(({ m, b }) => replay.buttonSelector(m, b), { m: e.message, b: e.button });
          if (sel) await click(rec, sel, { after: 150, ms: 600 });
          break;
        }
        case "toast":
          void page.evaluate((t) => replay.toast(t, 1300), e.text);
          await rec.pause(400);
          break;
        case "keyboard_removed":
          await page.evaluate((id) => replay.removeKeyboard(id), e.message);
          await rec.pause(700);
          break;
        case "typing":
          // The real assistant run took e.ms; show it sped up.
          await page.evaluate(() => replay.typing(true));
          await rec.fastForward(() => rec.pause(Math.min(e.ms, 30_000)), 12);
          break;
      }
    }
  },
  { out: part2, holdEnd: 0.8 },
);

const out = path.join(MEDIA, "telegram.mp4");
joinClips([part1, part2], out, { fade: 0.5 });
fs.copyFileSync(part2.replace(/\.mp4$/, ".jpg"), path.join(MEDIA, "telegram.jpg"));
for (const f of [part1, part2, part1.replace(/\.mp4$/, ".jpg"), part2.replace(/\.mp4$/, ".jpg")]) fs.rmSync(f, { force: true });
