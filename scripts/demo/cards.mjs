/**
 * Branded title cards rendered in Chromium and recorded like any clip:
 * dark navy with brand glows, the logo, a kicker, a title and a subtitle.
 * Optional `slot` reserves a framed area (e.g. a phone) that ffmpeg fills later.
 */
import fs from "node:fs";
import path from "node:path";
import { ASSETS, record, sleep } from "./lib.mjs";

const LOGO = fs.readFileSync(path.join(ASSETS, "logo.svg"), "utf8");

function esc(s = "") {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** HTML for one card. `title` may contain <em> (gold) and <br>. */
export function cardHtml({ kicker = "", title = "", subtitle = "", footer = "", layout = "center", slot = null, logo = true, big = false }) {
  const slotHtml = slot
    ? `<div class="slot" style="left:${slot.x}px;top:${slot.y}px;width:${slot.w}px;height:${slot.h}px;border-radius:${slot.r ?? 44}px"></div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: Inter; src: url("/__demo/inter-latin.woff2") format("woff2"); font-weight: 100 900; }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1280px; height: 720px; overflow: hidden; }
  body { font-family: Inter, system-ui, sans-serif; color: #f1f4fa; letter-spacing: -0.02em;
    background:
      radial-gradient(60% 70% at 12% 8%, rgba(124,114,255,.42) 0%, transparent 60%),
      radial-gradient(50% 60% at 95% 100%, rgba(164,123,255,.30) 0%, transparent 65%),
      radial-gradient(35% 35% at 80% 10%, rgba(245,196,81,.10) 0%, transparent 70%),
      #070b14; }
  body::before { content: ""; position: absolute; inset: 0; opacity: .5;
    background-image: linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);
    background-size: 48px 48px; mask-image: radial-gradient(80% 80% at 50% 40%, #000 30%, transparent 85%); }
  .wrap { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; padding: 0 96px;
    align-items: ${layout === "center" ? "center" : "flex-start"}; text-align: ${layout === "center" ? "center" : "left"}; }
  .wrap.left { width: 700px; }
  .brand { display: flex; align-items: center; gap: 14px; margin-bottom: ${big ? 30 : 26}px; }
  .brand svg { width: ${big ? 76 : 44}px; height: ${big ? 76 : 44}px; filter: drop-shadow(0 10px 30px rgba(91,79,233,.55)); }
  .brand span { font-weight: 700; font-size: ${big ? 54 : 30}px; letter-spacing: -0.03em; }
  .kicker { font-size: 15px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: #f5c451; margin-bottom: 16px; }
  h1 { font-size: ${big ? 68 : 58}px; line-height: 1.04; font-weight: 750; letter-spacing: -0.035em; }
  h1 em { font-style: normal; background: linear-gradient(90deg, #a29bff, #f5c451); -webkit-background-clip: text; background-clip: text; color: transparent; }
  p { margin-top: 20px; font-size: 22px; line-height: 1.45; color: #b2bacb; max-width: 760px; }
  .footer { margin-top: 34px; font: 600 17px/1 ui-monospace, "DejaVu Sans Mono", monospace; color: #d7dcf0;
    padding: 12px 18px; border-radius: 12px; background: rgba(255,255,255,.06); box-shadow: inset 0 0 0 1px rgba(255,255,255,.1); }
  .slot { position: absolute; background: #000; box-shadow: 0 0 0 10px #1c2436, 0 0 0 11px rgba(255,255,255,.12), 0 30px 80px rgba(0,0,0,.55); }
  .in { opacity: 0; transform: translateY(18px); animation: in .7s cubic-bezier(.2,.7,.2,1) forwards; }
  .brand.in { transform: scale(.9); }
  @keyframes in { to { opacity: 1; transform: none; } }
  </style></head><body>${slotHtml}
  <div class="wrap ${layout === "left" ? "left" : ""}">
    ${logo ? `<div class="brand in" style="animation-delay:.05s">${LOGO}<span>wallet</span></div>` : ""}
    ${kicker ? `<div class="kicker in" style="animation-delay:.18s">${esc(kicker)}</div>` : ""}
    ${title ? `<h1 class="in" style="animation-delay:.28s">${title}</h1>` : ""}
    ${subtitle ? `<p class="in" style="animation-delay:.45s">${subtitle}</p>` : ""}
    ${footer ? `<div class="footer in" style="animation-delay:.6s">${esc(footer)}</div>` : ""}
  </div></body></html>`;
}

/** Record a card for `seconds` into `out` (1920×1080 mp4). */
export async function titleCard(out, opts, seconds = 3) {
  const html = cardHtml(opts);
  return record(
    path.basename(out, ".mp4"),
    async (rec) => {
      await rec.context.route("http://cards.local/**", (route) =>
        route.request().url().endsWith(".woff2") ? route.fallback() : route.fulfill({ body: html, contentType: "text/html" }),
      );
      await rec.page.goto("http://cards.local/card");
      await rec.page.evaluate(() => document.fonts.ready);
      // Restart the entrance animations once recording runs, so they're captured.
      await rec.page.evaluate(() => document.querySelectorAll(".in").forEach((el) => (el.style.animationPlayState = "paused")));
      await rec.start();
      await rec.page.evaluate(() => {
        document.querySelectorAll(".in").forEach((el) => {
          el.style.animation = "none";
          void el.offsetWidth;
          el.style.animation = "";
          el.style.animationPlayState = "running";
        });
        // Keep frames flowing while the card holds still.
        const tick = document.createElement("div");
        tick.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:.01";
        document.body.appendChild(tick);
        let n = 0;
        setInterval(() => (tick.style.background = n++ % 2 ? "#000" : "#010101"), 1000 / 30);
      });
      await sleep(seconds * 1000);
    },
    { out, holdEnd: 0.05, tailMs: 0 },
  );
}
