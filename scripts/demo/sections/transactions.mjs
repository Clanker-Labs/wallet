// Transactions: search, categorize once and turn it into a rule, then import a
// bank CSV (column mapping, currency) that overlaps what's already imported.
import { record, sleep, startServer } from "../lib.mjs";
import { chooseOption, demoIds, dropFile, markPoster, minusDays, openDb, press, scrollTo, signIn, tune } from "../helpers-core.mjs";

const server = await startServer({ name: "transactions", port: Number(process.env.PORT ?? 3306) });

// A BoursoBank-style export of the last ten days: the older rows are already in
// the wallet (they'll be skipped), the last few are new.
function bankCsv() {
  const db = openDb(server.db);
  const { accounts } = demoIds(db);
  const today = new Date().toLocaleDateString("sv");
  const known = db
    .prepare("SELECT date, description, amount_cents AS cents FROM transactions WHERE account_id = ? AND date >= ? ORDER BY date DESC, id DESC")
    .all(accounts["Compte courant"], minusDays(today, 9));
  db.close();
  const fresh = [
    { date: today, description: "CB BOULANGERIE PAUL", cents: -640 },
    { date: today, description: "CB UBER EATS", cents: -2790 },
    { date: minusDays(today, 1), description: "CB CARREFOUR CITY LYON", cents: -4125 },
    { date: minusDays(today, 1), description: "CB SNCF CONNECT", cents: -5800 },
    { date: minusDays(today, 1), description: "CB PRAIRIAL", cents: -1950 },
  ];
  const rows = [...fresh, ...known].sort((a, b) => b.date.localeCompare(a.date));
  const fr = (iso) => iso.split("-").reverse().join("/");
  const amount = (c) => (c / 100).toFixed(2).replace(".", ",");
  const lines = ["Date opération;Date valeur;Libellé;Montant", ...rows.map((r) => `${fr(r.date)};${fr(r.date)};${r.description};${amount(r.cents)}`)];
  return { name: `export-boursobank-${today}.csv`, content: lines.join("\r\n") + "\r\n" };
}

try {
  const csv = bankCsv();
  await record("transactions", async (r) => {
    const rec = tune(r);
    const page = rec.page;
    const main = page.locator("main");

    await signIn(rec, server, "/transactions", "text=Quick add");
    await rec.start();

    // 1. One list, every account and currency.
    await rec.caption("Every transaction, from every account, in one list");
    await rec.move(main.locator("ul li").nth(2), 1000);
    await sleep(500);
    await rec.move(main.locator("ul li").nth(5).locator(".tabular"), 700);
    await sleep(1100);

    // 2. Filters and search.
    await rec.caption("Filter by month, category or account, or <b>search</b>");
    await rec.move("select[aria-label=Month]", 700);
    await rec.move("form[role=search] select[aria-label=Category]", 450);
    await rec.move("form[role=search] select[aria-label=Account]", 450);
    await rec.type("input[name=q]", "prairial", { delay: 85, ms: 550 });
    await press(rec, "Enter", 200);
    await page.waitForURL(/q=prairial/, { timeout: 20_000 });
    await main.getByText("CB PRAIRIAL").first().waitFor();
    await sleep(500);
    await rec.move(main.getByText(/transactions? · in/).first(), 700);
    await sleep(1100);

    // 3. Categorize once, then make it a rule.
    await rec.caption("Pick a category once…");
    const firstCategory = main.locator("ul li").first().locator("select[aria-label=Category]");
    await chooseOption(rec, firstCategory, "Restaurants & bars", { rows: 8 });
    const chip = main.locator("button").filter({ hasText: "Always categorize" }).first();
    await chip.waitFor({ timeout: 20_000 });
    await sleep(500);
    await rec.caption("…then one click files every <b>match</b>, now and later");
    await rec.move(chip, 700);
    await markPoster(rec);
    await sleep(800);
    await rec.click(chip, { ms: 300, after: 200 });
    await page.getByText(/Rule saved/).waitFor({ timeout: 20_000 });
    await rec.caption(""); // the toast says it: "Rule saved … N more categorized"
    await sleep(600);
    await rec.move(main.locator("ul li").nth(4).locator("select"), 900);
    await sleep(1600);

    // 4. Import a bank CSV.
    await rec.click("main a:has-text('Import CSV')", { ms: 900, after: 200 });
    const zone = main.locator("div.border-dashed").filter({ hasText: "Drop your bank" });
    await zone.waitFor({ timeout: 20_000 });
    await rec.caption("Import your bank's CSV export");
    await sleep(700);
    await dropFile(rec, zone, csv);
    await main.getByText("Preview", { exact: true }).waitFor({ timeout: 20_000 });
    await sleep(500);

    // 5. Columns, account and currency, preview.
    await rec.caption("Columns guessed for you: just pick the account");
    await rec.move(main.locator("label").filter({ hasText: "Date column" }).locator("select"), 800);
    await sleep(400);
    await rec.move(main.locator("label").filter({ hasText: "Description column" }).locator("select"), 500);
    await sleep(400);
    await chooseOption(rec, main.locator("label").filter({ hasText: "Into account" }).locator("select"), "Compte courant");
    await rec.move(main.locator("label").filter({ hasText: "Currency" }).locator("select"), 600);
    await sleep(900);
    await rec.caption("Check the preview, then import");
    await scrollTo(rec, main.getByText("Preview", { exact: true }), { top: 90, ms: 1000 });
    await rec.move(main.locator("tbody tr").nth(1).locator("td").last(), 800);
    await sleep(900);

    // 6. Duplicate-safe import.
    await rec.click(main.locator("button").filter({ hasText: /^Import \d+ transactions$/ }), { ms: 900, after: 200 });
    await main.getByText("Duplicates skipped").waitFor({ timeout: 20_000 });
    await sleep(300);
    await rec.caption("Overlapping exports are safe: <b>duplicates</b> are skipped");
    await rec.move(main.getByText("Duplicates skipped"), 900);
    await sleep(1400);
    await rec.move(main.getByText("Auto-categorized"), 600);
    await sleep(1600);
    await rec.caption("");
    await sleep(400);
  });
} finally {
  await server.stop();
}
