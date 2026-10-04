// Investments: portfolio hero, allocation by type, account filters, the holdings
// table, and adding a position without a ticker (manual price).
import { record, sleep, startServer } from "../lib.mjs";
import { center, chooseOption, markPoster, scrollTo, signIn, tune } from "../helpers-core.mjs";

const server = await startServer({ name: "investments", port: Number(process.env.PORT ?? 3304) });
try {
  await record("investments", async (r) => {
    const rec = tune(r);
    const page = rec.page;
    const pill = (name) => page.locator("nav[aria-label='Filter by account'] a").filter({ hasText: new RegExp(`^${name}$`) });
    const holdingRow = (title) => page.locator("[role=row]").filter({ has: page.locator(`span:text-is("${title}")`) });

    await signIn(rec, server, "/investments", "text=Holdings value");
    await rec.start();

    // 1. Hero: value and unrealized gain.
    await rec.caption("Every position, valued at <b>market prices</b>");
    await rec.move("text=Holdings value · USD", 900);
    await sleep(400);
    await rec.move(page.getByText("unrealized", { exact: false }).first(), 700);
    await sleep(1100);

    // 2. Allocation donut.
    await rec.caption("Allocation by type: ETFs, funds, crypto, gold…");
    const donut = await center(rec, ".recharts-pie");
    const ring = donut.box.width * 0.42;
    for (const deg of [70, 190, 285]) {
      const a = (deg * Math.PI) / 180;
      await rec.moveTo(donut.x + ring * Math.cos(a), donut.y - ring * Math.sin(a), 600);
      if (deg === 190) await markPoster(rec);
      await sleep(550);
    }
    await sleep(200);

    // 3. Filter by account.
    await rec.caption("Filter by account: value, gain and mix for each");
    await rec.click(pill("PEA"), { ms: 800, after: 200 });
    await page.getByText("PEA · Holdings value").waitFor({ timeout: 20_000 });
    await sleep(500);
    await rec.move("text=PEA · Holdings value", 700);
    await sleep(1200);
    await rec.click(pill("All accounts"), { ms: 700, after: 200 });
    await page.getByText("Positions").first().waitFor();
    await page.locator("nav[aria-label='Filter by account'] a[aria-current=page]").filter({ hasText: "All accounts" }).waitFor();
    await sleep(300);

    // 4. Holdings table.
    await rec.caption("Quantity, price, value and gain for every holding");
    await scrollTo(rec, page.locator("h2").filter({ hasText: "Brokerage" }), { top: 60, ms: 1100 });
    await rec.move(holdingRow("AAPL").locator("[role=cell]").nth(2), 800);
    await sleep(400);
    await rec.move(holdingRow("AAPL").locator("[role=cell]").nth(4), 600);
    await sleep(1100);

    // 5. Add a position without a ticker.
    await rec.scroll(-(await page.evaluate(() => scrollY)), 800);
    await rec.caption("No ticker? Set a <b>manual price</b>: coins, bars, funds");
    await rec.click("main a:has-text('Add holding')", { ms: 800, after: 200 });
    await page.locator("select[name=accountId]").waitFor();
    await sleep(300);
    await chooseOption(rec, "select[name=accountId]", "Gold coins");
    await rec.type("input[name=name]", "Silver bar", { delay: 70, ms: 550 });
    await rec.type("input[name=quantity]", "10", { delay: 110, ms: 450 });
    await rec.type("input[name=costTotal]", "280", { delay: 100, ms: 500 });
    await rec.type("input[name=manualPrice]", "31", { delay: 110, ms: 500 });
    await sleep(200);
    await rec.click("button[type=submit]:has-text('Add holding')", { ms: 700, after: 200 });
    await page.getByText("Added Silver bar").waitFor({ timeout: 20_000 });
    await sleep(900);

    // 6. Valued with the rest.
    await rec.caption("Valued and counted with the rest of your portfolio");
    await rec.click("main a[aria-label=Close]", { ms: 700, after: 300 });
    await scrollTo(rec, page.locator("h2").filter({ hasText: "Gold coins" }), { top: 200, ms: 1100 });
    await rec.move(holdingRow("Silver bar").getByText("manual price"), 800);
    await sleep(700);
    await rec.move(holdingRow("Silver bar").locator("[role=cell]").nth(4), 700);
    await sleep(1600);
    await rec.caption("");
    await sleep(400);
  });
} finally {
  await server.stop();
}
