// Assistant: drop a PDF statement anywhere → the real Claude Code agent imports it → follow-up question.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { record, startServer } from "../lib.mjs";
import { dragFileIn, htmlToPdf, statementHtml } from "../helpers-ai.mjs";

const FILE = "chase-statement-2026-09.pdf";
const pdf = path.join(os.tmpdir(), "wallet-demo", FILE);
await htmlToPdf(statementHtml(), pdf);

const server = await startServer({
  name: "assistant",
  port: Number(process.env.PORT ?? 3311),
  env: { WALLET_AGENT_PROVIDER: "claude-code" },
});

const stopButton = 'button[aria-label="Stop"]';
const composer = 'textarea[aria-label="Message the assistant"]';

/** Scroll the chat column smoothly by dy CSS px (the chat scrolls inside its own panel). */
async function scrollChat(page, to, ms = 1400) {
  await page.evaluate(
    ({ to, ms }) =>
      new Promise((done) => {
        const el = document.querySelector('section[aria-label="Assistant chat"] .overflow-y-auto');
        const from = el.scrollTop;
        const target = to === "bottom" ? el.scrollHeight - el.clientHeight : typeof to === "number" ? to : from;
        const t0 = performance.now();
        const step = (t) => {
          const k = Math.min(1, (t - t0) / ms);
          const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          el.scrollTop = from + (target - from) * e;
          if (k < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      }),
    { to, ms },
  );
}

/** Top offset (inside the chat scroller) of the last assistant answer. */
const lastAnswerTop = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('section[aria-label="Assistant chat"] .overflow-y-auto');
    const answers = el.querySelectorAll(".prose-chat");
    const last = answers[answers.length - 1];
    const tools = last?.parentElement;
    return tools ? tools.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 12 : 0;
  });

const Database = createRequire(import.meta.url)("better-sqlite3");
const chaseId = (() => {
  const db = new Database(server.db, { readonly: true });
  const row = db.prepare("SELECT id FROM accounts WHERE name = 'Chase Checking'").get();
  db.close();
  return row.id;
})();

try {
  await record("assistant", async (rec) => {
    const { page } = rec;
    await rec.goto(server.loginUrl(), { waitFor: "text=Net worth" });
    await rec.goto(server.url + "/accounts", { waitFor: "text=Chase Checking" });
    await rec.start();
    await rec.caption("Drop a bank statement <b>anywhere</b> in the app", 1200);

    // Drag the PDF in from the right edge, like from Finder, and drop it mid-page.
    await dragFileIn(rec, { file: pdf, name: FILE, mime: "application/pdf", to: { x: 660, y: 360 }, ms: 2000, hover: 900 });
    await page.waitForURL(/\/assistant/, { timeout: 30_000 });
    await rec.caption("The assistant reads it and imports every line");
    await page.locator(stopButton).waitFor({ timeout: 30_000 });
    await rec.moveTo(1180, 300, 800);
    await rec.pause(1800);

    // The real Claude Code run: tool chips appear as it reads, matches the account and imports.
    await rec.fastForward(() => page.locator(stopButton).waitFor({ state: "detached", timeout: 10 * 60_000 }), 10);
    await page.locator(".prose-chat").last().waitFor();
    await rec.pause(400);
    await scrollChat(page, await lastAnswerTop(page), 1200);
    await rec.caption("Matched to the right account, every line <b>categorized</b>");
    await rec.pause(3800);
    await scrollChat(page, "bottom", 1600);
    await rec.pause(2400);

    // Follow-up question.
    await rec.caption("");
    await rec.type(composer, "Where did my money go last month?", { delay: 45 });
    await rec.pause(300);
    await page.keyboard.press("Enter");
    await page.locator(stopButton).waitFor({ timeout: 30_000 });
    await rec.caption("Ask anything: answers come from <b>your</b> data");
    await rec.pause(1500);
    await rec.fastForward(() => page.locator(stopButton).waitFor({ state: "detached", timeout: 10 * 60_000 }), 10);
    await rec.pause(400);
    await scrollChat(page, await lastAnswerTop(page), 1200);
    await rec.caption("");
    rec.poster();
    await rec.pause(4200);
    await scrollChat(page, "bottom", 1800);
    await rec.pause(3000);

    // The import really landed: the Chase account's transactions.
    await rec.goto(`${server.url}/transactions?account=${chaseId}&from=2026-09-01&to=2026-09-30`, { waitFor: "text=Transactions" });
    await rec.caption("Everything lands in your ledger, ready for budgets");
    await rec.pause(3200);
  });
} finally {
  // Proof the import happened, straight from the clip's database.
  try {
    const db = new Database(server.db, { readonly: true });
    const rows = db
      .prepare(
        `SELECT t.date, t.amount_cents, t.description, c.name AS category FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id WHERE t.source = 'agent' ORDER BY t.date`,
      )
      .all();
    console.log(`agent-imported transactions: ${rows.length}`);
    for (const r of rows) console.log(`  ${r.date} ${(r.amount_cents / 100).toFixed(2).padStart(9)} ${r.description} [${r.category ?? "-"}]`);
    const answers = db.prepare(`SELECT content FROM agent_messages WHERE role = 'assistant' ORDER BY id`).all();
    for (const a of answers) console.log("--- answer ---\n" + JSON.parse(a.content).map((b) => b.text ?? "").join(""));
    db.close();
  } catch (e) {
    console.log("could not inspect the db:", e.message);
  }
  await server.stop();
  fs.rmSync(pdf, { force: true });
}
