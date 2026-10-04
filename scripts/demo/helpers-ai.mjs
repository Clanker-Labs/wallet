/**
 * Helpers for the AI / integrations clips (assistant, telegram, mcp, settings,
 * simulations, mobile): a sample bank statement PDF, a fake drag-and-drop of a
 * file from "outside" the browser, and serving the replay pages.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadPlaywright, sleep } from "./lib.mjs";

export const REPLAY = path.join(ROOT, "scripts/demo/replay");

const chromiumPath = () =>
  process.env.CHROMIUM_PATH ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

// ── Sample statement ─────────────────────────────────────────────────────

/** Alex's USD checking account in September 2026: a week in New York. Amounts in dollars. */
export const STATEMENT_ROWS = [
  ["09/01", "Online transfer from WISE EUROPE SA ref 88213", 1000.0],
  ["09/02", "TRADER JOE'S #540 NEW YORK NY", -64.18],
  ["09/03", "MTA*NYCT PAYGO NEW YORK NY", -34.0],
  ["09/04", "GITHUB INC", -4.0],
  ["09/05", "JOE'S PIZZA BROADWAY NEW YORK NY", -11.5],
  ["09/06", "UBER *TRIP HELP.UBER.COM", -23.47],
  ["09/07", "BLUE BOTTLE COFFEE BROOKLYN NY", -6.75],
  ["09/08", "WHOLE FOODS MARKET #10233 NEW YORK", -87.62],
  ["09/10", "SHAKE SHACK MADISON SQ NEW YORK", -18.94],
  ["09/11", "AMAZON.COM*RT4KX9 AMZN.COM/BILL WA", -42.99],
  ["09/12", "THE METROPOLITAN MUSEUM OF ART", -30.0],
  ["09/14", "CVS/PHARMACY #02931 NEW YORK NY", -16.48],
  ["09/15", "Zelle payment from JORDAN MILLER", 45.0],
  ["09/16", "SWEETGREEN NOMAD NEW YORK NY", -15.85],
  ["09/19", "UBER EATS PENDING SAN FRANCISCO CA", -31.2],
  ["09/20", "AMC THEATRES 34TH ST NEW YORK NY", -19.99],
  ["09/22", "TRADER JOE'S #540 NEW YORK NY", -48.31],
  ["09/24", "APPLE.COM/BILL 866-712-7753 CA", -2.99],
  ["09/25", "ATM WITHDRAWAL 1440 BROADWAY NEW YORK", -60.0],
  ["09/27", "LYFT *RIDE SAT 2PM", -27.4],
  ["09/29", "DELTA AIR LINES BAG FEE JFK", -35.0],
];
export const STATEMENT_OPENING = 1912.4;

