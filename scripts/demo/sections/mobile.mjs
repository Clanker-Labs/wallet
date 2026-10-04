// Mobile: a phone-sized tour (iPhone viewport) for the promo: dashboard, menu, investments, assistant.
import { record, startServer } from "../lib.mjs";
import { click, wheel } from "../helpers-ai.mjs";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

// Phone-sized overlays: a fingertip instead of an arrow, and captions that use the full width.
const PHONE_OVERLAY = `(() => {
  const css = document.createElement("style");
  css.textContent = \`
    html #__demo-cursor svg { display: none; }
    html #__demo-cursor::after { content: ""; display: block; width: 34px; height: 34px; border-radius: 50%;
      background: rgba(17, 24, 39, .16); border: 2px solid rgba(255, 255, 255, .9); box-shadow: 0 2px 10px rgba(0, 0, 0, .22);
      transform: translate(-12px, -14px); }
    html #__demo-caption { width: max-content; max-width: 88vw; font-size: 16px; padding: 11px 16px; border-radius: 14px; bottom: 26px; }
  \`;
  const add = () => document.documentElement.append(css);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add, { once: true });
  else add();
})();`;

const server = await startServer({
  name: "mobile",
  port: Number(process.env.PORT ?? 3316),
  env: { WALLET_AGENT_PROVIDER: "claude-code" },
});

try {
  await record(
    "mobile",
    async (rec) => {
      const { page } = rec;
      await rec.context.addInitScript(PHONE_OVERLAY);
      const navLink = (name) => page.locator(`a:visible:has-text("${name}")`).first();
      await rec.goto(server.loginUrl(), { waitFor: "main" });
      await rec.goto(server.url + "/", { waitFor: "text=Allocation" });
      await page.mouse.move(300, 560);
      await rec.start();

      // Dashboard hero and history chart, then the allocation.
      await rec.caption("Your whole net worth, <b>in your pocket</b>");
      rec.poster();
      await rec.pause(1900);
      await wheel(rec, 520, 1100);
      await rec.pause(1000);

      // Menu → Investments.
      await rec.caption("");
      await click(rec, page.getByRole("button", { name: "Menu" }), { ms: 650, after: 550 });
      await click(rec, navLink("Investments"), { ms: 550, after: 250 });
      await page.waitForURL(/\/investments/);
      await page.locator("main").getByText("Investments").first().waitFor();
      await rec.caption("Every holding, priced daily");
      await rec.pause(1100);
      await wheel(rec, 420, 900);
      await rec.pause(1000);

      // Menu → Assistant.
      await rec.caption("");
      await click(rec, page.getByRole("button", { name: "Menu" }), { ms: 650, after: 550 });
      await click(rec, navLink("Assistant"), { ms: 550, after: 250 });
      await page.waitForURL(/\/assistant/);
      await page.getByText("Or ask anything about your money").waitFor();
      await rec.caption("Ask the assistant, <b>anywhere</b>");
      await rec.pause(1500);
      await rec.caption("");
      await click(rec, page.locator('textarea[aria-label="Message the assistant"]'), { ms: 650, after: 150 });
      await page.keyboard.type("How much did I spend on travel this year?", { delay: 38 });
      await rec.pause(1300);
    },
    { viewport: { width: 390, height: 844 }, scale: 2.5, isMobile: true, hasTouch: true, userAgent: IPHONE_UA },
  );
} finally {
  await server.stop();
}
