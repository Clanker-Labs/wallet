// Net worth dashboard: hero, history chart, allocation, nudges.
import { record, startServer } from "../lib.mjs";

const server = await startServer({ name: "net-worth", port: Number(process.env.PORT ?? 3321) });
try {
  await record("net-worth", async (rec) => {
    await rec.goto(server.loginUrl(), { waitFor: "text=Net worth" });
    await rec.goto(server.url + "/", { waitFor: "text=Allocation" });
    await rec.start();
    await rec.caption("Your <b>net worth</b>, every account, one currency", 1600);
    await rec.move("text=1 year", 900);
    await rec.pause(500);
    // Sweep the history chart so the tooltip follows the cursor.
    const chart = rec.page.locator(".recharts-surface").first();
    const box = await chart.boundingBox();
    await rec.moveTo(box.x + box.width * 0.15, box.y + box.height * 0.6, 700);
    await rec.caption("Monthly history from balance snapshots, loans that amortize on their own");
    for (const k of [0.3, 0.5, 0.7, 0.92]) await rec.moveTo(box.x + box.width * k, box.y + box.height * 0.55, 650);
    rec.poster();
    await rec.pause(700);
    await rec.caption("Allocation by asset class: cash, stocks, retirement, property, crypto, <b>gold</b>…");
    await rec.scroll(380);
    await rec.move("text=Commodities", 800);
    await rec.pause(900);
    await rec.move(".recharts-pie", 700);
    await rec.pause(1100);
    await rec.caption("Anything stale or uncategorized shows up here");
    await rec.move("text=Needs attention", 700);
    await rec.pause(1200);
    await rec.scroll(520);
    await rec.caption("Budgets and cash flow at a glance");
    await rec.pause(2200);
    await rec.caption("");
  });
} finally {
  await server.stop();
}
