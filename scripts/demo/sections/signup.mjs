// Fresh install: create the owner account with a passkey, then a first account.
import { record, sleep, startServer } from "../lib.mjs";
import { markPoster, tune } from "../helpers-core.mjs";

const server = await startServer({ name: "signup", port: Number(process.env.PORT ?? 3302), empty: true });
try {
  await record("signup", async (r) => {
    const rec = tune(r);
    // A platform authenticator that says yes (Touch ID / Windows Hello stand-in).
    const cdp = await rec.context.newCDPSession(rec.page);
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

    await rec.goto(server.url + "/", { waitFor: "text=Set up your wallet" });
    await rec.page.locator("input[autocomplete=name]").blur();
    await rec.start();
    await rec.caption("A fresh install: <b>you</b> are the owner", 1900);

    await rec.caption("No passwords: <b>Face ID</b> on your iPhone, via a QR code");
    const phone = await rec.page.locator("button:has-text('Save it on my iPhone')").boundingBox();
    await rec.moveTo(phone.x + phone.width * 0.86, phone.y + phone.height * 0.62, 900);
    await sleep(500);
    await markPoster(rec);
    await sleep(1800);

    await rec.caption("Or a passkey on this computer: Touch ID, Windows Hello");
    await rec.type("input[autocomplete=name]", "Alex", { delay: 110 });
    await sleep(300);
    await rec.click("button:has-text('Create my passkey')", { after: 300 });
    await rec.page.getByText("Welcome to Wallet").waitFor({ timeout: 20_000 });
    await rec.caption("");
    await sleep(500);

    await rec.caption("Your data stays in one <b>SQLite file</b> on your machine");
    await rec.move("text=Welcome to Wallet", 800);
    await sleep(2300);

    await rec.caption("Add accounts with today's balance, in any currency");
    await rec.click("a:has-text('Add your first account')", { after: 300 });
    await rec.page.locator("input[name=name]").waitFor();
    await sleep(400);
    await rec.type("input[name=name]", "Chase Checking", { delay: 60 });
    await rec.type("input[name=institution]", "Chase", { delay: 70 });
    await rec.type("input[name=balance]", "2400", { delay: 100 });
    await sleep(300);
    await rec.click("button[type=submit]:has-text('Add account')", { after: 300 });
    await rec.page.locator("li a:has-text('Chase Checking')").waitFor({ timeout: 20_000 });
    await sleep(600);

    await rec.caption("Your <b>net worth</b> starts here");
    await rec.move("li a:has-text('Chase Checking')", 800);
    await sleep(1000);
    await rec.move("text=Net worth · USD", 800);
    await sleep(2800);
    await rec.caption("");
    await sleep(400);
  });
} finally {
  await server.stop();
}
