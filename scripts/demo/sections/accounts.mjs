// Accounts: grouped list in native currencies, add a EUR account, quick balance
// update, an account's history, and the 50% flat with its self-amortizing mortgage.
import { record, sleep, startServer } from "../lib.mjs";
import { chooseOption, markPoster, press, scrollTo, signIn, sweep, tune } from "../helpers-core.mjs";

const server = await startServer({ name: "accounts", port: Number(process.env.PORT ?? 3303) });
try {
  await record("accounts", async (r) => {
    const rec = tune(r);
    const page = rec.page;
    const row = (name) => page.locator("main li").filter({ has: page.locator(`a:text-is("${name}")`) });

    await signIn(rec, server, "/accounts", "text=Cash & savings");
    await rec.start();

    // 1. Grouped by class, each in its own currency.
    await rec.caption("Every account by class, in its <b>own currency</b>");
    await rec.move(row("Compte courant").locator(".tabular").first(), 900);
    await sleep(450);
    await rec.move(row("Compte courant").locator(".tabular").nth(1), 450);
    await sleep(1000);

    // 2. Add a savings account in EUR.
    await rec.caption("Add any account, in any currency");
    await rec.click("main a:has-text('Add account')", { ms: 700, after: 250 });
    await page.locator("input[name=name]:focus").waitFor();
    await sleep(200);
    await page.keyboard.type("LDDS", { delay: 110 });
    await sleep(200);
    await chooseOption(rec, "select[name=type]", "savings", { after: 250 });
    await rec.type("input[name=balance]", "8000", { delay: 90 });
    await chooseOption(rec, "select[name=currency]", "EUR", { after: 250 });
    await rec.click("button[type=submit]:has-text('Add account')", { ms: 600, after: 200 });
    await page.getByText("Added “LDDS”").waitFor({ timeout: 20_000 });
    await sleep(700);
    await rec.click("main a[aria-label=Close]", { ms: 600, after: 300 });
    await row("LDDS").waitFor();
    await rec.caption("Shown in euros, counted in dollars at <b>today's rate</b>");
    await rec.move(row("LDDS").locator(".tabular").nth(1), 750);
    await markPoster(rec);
    await sleep(1100);

    // 3. Record a new balance inline.
    await rec.caption("New balance? Click <b>Update</b>, type it, press Enter");
    await rec.click(row("Chase Checking").locator("button:has-text('Update')"), { ms: 700, after: 200 });
    await page.keyboard.type("1950", { delay: 110 });
    await sleep(300);
    await press(rec, "Enter", 200);
    await row("Chase Checking").getByText("$1,950").waitFor({ timeout: 20_000 });
    await sleep(1100);

    // 4. An account's history.
    await rec.caption("Every account keeps its <b>history</b>, snapshot by snapshot");
    await rec.click(row("Livret A").locator("a:text-is('Livret A')"), { ms: 700, after: 200 });
    await page.getByText("Balance over time").waitFor({ timeout: 20_000 });
    await sleep(300);
    await scrollTo(rec, "text=Balance over time", { top: 70, ms: 800 });
    const chart = page.locator(".recharts-surface").first();
    await sweep(rec, chart, [0.3, 0.9], { y: 0.45, ms: 600, hold: 200 });
    await sleep(900);

    // 5. Shared flat and its mortgage.
    await rec.click("aside a[href='/accounts']", { ms: 650, after: 200 });
    await page.getByText("Cash & savings").waitFor();
    await rec.caption("A flat bought as a couple? Count <b>your share</b>");
    await scrollTo(rec, row("Apartment Lyon 7e"), { top: 230, ms: 1100 });
    await rec.move(row("Apartment Lyon 7e").getByText("50%", { exact: true }), 800);
    await sleep(500);
    await rec.move(row("Apartment Lyon 7e").locator(".tabular").first(), 550);
    await sleep(1100);

    await rec.caption("Mortgages <b>amortize on their own</b> from the loan terms");
    await rec.move(row("Mortgage Lyon 7e").getByText("auto · amortizing"), 700);
    await sleep(600);
    await rec.click(row("Mortgage Lyon 7e").locator("a:text-is('Mortgage Lyon 7e')"), { ms: 600, after: 200 });
    await page.getByText("Payments made").waitFor({ timeout: 20_000 });
    await sleep(300);
    await rec.move("text=Payments made", 700);
    await sleep(750);
    await scrollTo(rec, "text=Amount owed over time", { top: 150, ms: 900 });
    const owed = page.locator(".recharts-surface").first();
    await sweep(rec, owed, [0.3, 0.8], { y: 0.4, ms: 650, hold: 150 });
    await sleep(1300);
    await rec.caption("");
    await sleep(400);
  });
} finally {
  await server.stop();
}
