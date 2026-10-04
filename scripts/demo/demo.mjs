// The full walkthrough: an intro card, then each section with its title card, then an outro.
// Needs the section clips in site/media (see record-all.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { titleCard } from "./cards.mjs";
import { joinClips, MEDIA } from "./lib.mjs";
import { execFileSync } from "node:child_process";

export const CHAPTERS = [
  ["signup", "Sign up", "Create your account with a <em>passkey</em>", "Face ID on your iPhone through a QR code, or this device. No passwords, no OAuth."],
  ["net-worth", "Net worth", "Everything you own, <em>in one number</em>", "History, allocation by asset class, and what needs your attention."],
  ["accounts", "Accounts", "Every account, <em>any currency</em>", "Converted daily to your base currency with free exchange rates."],
  ["investments", "Investments", "Stocks, ETFs, crypto, <em>gold</em>", "Daily prices, gains vs cost basis, allocation by type and currency."],
  ["assistant", "Assistant", "Drop a statement. <em>It's imported.</em>", "CSV, PDF or a screenshot: the assistant reads it and fills your wallet in."],
  ["budgets", "Budgets", "Envelopes that tell you <em>when you're going too fast</em>", "Pace markers, savings rate and cash flow."],
  ["transactions", "Transactions", "Categorized <em>once</em>, remembered forever", "Rules, a CSV import wizard and duplicate-safe re-imports."],
  ["simulations", "Simulations", "Can I afford <em>that apartment?</em>", "Mortgage, borrowing capacity, buy vs rent and a net-worth projection."],
  ["telegram", "Reminders", "Nagged until <em>it's done</em>", "Telegram reminders with buttons, a one-question-at-a-time balance update, file imports."],
  ["settings", "Settings", "Passkeys, currencies, <em>your data</em>", "Add devices, pick your base currency, link Telegram, export everything."],
  ["mcp", "MCP & API", "Your wallet in <em>any AI agent</em>", "The same tools over MCP for Claude Code, Codex, Claude Desktop, or plain HTTP."],
];

export async function buildDemo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-demo-"));
  const parts = [];
  parts.push(
    await titleCard(path.join(tmp, "00-intro.mp4"), {
      big: true,
      title: "A tour of <em>wallet</em>",
      subtitle: "Self-hosted net worth, budgets and investments, with an assistant that does the typing.",
    }, 4),
  );
  let n = 0;
  for (const [clip, kicker, title, subtitle] of CHAPTERS) {
    const file = path.join(MEDIA, `${clip}.mp4`);
    if (!fs.existsSync(file)) {
      console.warn(`skipping ${clip}: ${file} not recorded`);
      continue;
    }
    n++;
    parts.push(await titleCard(path.join(tmp, `${String(n).padStart(2, "0")}-card.mp4`), { kicker: `${n} · ${kicker}`, title, subtitle, logo: false }, 2.6));
    parts.push(file);
  }
  parts.push(
    await titleCard(path.join(tmp, "99-outro.mp4"), {
      big: true,
      title: "Your money, <em>on your machine.</em>",
      subtitle: "Open source · MIT · github.com/Clanker-Labs/wallet",
      footer: "npm install && npm run dev",
    }, 4.5),
  );
  const out = path.join(MEDIA, "demo.mp4");
  joinClips(parts, out, { fade: 0.45 });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "1.6", "-i", out, "-frames:v", "1", "-q:v", "3", out.replace(/\.mp4$/, ".jpg")]);
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) await buildDemo();
