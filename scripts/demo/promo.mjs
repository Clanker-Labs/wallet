// The ~45 s promo: kinetic title cards cut with the best moments of each section clip,
// plus the README GIF. Excerpt timings refer to the section clips in site/media.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { titleCard } from "./cards.mjs";
import { excerpt, gif, phoneComposite } from "./cut.mjs";
import { joinClips, MEDIA } from "./lib.mjs";

const media = (name) => path.join(MEDIA, `${name}.mp4`);

// [clip, start (s), output seconds, speed]
const SHOTS = {
  netWorth: ["net-worth", 1.0, 5.5, 1.25],
  accounts: ["accounts", 2.0, 4.5, 1.3],
  investments: ["investments", 1.0, 4.5, 1.3],
  assistant: ["assistant", 1.0, 9.0, 1.6],
  simulations: ["simulations", 2.0, 4.5, 1.4],
  telegram: ["telegram", 9.0, 5.0, 1.4],
  mcp: ["mcp", 2.0, 5.0, 1.5],
  signup: ["signup", 2.0, 4.0, 1.3],
};
const PHONE_SLOT = { x: 1230, y: 60, w: 450, h: 960, r: 60 }; // device px, matches the card's CSS slot ×1.5

export async function buildPromo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-promo-"));
  const at = (f) => path.join(tmp, f);
  const shot = (key) => {
    const [clip, start, dur, speed] = SHOTS[key];
    return fs.existsSync(media(clip)) ? excerpt(media(clip), start, dur, at(`${key}.mp4`), { speed }) : null;
  };
  const card = (file, opts, s) => titleCard(at(file), { logo: false, ...opts }, s);

  const parts = [
    await titleCard(at("open.mp4"), { big: true, title: "Your money,<br><em>on your machine.</em>" }, 3.2),
    await card("c-networth.mp4", { kicker: "Net worth", title: "Everything you own. <em>One number.</em>" }, 2.0),
    shot("netWorth"),
    await card("c-currency.mp4", { kicker: "Accounts", title: "Every account. <em>Any currency.</em>", subtitle: "Converted daily with free exchange rates." }, 2.2),
    shot("accounts"),
    shot("investments"),
    await card("c-assistant.mp4", { kicker: "Assistant", title: "Drop a statement.<br><em>It's imported.</em>", subtitle: "CSV, PDF or a screenshot. Claude does the typing." }, 2.6),
    shot("assistant"),
    await card("c-sims.mp4", { kicker: "Simulations", title: "Can I afford <em>that apartment?</em>" }, 2.0),
    shot("simulations"),
    await card("c-telegram.mp4", { kicker: "Reminders", title: "Nagged until <em>it's done.</em>", subtitle: "Telegram reminders that re-send until you tap ✅." }, 2.2),
    shot("telegram"),
    await card("c-mcp.mp4", { kicker: "MCP & API", title: "Works with <em>your agents.</em>", subtitle: "Claude Code, Codex, Claude Desktop, or plain HTTP." }, 2.2),
    shot("mcp"),
    await card("c-passkeys.mp4", { kicker: "Passkeys", title: "No passwords. <em>Face ID.</em>", subtitle: "Scan a QR code with your iPhone and you're in." }, 2.2),
    shot("signup"),
  ];
  if (fs.existsSync(media("mobile"))) {
    const phoneCard = await card(
      "c-phone.mp4",
      { layout: "left", kicker: "Mobile", title: "In your <em>pocket</em> too.", subtitle: "An installable web app, built for 390 px first.", slot: { x: 820, y: 40, w: 300, h: 640, r: 40 } },
      5.0,
    );
    parts.push(phoneComposite(phoneCard, media("mobile"), at("phone.mp4"), PHONE_SLOT, { start: 0.5, speed: 1.4 }));
  }
  parts.push(
    await titleCard(at("end.mp4"), {
      big: true,
      title: "Self-hosted. <em>Private. Yours.</em>",
      subtitle: "Open source · MIT · github.com/Clanker-Labs/wallet",
      footer: "npm install && npm run dev",
    }, 4.2),
  );

  const out = media("promo");
  joinClips(parts.filter(Boolean), out, { fade: 0.35 });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "2.4", "-i", out, "-frames:v", "1", "-q:v", "3", out.replace(/\.mp4$/, ".jpg")]);
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

/** README hero: the opening card, net worth and the assistant, as a light GIF. */
export function buildGif() {
  return gif(media("promo"), path.join(MEDIA, "promo.gif"), { start: 0, dur: 24, width: 880, fps: 10 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildPromo();
  buildGif();
}
