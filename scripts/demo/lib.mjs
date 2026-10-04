/**
 * Recording toolkit for the demo videos (site/media/*.mp4).
 *
 * - Runs the production build (`next start`) on its own SQLite copy per clip.
 * - Captures Chromium's screencast (CDP) frame by frame and encodes H.264
 *   with ffmpeg, so idle moments cost nothing and waits can be fast-forwarded.
 * - Draws a visible cursor, click ripples, captions and a "fast-forward"
 *   badge inside the page (init scripts survive navigations).
 *
 * Needs: `npm run build` first, ffmpeg on the PATH, and Playwright + Chromium
 * (PLAYWRIGHT_MODULE / CHROMIUM_PATH override where they live).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const MEDIA = path.join(ROOT, "site/media");
export const ASSETS = path.join(ROOT, "site/assets");
const DATA = path.join(ROOT, "data");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const NEXT = path.join(ROOT, "node_modules/next/dist/bin/next");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const id of [process.env.PLAYWRIGHT_MODULE, "playwright", "/opt/node-tools/node_modules/playwright"]) {
    if (!id) continue;
    try {
      return require(id);
    } catch {}
  }
  throw new Error("Playwright not found: npm i -D playwright (or set PLAYWRIGHT_MODULE)");
}

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
}

// ── Databases & servers ──────────────────────────────────────────────────

const BASE_DB = path.join(DATA, "rec-base.db");

function rmDb(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
}

/** Seed the demo user once per day; clips copy it so each starts from the same state. */
export function baseDb() {
  const stamp = new Date().toISOString().slice(0, 10);
  const marker = `${BASE_DB}.${stamp}`;
  if (fs.existsSync(marker)) return BASE_DB;
  // Several recorders may start at once: one seeds, the others wait.
  const lock = `${BASE_DB}.lock`;
  let fd;
  for (let i = 0; ; i++) {
    try {
      fd = fs.openSync(lock, "wx");
      break;
    } catch {
      if (fs.existsSync(marker)) return BASE_DB;
      if (i > 600) fs.rmSync(lock, { force: true }); // stale after ~2 min
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  try {
    if (fs.existsSync(marker)) return BASE_DB;
    rmDb(BASE_DB);
    execFileSync(TSX, ["src/bin/seed-demo.ts"], { cwd: ROOT, env: { ...process.env, WALLET_DB_PATH: BASE_DB }, stdio: "ignore" });
    // Fold the WAL into the main file so a plain copy is complete.
    execFileSync(process.execPath, ["-e", `const D=require("better-sqlite3");const d=new D(${JSON.stringify(BASE_DB)});d.pragma("wal_checkpoint(TRUNCATE)");d.close()`], { cwd: ROOT });
    for (const f of fs.readdirSync(DATA)) if (/^rec-base\.db\.\d{4}-/.test(f)) fs.rmSync(path.join(DATA, f));
    fs.writeFileSync(marker, "");
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
  return BASE_DB;
}

/**
 * Start `next start` on `port` with a fresh copy of the demo DB (or an empty
 * one with `empty: true`). Extra env (e.g. WALLET_AGENT_PROVIDER) passes through.
 */
export async function startServer({ name, port, empty = false, env = {} }) {
  const db = path.join(DATA, `rec-${name}.db`);
  rmDb(db);
  if (!empty) fs.copyFileSync(baseDb(), db);
  const url = `http://localhost:${port}`;
  const serverEnv = {
    ...process.env,
    WALLET_DB_PATH: db,
    WALLET_PUBLIC_URL: url,
    WALLET_AGENT_PROVIDER: "none",
    NEXT_TELEMETRY_DISABLED: "1",
    ...env,
  };
  const log = fs.openSync(path.join(os.tmpdir(), `wallet-rec-${name}.log`), "w");
  const child = spawn(process.execPath, [NEXT, "start", "-p", String(port)], { cwd: ROOT, env: serverEnv, stdio: ["ignore", log, log] });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {}
    if (child.exitCode !== null) throw new Error(`server for ${name} exited (see ${os.tmpdir()}/wallet-rec-${name}.log)`);
    await sleep(250);
  }
  return {
    url,
    db,
    env: serverEnv,
    /** One-time sign-in URL for the demo user (or `user` by name/id). */
    loginUrl(user) {
      const out = execFileSync(TSX, ["src/bin/login-link.ts", ...(user ? ["--user", user] : [])], { cwd: ROOT, env: serverEnv, encoding: "utf8" });
      return out.match(/https?:\/\/\S+/)[0];
    },
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
      rmDb(db);
    },
  };
}

// ── In-page overlays (cursor, captions, badges, font) ────────────────────

const OVERLAY_SCRIPT = String.raw`(() => {
  if (window.__demo) return;
  window.__demo = true;
  const ss = window.sessionStorage;
  const state = JSON.parse(ss.getItem("__demo") || '{"x":-40,"y":-40,"caption":"","badge":""}');
  const save = () => ss.setItem("__demo", JSON.stringify(state));
  const css = document.createElement("style");
  css.textContent = ` + "`" + String.raw`
    @font-face { font-family: "Inter Demo"; src: url("/__demo/inter-latin.woff2") format("woff2"); font-weight: 100 900; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
    @font-face { font-family: "Inter Demo"; src: url("/__demo/inter-latin-ext.woff2") format("woff2"); font-weight: 100 900; unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }
    :root { --font-sans: "Inter Demo", system-ui, sans-serif !important; font-feature-settings: "cv11", "ss01"; }
    body { font-family: "Inter Demo", system-ui, sans-serif !important; }
    nextjs-portal { display: none !important; }
    #__demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; will-change: transform; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
    .__demo-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%;
      background: rgba(91,79,233,.35); border: 2px solid rgba(91,79,233,.8); animation: __demo-ripple .55s ease-out forwards; }
    @keyframes __demo-ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.6); opacity: 0 } }
    #__demo-caption { position: fixed; left: 50%; bottom: 34px; z-index: 2147483645; pointer-events: none; max-width: min(78vw, 980px);
      transform: translate(-50%, 12px); opacity: 0; transition: opacity .35s ease, transform .35s ease;
      font: 600 21px/1.35 "Inter Demo", system-ui, sans-serif; letter-spacing: -.01em; color: #fff; text-align: center;
      padding: 13px 24px; border-radius: 16px; background: rgba(11,18,32,.84); backdrop-filter: blur(8px);
      box-shadow: 0 10px 30px rgba(0,0,0,.25), inset 0 0 0 1px rgba(255,255,255,.08); }
    #__demo-caption.on { opacity: 1; transform: translate(-50%, 0); }
    #__demo-caption b { color: #f5c451; font-weight: 700; }
    #__demo-badge { position: fixed; right: 22px; top: 18px; z-index: 2147483645; pointer-events: none; opacity: 0; transition: opacity .25s;
      font: 700 15px/1 "Inter Demo", system-ui, sans-serif; color: #fff; padding: 9px 13px; border-radius: 999px;
      background: linear-gradient(135deg, #5b4fe9, #8b5cf6); box-shadow: 0 6px 18px rgba(91,79,233,.35); }
    #__demo-badge.on { opacity: 1; }
  ` + "`" + String.raw`;
  const cursor = document.createElement("div");
  cursor.id = "__demo-cursor";
  cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M5 3 L21 13.2 L13.6 14.6 L10 21.6 Z" fill="#0b1220" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  const caption = document.createElement("div");
  caption.id = "__demo-caption";
  const badge = document.createElement("div");
  badge.id = "__demo-badge";
  const place = () => (cursor.style.transform = "translate(" + (state.x - 5) + "px," + (state.y - 3) + "px)");
  window.__demoSet = (patch) => {
    Object.assign(state, patch);
    save();
    caption.innerHTML = state.caption || "";
    caption.classList.toggle("on", !!state.caption);
    badge.textContent = state.badge || "";
    badge.classList.toggle("on", !!state.badge);
  };
  addEventListener("mousemove", (e) => { state.x = e.clientX; state.y = e.clientY; place(); save(); }, true);
  addEventListener("mousedown", (e) => {
    const r = document.createElement("div");
    r.className = "__demo-ripple";
    r.style.left = e.clientX + "px";
    r.style.top = e.clientY + "px";
    document.documentElement.appendChild(r);
    setTimeout(() => r.remove(), 600);
  }, true);
  const mount = () => {
    document.documentElement.append(css, caption, badge, cursor);
    place();
    window.__demoSet({});
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();`;

// ── Recorder ─────────────────────────────────────────────────────────────

/**
 * Record one clip. `fn(rec)` drives the page; call `rec.start()` once the
 * first screen is ready (frames before it are dropped).
 *
 * Options: viewport (CSS px, default 1280×720), scale (device pixel ratio,
 * default 1.5 → 1920×1080), colorScheme, out (mp4 path), posterAt (seconds),
 * holdEnd (seconds the last frame stays).
 */
export async function record(name, fn, opts = {}) {
  const viewport = opts.viewport ?? { width: 1280, height: 720 };
  const scale = opts.scale ?? 1.5;
  const out = opts.out ?? path.join(MEDIA, `${name}.mp4`);
  const pw = loadPlaywright();
  // The flag makes the screencast deliver device pixels (1920×1080 at 1.5), not CSS pixels.
  const browser = await pw.chromium.launch({
    executablePath: chromiumPath(),
    args: [`--force-device-scale-factor=${scale}`, "--font-render-hinting=none", "--disable-lcd-text"],
  });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    colorScheme: opts.colorScheme ?? "light",
    isMobile: opts.isMobile ?? false,
    hasTouch: opts.hasTouch ?? false,
    userAgent: opts.userAgent,
  });
  await context.addInitScript(OVERLAY_SCRIPT);
  if (opts.theme) {
    await context.addInitScript(`try{localStorage.setItem("wallet-theme", ${JSON.stringify(opts.theme)})}catch(e){}`);
  }
  await context.route("**/__demo/*.woff2", (route) => {
    const file = route.request().url().includes("latin-ext") ? "inter-latin-ext-wght-normal.woff2" : "inter-latin-wght-normal.woff2";
    route.fulfill({ path: path.join(ASSETS, file), contentType: "font/woff2" });
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rec-${name}-`));
  const frames = [];
  const speeds = []; // { from, to, factor } in screencast seconds
  let recording = false;
  let posterTime = null;
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (!recording) return;
    const file = path.join(dir, `${String(frames.length).padStart(6, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
  });
  const now = () => Date.now() / 1000;

  /** Ease the mouse to a point over ~`ms`, like a hand would. */
  async function glide(x, y, ms = 650) {
    const from = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__demo") || '{"x":640,"y":360}'));
    const sx = from.x < 0 ? viewport.width * 0.55 : from.x;
    const sy = from.y < 0 ? viewport.height * 0.6 : from.y;
    const steps = Math.max(8, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
      await sleep(ms / steps);
    }
  }

  async function target(locatorOrSelector) {
    const loc = typeof locatorOrSelector === "string" ? page.locator(locatorOrSelector).first() : locatorOrSelector;
    await loc.waitFor({ state: "visible", timeout: 20_000 });
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.boundingBox();
    return { loc, x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  const rec = {
    page,
    context,
    viewport,
    async start() {
      await page.evaluate(() => document.fonts.ready);
      await sleep(300);
      recording = true;
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 92,
        maxWidth: Math.round(viewport.width * scale),
        maxHeight: Math.round(viewport.height * scale),
        everyNthFrame: 1,
      });
      // Nudge a repaint so the first frame arrives right away.
      await page.evaluate(() => window.__demoSet({}));
      await sleep(200);
    },
    pause: (ms) => sleep(ms),
    /** Show a caption (HTML allowed: <b> renders gold). Empty string hides it. */
    async caption(html, holdMs = 0) {
      await page.evaluate((c) => window.__demoSet({ caption: c }), html);
      if (holdMs) await sleep(holdMs);
    },
    async move(locatorOrSelector, ms) {
      const t = await target(locatorOrSelector);
      await glide(t.x, t.y, ms);
      return t.loc;
    },
    async moveTo(x, y, ms) {
      await glide(x, y, ms);
    },
    async click(locatorOrSelector, { ms, after = 450 } = {}) {
      const t = await target(locatorOrSelector);
      await glide(t.x, t.y, ms);
      await sleep(120);
      await page.mouse.down();
      await sleep(70);
      await page.mouse.up();
      await sleep(after);
      return t.loc;
    },
    async hover(locatorOrSelector, ms) {
      return rec.move(locatorOrSelector, ms);
    },
    /** Click a field, then type like a person. */
    async type(locatorOrSelector, text, { delay = 55, clear = true } = {}) {
      const loc = await rec.click(locatorOrSelector, { after: 150 });
      if (clear) await loc.fill("");
      await loc.pressSequentially(text, { delay });
      await sleep(250);
      return loc;
    },
    async scroll(dy, ms = 900) {
      const steps = Math.max(10, Math.round(ms / 16));
      for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(0, dy / steps);
        await sleep(ms / steps);
      }
      await sleep(200);
    },
    async goto(url, { waitFor } = {}) {
      await page.goto(url, { waitUntil: "networkidle" });
      if (waitFor) await page.locator(waitFor).first().waitFor({ timeout: 20_000 });
      await page.evaluate(() => document.fonts.ready);
    },
    /** Run `fn` while showing a badge; its frames play `factor`× faster. */
    async fastForward(fn, factor = 6, label = `⏩ ${factor}× faster`) {
      await page.evaluate((b) => window.__demoSet({ badge: b }), label);
      await sleep(250);
      const from = now();
      try {
        return await fn();
      } finally {
        speeds.push({ from, to: now(), factor });
        await page.evaluate(() => window.__demoSet({ badge: "" })).catch(() => {});
      }
    },
    /** Use the current moment as the video's poster frame. */
    poster() {
      posterTime = now();
    },
    /** Smoothly zoom the page body toward an element (cursor & captions stay put). */
    async zoom(locatorOrSelector, factor = 1.5, ms = 900) {
      if (!locatorOrSelector) {
        await page.evaluate((ms) => {
          document.body.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`;
          document.body.style.transform = "";
        }, ms);
        await sleep(ms + 100);
        return;
      }
      const { x, y } = await target(locatorOrSelector);
      await page.evaluate(
        ({ x, y, factor, ms }) => {
          const b = document.body;
          b.style.transformOrigin = `${x + scrollX}px ${y + scrollY}px`;
          b.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`;
          b.style.transform = `scale(${factor})`;
        },
        { x, y, factor, ms },
      );
      await sleep(ms + 100);
    },
  };

  try {
    await fn(rec);
    await sleep(opts.tailMs ?? 600);
  } finally {
    recording = false;
    await cdp.send("Page.stopScreencast").catch(() => {});
    await browser.close();
  }
  if (frames.length < 2) throw new Error(`${name}: no frames captured (did you call rec.start()?)`);
  encodeFrames(frames, out, { speeds, holdEnd: opts.holdEnd ?? 1.2, posterTime });
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

/** Turn timestamped frames into a constant-frame-rate H.264 MP4 (+ JPEG poster). */
function encodeFrames(frames, out, { speeds, holdEnd, posterTime }) {
  const speedAt = (t) => speeds.find((s) => t >= s.from && t < s.to)?.factor ?? 1;
  const lines = [];
  let clock = 0;
  let posterOffset = null;
  frames.forEach((f, i) => {
    const next = frames[i + 1];
    let d = next ? Math.max(0, next.t - f.t) : holdEnd;
    if (next) d /= speedAt(f.t);
    d = Math.min(d, 8); // never freeze longer than 8 s on a stalled frame
    if (posterTime !== null && posterOffset === null && f.t >= posterTime) posterOffset = clock;
    lines.push(`file '${f.file}'`, `duration ${d.toFixed(4)}`);
    clock += d;
  });
  lines.push(`file '${frames.at(-1).file}'`);
  const list = `${out}.frames.txt`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(list, lines.join("\n"));
  execFileSync(
    "ffmpeg",
    [
      "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
      "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,format=yuv420p",
      "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-tune", "animation",
      "-movflags", "+faststart", "-an", out,
    ],
    { stdio: "inherit" },
  );
  fs.rmSync(list);
  const at = posterOffset ?? Math.min(clock * 0.4, 3);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", at.toFixed(2), "-i", out, "-frames:v", "1", "-q:v", "3", out.replace(/\.mp4$/, ".jpg")]);
  console.log(`✓ ${path.relative(ROOT, out)} (${clock.toFixed(1)} s)`);
}

// ── Post-production helpers ──────────────────────────────────────────────

export function duration(file) {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
}

/** Join clips (same size/fps) with short crossfades. */
export function joinClips(clips, out, { fade = 0.5 } = {}) {
  if (clips.length === 1) return fs.copyFileSync(clips[0], out);
  const inputs = clips.flatMap((c) => ["-i", c]);
  const durs = clips.map(duration);
  let filter = "";
  let prev = "[0:v]";
  let offset = 0;
  for (let i = 1; i < clips.length; i++) {
    offset += durs[i - 1] - fade;
    const label = i === clips.length - 1 ? "[v]" : `[x${i}]`;
    filter += `${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}${label};`;
    prev = label;
  }
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter.replace(/;$/, ""), "-map", "[v]",
      "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
    { stdio: "inherit" },
  );
  console.log(`✓ ${path.relative(ROOT, out)} (${duration(out).toFixed(1)} s)`);
}
