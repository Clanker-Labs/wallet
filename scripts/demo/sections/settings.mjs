// Settings: base currency & exchange rates, passkeys (a real WebAuthn ceremony on a
// virtual authenticator), Telegram link code, and the MCP snippet.
import { record, startServer } from "../lib.mjs";
import { bringTo, click, hover, typeText } from "../helpers-ai.mjs";

// The assistant is configured (so Integrations shows it on); nothing here runs it.
const server = await startServer({
  name: "settings",
  port: Number(process.env.PORT ?? 3314),
  env: { WALLET_AGENT_PROVIDER: "claude-code" },
});

try {
  await record("settings", async (rec) => {
    const { page } = rec;
    // A platform authenticator (like Touch ID) that approves on its own.
    const cdp = await rec.context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    await rec.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.url });
    await rec.goto(server.loginUrl(), { waitFor: "text=Net worth" });
    await rec.goto(server.url + "/settings", { waitFor: "text=Exchange rates" });
    await bringTo(rec, page.locator("#preferences"), 24, 10);
    await rec.start();

    // Base currency and exchange rates.
    await rec.caption("Pick a base currency: every total converts to it", 500);
    const currency = page.getByLabel("Base currency");
    await hover(rec, currency, 700);
    await rec.pause(500);
    await currency.selectOption("EUR");
    await rec.pause(1300);
    await currency.selectOption("USD");
    await bringTo(rec, page.locator("#currency"), 24, 800);
    await rec.caption("Daily exchange rates, free and <b>keyless</b>");
    await hover(rec, page.getByText("Latest rates", { exact: true }), 700);
    await rec.pause(900);
    await hover(rec, page.locator("#currency li").first(), 700);
    await rec.pause(1300);

    // Passkeys: add this device, then rename it.
    await bringTo(rec, page.locator("#security"), 24, 900);
    await rec.caption("Passwordless sign-in with <b>passkeys</b>");
    await click(rec, page.getByRole("button", { name: "Add this device" }), { ms: 700, after: 300 });
    await page.getByText("Passkey added").waitFor({ timeout: 20_000 });
    await rec.pause(1200);
    const rename = page.locator('button[aria-label^="Rename"]').first();
    await click(rec, rename, { ms: 700, after: 250 });
    await typeText(rec, page.getByLabel("Passkey name"), "MacBook Pro", { ms: 750 });
    await click(rec, page.getByRole("button", { name: "Save name" }), { ms: 400, after: 300 });
    await page.getByText("MacBook Pro", { exact: true }).waitFor({ timeout: 10_000 });
    await rec.pause(1100);

    // Telegram link code.
    await bringTo(rec, page.locator("#telegram"), 24, 900);
    await rec.caption("Link Telegram with a one-time code");
    await click(rec, page.getByRole("button", { name: "Generate link code" }), { ms: 700, after: 300 });
    await page.getByText("Your code").waitFor({ timeout: 10_000 });
    await hover(rec, page.getByText("Your code").locator(".."), 600);
    await rec.pause(1500);

    // Integrations: the MCP snippet.
    await bringTo(rec, page.locator("#integrations"), 24, 1000);
    await rec.caption("Connect Claude Code over <b>MCP</b> in one line");
    await hover(rec, page.getByText("No token needed on localhost"), 700);
    await rec.pause(900);
    const snippet = page.getByText("Claude Code (local MCP over stdio)", { exact: true }).locator("..");
    await hover(rec, snippet.locator("pre"), 700);
    rec.poster();
    await rec.pause(900);
    await click(rec, snippet.getByRole("button"), { ms: 600, after: 1300 });
    await rec.caption("");
    await rec.pause(400);
  });
} finally {
  await server.stop();
}