const usd = (n) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A plain, bank-like statement (demo data, no real logo). */
export function statementHtml() {
  let balance = STATEMENT_OPENING;
  const deposits = STATEMENT_ROWS.filter((r) => r[2] > 0).reduce((s, r) => s + r[2], 0);
  const withdrawals = STATEMENT_ROWS.filter((r) => r[2] < 0).reduce((s, r) => s + r[2], 0);
  const rows = STATEMENT_ROWS.map(([d, desc, amt]) => {
    balance = Math.round((balance + amt) * 100) / 100;
    return `<tr><td>${d}</td><td>${escapeHtml(desc)}</td><td class="n">${usd(amt)}</td><td class="n">${usd(balance)}</td></tr>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 0.55in 0.6in; }
    body { font: 10.5px/1.45 Helvetica, Arial, sans-serif; color: #1d2733; }
    .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0b4ea2; padding-bottom: 10px; }
    .bank { font: 800 24px/1 Helvetica, Arial, sans-serif; letter-spacing: .08em; color: #0b4ea2; }
    .bank small { display: block; font-size: 10px; letter-spacing: 0; font-weight: 500; color: #5a6878; margin-top: 4px; }
    .period { text-align: right; font-size: 10.5px; color: #33404d; }
    .period b { font-size: 13px; color: #1d2733; }
    .addr { margin: 14px 0 12px; display: flex; justify-content: space-between; }
    .addr div { font-size: 10.5px; }
    h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #0b4ea2; margin: 16px 0 6px; }
    .summary { width: 52%; border-collapse: collapse; }
    .summary td { padding: 3px 6px; border-bottom: 1px solid #e3e8ee; }
    .summary tr:last-child td { font-weight: 700; border-bottom: 2px solid #1d2733; }
    table.tx { width: 100%; border-collapse: collapse; }
    table.tx th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em; color: #5a6878; border-bottom: 1.5px solid #1d2733; padding: 4px 6px; }
    table.tx td { padding: 4.5px 6px; border-bottom: 1px solid #e9edf2; }
    table.tx tr:nth-child(even) td { background: #f7f9fb; }
    .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    th.n { text-align: right; }
    .foot { margin-top: 18px; font-size: 8.5px; color: #7a8796; }
  </style></head><body>
    <div class="top">
      <div class="bank">CHASE<small>Total Checking® statement</small></div>
      <div class="period"><b>September 1, 2026 – September 30, 2026</b><br>Account number: ••••••••4821<br>Page 1 of 1</div>
    </div>
    <div class="addr">
      <div>ALEX MARTIN<br>12 RUE DE MARSEILLE<br>69007 LYON FRANCE</div>
      <div style="text-align:right">Customer service: 1-800-935-9935<br>International: 1-713-262-1679</div>
    </div>
    <h2>Checking summary</h2>
    <table class="summary">
      <tr><td>Beginning balance</td><td class="n">${usd(STATEMENT_OPENING)}</td></tr>
      <tr><td>Deposits and additions</td><td class="n">${usd(deposits)}</td></tr>
      <tr><td>Electronic withdrawals &amp; card purchases</td><td class="n">${usd(withdrawals)}</td></tr>
      <tr><td>Ending balance</td><td class="n">${usd(balance)}</td></tr>
    </table>
    <h2>Transaction detail</h2>
    <table class="tx">
      <thead><tr><th>Date</th><th>Description</th><th class="n">Amount</th><th class="n">Balance</th></tr></thead>
      <tbody><tr><td></td><td><i>Beginning balance</i></td><td></td><td class="n">${usd(STATEMENT_OPENING)}</td></tr>${rows}</tbody>
    </table>
    <p class="foot">Sample statement generated for the Wallet demo. Not a real account.</p>
  </body></html>`;
}

export const statementClosing = () =>
  Math.round(STATEMENT_ROWS.reduce((b, r) => b + r[2], STATEMENT_OPENING) * 100) / 100;

/** Render HTML to a PDF file with headless Chromium. */
export async function htmlToPdf(html, out) {
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ executablePath: chromiumPath() });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.pdf({ path: out, format: "Letter", printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
  return out;
}

// ── Fake drag & drop of a file from the desktop ──────────────────────────

const DRAG_SCRIPT = String.raw`(({ b64, name, mime, size }) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const file = new File([bytes], name, { type: mime });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ext = (name.split(".").pop() || "").toUpperCase();
  const ghost = document.createElement("div");
  ghost.id = "__demo-drag";
  ghost.innerHTML =
    '<div style="position:relative;width:54px;height:68px;border-radius:7px;background:#fff;box-shadow:0 8px 24px rgba(15,23,42,.28),inset 0 0 0 1px rgba(15,23,42,.12);margin:0 auto;overflow:hidden">' +
      '<div style="position:absolute;right:0;top:0;width:16px;height:16px;background:linear-gradient(225deg,#e8ecf2 50%,#cfd6df 50%)"></div>' +
      '<div style="position:absolute;left:8px;right:8px;top:24px;height:3px;border-radius:2px;background:#d7dde5;box-shadow:0 7px 0 #d7dde5,0 14px 0 #d7dde5"></div>' +
      '<div style="position:absolute;left:6px;bottom:6px;padding:2px 5px;border-radius:4px;background:#e5484d;color:#fff;font:700 10px/1.1 Inter Demo,system-ui,sans-serif">' + ext + '</div>' +
    '</div>' +
    '<div style="margin-top:7px;padding:3px 8px;border-radius:6px;background:rgba(91,79,233,.92);color:#fff;font:600 12px/1.3 Inter Demo,system-ui,sans-serif;white-space:nowrap">' + name + '</div>';
  ghost.style.cssText = "position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;text-align:center;opacity:.95;transform:translate(-200px,-200px) rotate(-4deg);transition:opacity .2s";
  document.documentElement.appendChild(ghost);
  let x = -200, y = -200, entered = false, timer = null;
  const at = () => document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, x)), Math.max(0, Math.min(innerHeight - 1, y))) || document.body;
  const fire = (type) => at().dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y }));
  const onMove = (e) => {
    x = e.clientX; y = e.clientY;
    ghost.style.transform = "translate(" + (x - 40) + "px," + (y + 6) + "px) rotate(-4deg)";
    if (x >= 0 && x < innerWidth && y >= 0 && y < innerHeight) {
      if (!entered) { entered = true; fire("dragenter"); timer = setInterval(() => fire("dragover"), 250); }
      fire("dragover");
    }
  };
  addEventListener("mousemove", onMove, true);
  // Time-based glide in the page: stays on schedule even when the blurred overlay renders slowly.
  window.__demoDragTo = (tx, ty, ms) =>
    new Promise((done) => {
      const sx = x < -100 ? tx : x, sy = y < -100 ? ty : y;
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / ms);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        dispatchEvent(new MouseEvent("mousemove", { clientX: sx + (tx - sx) * e, clientY: sy + (ty - sy) * e, bubbles: true }));
        if (k < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
  window.__demoDrop = () => {
    removeEventListener("mousemove", onMove, true);
    clearInterval(timer);
    ghost.style.opacity = "0";
    setTimeout(() => ghost.remove(), 250);
    const r = document.createElement("div");
    r.className = "__demo-ripple";
    r.style.left = x + "px";
    r.style.top = y + "px";
    document.documentElement.appendChild(r);
    setTimeout(() => r.remove(), 600);
    fire("drop");
  };
})`;

/**
 * Drag `file` in from the right edge of the window along with the cursor and
 * drop it at `to` ({x, y} in CSS px). The app sees real dragenter/dragover/drop
 * events carrying a File, exactly like a drop from Finder.
 */
export async function dragFileIn(rec, { file, name = path.basename(file), mime, from, to, ms = 1600, hover = 900 }) {
  const { page } = rec;
  const b64 = fs.readFileSync(file).toString("base64");
  await page.evaluate(`(${DRAG_SCRIPT})(${JSON.stringify({ b64, name, mime, size: fs.statSync(file).size })})`);
  const start = from ?? { x: rec.viewport.width - 4, y: rec.viewport.height * 0.78 };
  await page.evaluate(({ x, y }) => dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true })), start);
  await page.evaluate(({ x, y, ms }) => window.__demoDragTo(x, y, ms), { ...to, ms });
  await sleep(hover);
  // No real mouse press: a click would hit whatever is under the cursor.
  await page.evaluate(() => window.__demoDrop());
}

