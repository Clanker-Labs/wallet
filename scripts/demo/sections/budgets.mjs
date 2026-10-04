// Budgets: envelopes with today's pace, over / spending-fast badges, editing an
// envelope, last month's income / savings rate, and 12 months of cash flow.
import { record, sleep, startServer } from "../lib.mjs";
import { insertTransactions, markPoster, openDb, press, scrollTo, signIn, sweep, tune } from "../helpers-core.mjs";

const server = await startServer({ name: "budgets", port: Number(process.env.PORT ?? 3305) });

// The demo month has only just started: add a few days of everyday spending so
// the envelopes have something to show (restaurants running fast, shopping over).
{
  const db = openDb(server.db);
  const today = new Date().toLocaleDateString("sv");
  const day = (n) => {
    const d = `${today.slice(0, 8)}${String(n).padStart(2, "0")}`;
    return d > today ? today : d;
  };
  insertTransactions(db, [
    { account: "Compte courant", date: day(1), amount: -64.5, description: "CB LE BOUCHON DES FILLES", category: "Restaurants & bars" },
    { account: "Compte courant", date: day(1), amount: -38.6, description: "CB CARREFOUR CITY LYON", category: "Groceries" },
    { account: "Compte courant", date: day(2), amount: -31.2, description: "CB DELIVEROO", category: "Restaurants & bars" },
    { account: "Compte courant", date: day(2), amount: -54.9, description: "CB AMAZON EU SARL", category: "Shopping" },
    { account: "Compte courant", date: day(3), amount: -42, description: "CB BAR LA MAISON", category: "Restaurants & bars" },
    { account: "Compte courant", date: day(3), amount: -189, description: "CB FNAC BELLECOUR", category: "Shopping" },
    { account: "Compte courant", date: day(4), amount: -23.8, description: "CB UGC CINE CITE", category: "Leisure" },
  ]);
  db.close();
}

try {
  await record("budgets", async (r) => {
    const rec = tune(r);
    const page = rec.page;
    const envelope = (name) => page.locator("main li").filter({ has: page.locator(`a:text-is("${name}")`) });

    await signIn(rec, server, "/budgets", "text=Envelopes");
    await rec.start();

    // 1. Envelopes and today's pace.
    await rec.caption("Monthly envelopes, with a tick for <b>today's pace</b>");
    const tick = page.locator("div[title=Today]").first();
    const t = await tick.boundingBox();
    await rec.moveTo(t.x + 6, t.y + 14, 1000);
    await sleep(1800);

    // 2. Badges.
    await rec.caption("Over budget or spending fast? You see it at a glance");
    await rec.move(page.locator("main").getByText(/^over by/).first(), 800);
    await markPoster(rec);
    await sleep(1100);
    await rec.move(page.locator("main").getByText("spending fast").first(), 600);
    await sleep(1300);

    // 3. Edit an envelope.
    await rec.caption("Click an amount to <b>adjust</b> the envelope");
    await rec.click(envelope("Shopping").locator("button").last(), { ms: 800, after: 300 });
    await press(rec, "ControlOrMeta+a", 150);
    await page.keyboard.type("300", { delay: 140 });
    await sleep(400);
    await press(rec, "Enter", 200);
    await envelope("Shopping").getByText("$300").waitFor({ timeout: 20_000 });
    await sleep(1600);

    // 4. Last month: income, spending, savings rate, where it went.
    await rec.caption("Income, spending and your <b>savings rate</b>, month by month");
    await rec.click("a[aria-label='Previous month']", { ms: 900, after: 200 });
    await page.locator("main").getByText(/\d+% savings rate/).waitFor({ timeout: 20_000 });
    await sleep(500);
    await rec.move(page.locator("main").getByText("Income", { exact: true }).first(), 700);
    await sleep(700);
    await rec.move(page.locator("main").getByText(/\d+% savings rate/), 800);
    await sleep(1600);
    await rec.caption("…and where the money went");
    const bars = page.locator("section").filter({ hasText: "Where it went" });
    await rec.move(bars.getByText("Groceries").first(), 900);
    await sleep(700);
    await rec.move(bars.getByText("Housing").first(), 600);
    await sleep(1300);

    // 5. Cash flow over 12 months (the chart ends the page: no caption over its axis).
    await rec.caption("Twelve months of cash flow, side by side");
    await scrollTo(rec, "text=Last 12 months", { top: 200, ms: 1200 });
    await sleep(900);
    await rec.caption("");
    const chart = page.locator(".recharts-wrapper").last();
    await sweep(rec, chart, [0.3, 0.55, 0.8], { y: 0.5, ms: 650, hold: 450 });
    await sleep(1500);
  });
} finally {
  await server.stop();
}
