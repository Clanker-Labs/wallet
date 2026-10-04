// Simulations: mortgage (price, down payment, rate → payment & cost table), buy vs rent, net-worth projection.
import { record, startServer } from "../lib.mjs";
import { bringTo, click, glideTo, hover, typeText, wheel } from "../helpers-ai.mjs";

const server = await startServer({ name: "simulations", port: Number(process.env.PORT ?? 3312) });

/** Sweep the cursor across a chart so its tooltip follows. */
async function sweep(rec, chart, stops, y = 0.5, ms = 520) {
  const box = await chart.boundingBox();
  for (const k of stops) await glideTo(rec, box.x + box.width * k, box.y + box.height * y, ms);
}

try {
  await record("simulations", async (rec) => {
    const { page } = rec;
    const field = (label) => page.getByLabel(label, { exact: true });
    await rec.goto(server.loginUrl(), { waitFor: "text=Net worth" });
    await rec.goto(server.url + "/simulations?tab=mortgage", { waitFor: "text=Debt-to-income" });
    await rec.start();

    // Mortgage: every input updates the payment and the cost table live.
    await rec.caption("Can you afford it? The payment updates <b>as you type</b>", 700);
    await typeText(rec, field("Price"), "340000", { ms: 900 });
    await rec.pause(500);
    await click(rec, page.getByRole("button", { name: "20%", exact: true }).first(), { ms: 600, after: 500 });
    await typeText(rec, field("Interest rate"), "3.1", { ms: 450 });
    await rec.pause(500);
    await hover(rec, page.getByText("Monthly payment", { exact: true }).first(), 600);
    rec.poster();
    await rec.pause(1300);
    await hover(rec, "text=Debt-to-income", 600);
    await rec.pause(900);
    await rec.caption("Fees, total cost and how much you can borrow");
    await wheel(rec, 330, 800);
    await hover(rec, "text=Total project", 700);
    await rec.pause(1500);

    // Buy vs rent.
    await wheel(rec, -600, 600);
    await click(rec, page.getByRole("tab", { name: "Buy vs rent" }), { ms: 700, after: 600 });
    await rec.caption("Buy or rent? See who's <b>richer</b>, year by year");
    await typeText(rec, field("Rent for the same home"), "1650", { ms: 600 });
    await rec.pause(500);
    const rentChart = page.locator(".recharts-surface").first();
    await bringTo(rec, page.getByText("Net worth: buyer vs renter"), 150);
    await sweep(rec, rentChart, [0.2, 0.45, 0.7, 0.95]);
    await rec.pause(900);

    // Net-worth projection with its Monte Carlo band.
    await wheel(rec, -600, 500);
    await click(rec, page.getByRole("tab", { name: "Projection" }), { ms: 700, after: 700 });
    await rec.caption("Project your net worth with a <b>Monte Carlo</b> band");
    await click(rec, page.getByRole("button", { name: "30", exact: true }).first(), { ms: 700, after: 600 });
    const projChart = page.locator(".recharts-surface").last();
    await bringTo(rec, projChart, 190);
    await sweep(rec, projChart, [0.25, 0.5, 0.75, 0.97], 0.45, 600);
    await rec.pause(1200);
    await rec.caption("Your financial independence date, and its odds");
    await bringTo(rec, page.getByText("Financial independence", { exact: true }), 160, 700);
    await hover(rec, page.getByText("Financial independence", { exact: true }), 600);
    await rec.pause(2200);
    await rec.caption("");
    await rec.pause(500);
  });
} finally {
  await server.stop();
}