// ── Time-based cursor moves ──────────────────────────────────────────────
// lib.mjs glides in fixed steps, so a busy machine stretches every move; these
// keep to the requested duration whatever each step costs.

const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

async function cursorAt(page, viewport) {
  const s = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__demo") || '{"x":-40,"y":-40}'));
  return s.x < 0 ? { x: viewport.width * 0.55, y: viewport.height * 0.6 } : { x: s.x, y: s.y };
}

export async function glideTo(rec, x, y, ms = 650) {
  const from = await cursorAt(rec.page, rec.viewport);
  const t0 = Date.now();
  for (;;) {
    const k = Math.min(1, (Date.now() - t0) / ms);
    const e = ease(k);
    await rec.page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    if (k >= 1) break;
    await sleep(12);
  }
}

async function center(rec, sel) {
  const loc = typeof sel === "string" ? rec.page.locator(sel).first() : sel;
  await loc.waitFor({ state: "visible", timeout: 20_000 });
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  return { loc, x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export async function hover(rec, sel, ms = 650) {
  const t = await center(rec, sel);
  await glideTo(rec, t.x, t.y, ms);
  return t.loc;
}

export async function click(rec, sel, { ms = 650, after = 400 } = {}) {
  const t = await center(rec, sel);
  await glideTo(rec, t.x, t.y, ms);
  await sleep(100);
  await rec.page.mouse.down();
  await sleep(60);
  await rec.page.mouse.up();
  await sleep(after);
  return t.loc;
}

/** Wheel-scroll by dy over ~ms, on schedule. */
export async function wheel(rec, dy, ms = 700) {
  const t0 = Date.now();
  let done = 0;
  for (;;) {
    const k = Math.min(1, (Date.now() - t0) / ms);
    const target = dy * (1 - Math.pow(1 - k, 2));
    if (target !== done) await rec.page.mouse.wheel(0, target - done);
    done = target;
    if (k >= 1) break;
    await sleep(16);
  }
  await sleep(120);
}

/** Wheel the page so `loc` sits about `top` px below the viewport's top. */
export async function bringTo(rec, loc, top = 120, ms = 700) {
  const target = typeof loc === "string" ? rec.page.locator(loc).first() : loc;
  await target.waitFor({ state: "attached", timeout: 20_000 });
  const box = await target.boundingBox();
  if (box && Math.abs(box.y - top) > 20) await wheel(rec, box.y - top, ms);
}

/** Type into a field like a person, on schedule (`ms` for the whole text). */
export async function typeText(rec, sel, text, { ms = text.length * 45, clear = true } = {}) {
  const loc = await click(rec, sel, { after: 120 });
  if (clear) await loc.fill("");
  const per = ms / Math.max(1, text.length);
  const t0 = Date.now();
  for (let i = 0; i < text.length; i++) {
    await rec.page.keyboard.type(text[i]);
    const wait = t0 + per * (i + 1) - Date.now();
    if (wait > 0) await sleep(wait);
  }
  await sleep(200);
  return loc;
}

// ── Replay pages (served from disk through Playwright routing) ───────────

export const REPLAY_ORIGIN = "http://replay.demo";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

/** Serve scripts/demo/replay/* at http://replay.demo/ (and the Inter font at /__demo/). */
export async function serveReplay(rec) {
  await rec.context.route(`${REPLAY_ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/__demo/")) return route.fallback();
    const file = path.join(REPLAY, decodeURIComponent(url.pathname));
    if (!file.startsWith(REPLAY) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    route.fulfill({ path: file, contentType: TYPES[path.extname(file)] ?? "application/octet-stream" });
  });
}

