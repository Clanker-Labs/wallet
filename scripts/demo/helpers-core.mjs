/**
 * Shared helpers for the core-feature clips (signup, accounts, investments,
 * budgets, transactions). Builds on `lib.mjs`'s `rec` without changing it.
 *
 * - `chooseOption`: native <select> popups aren't painted in the screencast,
 *   so this draws a look-alike list, moves the cursor onto the choice, then
 *   selects it for real (React sees a normal change event).
 * - `dropFile`: drags a file card in from the window edge and drops a real
 *   File (DataTransfer) on a drop zone.
 * - `openDb` / `insertTransactions`: tweak a clip's private DB copy.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT, sleep } from "./lib.mjs";

const require = createRequire(path.join(ROOT, "package.json"));

// ── Page helpers ─────────────────────────────────────────────────────────

const loc = (rec, l) => (typeof l === "string" ? rec.page.locator(l).first() : l);

/**
 * Make `rec`'s mouse glides last the time asked. lib.mjs steps every 16 ms
 * plus a CDP round trip per step, which runs 2–3× long while screencasting;
 * this version eases on the wall clock instead. Same API, patched in place.
 */
export function tune(rec) {
  const page = rec.page;
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  async function glide(x, y, ms = 650) {
    const from = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__demo") || '{"x":640,"y":360}'));
    const sx = from.x < 0 ? rec.viewport.width * 0.55 : from.x;
    const sy = from.y < 0 ? rec.viewport.height * 0.6 : from.y;
    const t0 = Date.now();
    for (;;) {
      const k = Math.min(1, (Date.now() - t0) / ms);
      const e = ease(k);
      await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
      if (k >= 1) break;
      await sleep(6);
    }
  }
  async function target(l) {
    const el = loc(rec, l);
    await el.waitFor({ state: "visible", timeout: 20_000 });
    await el.scrollIntoViewIfNeeded();
    const box = await el.boundingBox();
    return { el, x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  rec.moveTo = (x, y, ms) => glide(x, y, ms);
  rec.move = async (l, ms) => {
    const t = await target(l);
    await glide(t.x, t.y, ms);
    return t.el;
  };
  rec.hover = rec.move;
  rec.click = async (l, { ms, after = 450 } = {}) => {
    const t = await target(l);
    await glide(t.x, t.y, ms);
    await sleep(120);
    await page.mouse.down();
    await sleep(70);
    await page.mouse.up();
    await sleep(after);
    return t.el;
  };
  /** Eased page scroll animated in the page (rAF), so it lasts `ms`. */
  rec.scroll = async (dy, ms = 900) => {
    await page.evaluate(
      ({ dy, ms }) =>
        new Promise((done) => {
          const y0 = scrollY;
          const max = document.documentElement.scrollHeight - innerHeight;
          const to = Math.max(0, Math.min(max, y0 + dy));
          const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
          const t0 = performance.now();
          const step = (now) => {
            const k = Math.min(1, (now - t0) / ms);
            scrollTo(0, y0 + (to - y0) * ease(k));
            if (k < 1) requestAnimationFrame(step);
            else done();
          };
          requestAnimationFrame(step);
        }),
      { dy, ms },
    );
    await sleep(150);
  };
  rec.type = async (l, text, { delay = 55, clear = true, ms } = {}) => {
    const el = await rec.click(l, { ms, after: 150 });
    if (clear) await el.fill("");
    await el.pressSequentially(text, { delay });
    await sleep(250);
    return el;
  };
  // DEMO_TIMING=1 logs when each step starts and how long it took.
  if (process.env.DEMO_TIMING) {
    const t0 = Date.now();
    for (const name of ["move", "moveTo", "click", "type", "scroll", "caption", "zoom", "goto"]) {
      const fn = rec[name];
      rec[name] = async (...args) => {
        const s = Date.now();
        const out = await fn(...args);
        const what = typeof args[0] === "string" ? args[0].slice(0, 50) : "";
        console.log(`${((s - t0) / 1000).toFixed(1).padStart(6)}s  +${((Date.now() - s) / 1000).toFixed(2)}s  ${name} ${what}`);
        return out;
      };
    }
  }
  return rec;
}

/** Sign in as the demo user and open `pathname` (waits for `waitFor`). */
export async function signIn(rec, server, pathname = "/", waitFor) {
  await rec.goto(server.loginUrl(), { waitFor: "text=Net worth" });
  if (pathname !== "/" || waitFor) await rec.goto(server.url + pathname, { waitFor });
}

/** Click ripple at a viewport point, without a real click. */
export async function ripple(rec, x, y) {
  await rec.page.evaluate(
    ({ x, y }) => {
      const r = document.createElement("div");
      r.className = "__demo-ripple";
      r.style.left = x + "px";
      r.style.top = y + "px";
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 600);
    },
    { x, y },
  );
}

/** Center of an element (after scrolling it into view if needed). */
export async function center(rec, l) {
  const el = loc(rec, l);
  await el.waitFor({ state: "visible", timeout: 20_000 });
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b, el };
}

/** Glide across an element's box at the given horizontal fractions (chart tooltips). */
export async function sweep(rec, l, xs, { y = 0.5, ms = 600, hold = 0 } = {}) {
  const { box } = await center(rec, l);
  for (const k of xs) {
    await rec.moveTo(box.x + box.width * k, box.y + box.height * y, ms);
    if (hold) await sleep(hold);
  }
}

/** Smoothly scroll the page so `l` sits `top` px from the viewport top. */
export async function scrollTo(rec, l, { top = 90, ms = 900 } = {}) {
  const el = loc(rec, l);
  await el.waitFor({ state: "attached", timeout: 20_000 });
  const dy = await el.evaluate((n, top) => n.getBoundingClientRect().top - top, top);
  if (Math.abs(dy) > 4) await rec.scroll(dy, ms);
}

/**
 * Use the current screen as the poster. A frame only arrives when something
 * repaints, so nudge the cursor a pixel to make sure this moment is captured.
 */
export async function markPoster(rec) {
  rec.poster();
  const p = await rec.page.evaluate(() => JSON.parse(sessionStorage.getItem("__demo") || '{"x":640,"y":360}'));
  await rec.page.mouse.move(p.x + 1, p.y);
  await sleep(80);
}

/** Press a key with a short beat after it. */
export async function press(rec, key, after = 400) {
  await rec.page.keyboard.press(key);
  await sleep(after);
}

/**
 * Pick an option in a native <select> by value or visible label, showing a
 * look-alike dropdown list so the viewer sees the choice being made.
 */
export async function chooseOption(rec, select, choice, { rows = 7, after = 350 } = {}) {
  const page = rec.page;
  const el = loc(rec, select);
  const { x, y } = await center(rec, el);
  await rec.moveTo(x, y, 650);
  await sleep(100);
  await ripple(rec, x, y);
  await el.focus();
  const target = await el.evaluate(
    (sel, { choice, rows }) => {
      const items = [];
      const add = (o) => items.push({ label: o.textContent.trim(), value: o.value });
      for (const c of sel.children) {
        if (c.tagName === "OPTGROUP") {
          items.push({ group: c.label });
          for (const o of c.children) add(o);
        } else add(c);
      }
      const norm = (s) => String(s).trim().toLowerCase();
      let idx = items.findIndex((i) => !i.group && i.value === choice);
      if (idx < 0) idx = items.findIndex((i) => !i.group && norm(i.label) === norm(choice));
      if (idx < 0) idx = items.findIndex((i) => !i.group && norm(i.label).includes(norm(choice)));
      if (idx < 0) throw new Error(`chooseOption: no option "${choice}"`);
      // A window of rows around the choice (it sits a little below the middle).
      let start = Math.max(0, idx - Math.ceil(rows / 2));
      start = Math.max(0, Math.min(start, items.length - rows));
      const shown = items.slice(start, start + rows);
      const r = sel.getBoundingClientRect();
      const ROW = 30;
      const height = shown.length * ROW + 8;
      const below = r.bottom + 4 + height < innerHeight - 8;
      const width = Math.max(r.width, 180);
      const left = Math.max(8, Math.min(r.left, innerWidth - width - 12));
      const list = document.createElement("div");
      list.id = "__demo-select";
      Object.assign(list.style, {
        position: "fixed",
        left: left + "px",
        top: (below ? r.bottom + 4 : r.top - 4 - height) + "px",
        minWidth: width + "px",
        boxSizing: "border-box",
        zIndex: 2147483640,
        padding: "4px",
        borderRadius: "10px",
        border: "1px solid var(--border, #e5e7eb)",
        background: "var(--surface, #fff)",
        boxShadow: "0 12px 32px rgba(15,23,42,.18)",
        font: '500 13.5px/1 "Inter Demo", system-ui, sans-serif',
        color: "var(--ink, #0b1220)",
        opacity: "0",
        transform: "translateY(-4px)",
        transition: "opacity .14s ease, transform .14s ease",
      });
      const style = document.createElement("style");
      style.textContent =
        "#__demo-select .o{height:30px;display:flex;align-items:center;padding:0 10px;border-radius:7px;white-space:nowrap}" +
        "#__demo-select .o:hover,#__demo-select .o.cur{background:var(--surface-2,#f1f5f9)}" +
        "#__demo-select .o.sel{font-weight:650}" +
        "#__demo-select .g{height:30px;display:flex;align-items:flex-end;padding:0 10px 6px;font-size:11px;font-weight:600;color:var(--muted,#64748b);text-transform:uppercase;letter-spacing:.04em}";
      list.appendChild(style);
      let targetRow = null;
      for (const it of shown) {
        const row = document.createElement("div");
        row.className = it.group ? "g" : "o";
        row.textContent = it.group ?? it.label;
        if (!it.group && it.value === sel.value) row.classList.add("sel");
        if (items.indexOf(it) === idx) targetRow = row;
        list.appendChild(row);
      }
      document.documentElement.appendChild(list);
      requestAnimationFrame(() => {
        list.style.opacity = "1";
        list.style.transform = "none";
      });
      const t = targetRow.getBoundingClientRect();
      return { value: items[idx].value, x: t.left + Math.min(t.width / 2, 70), y: t.top + t.height / 2 };
    },
    { choice, rows },
  );
  await sleep(320);
  await rec.moveTo(target.x, target.y, 550);
  await sleep(200);
  await ripple(rec, target.x, target.y);
  await sleep(120);
  await page.evaluate(() => document.getElementById("__demo-select")?.remove());
  await el.selectOption(target.value);
  await sleep(after);
}

/**
 * Drag a file card in from the right edge onto `zone` and drop `content` as a
 * real File, like dragging it from the Finder.
 */
export async function dropFile(rec, zone, { name, content, type = "text/csv", from = { x: 1272, y: 600 } }) {
  const page = rec.page;
  const { x, y, el } = await center(rec, zone);
  await page.evaluate(
    ({ name, from }) => {
      const chip = document.createElement("div");
      chip.id = "__demo-file";
      chip.innerHTML =
        '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M3 1h11l6 6v16a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" fill="#fff" stroke="#16a34a" stroke-width="1.6"/><path d="M14 1v6h6" fill="none" stroke="#16a34a" stroke-width="1.6"/><text x="11" y="20" text-anchor="middle" font-size="6.5" font-weight="700" fill="#16a34a" font-family="system-ui">CSV</text></svg>' +
        "<span></span>";
      chip.querySelector("span").textContent = name;
      Object.assign(chip.style, {
        position: "fixed",
        left: "0",
        top: "0",
        zIndex: 2147483646,
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 12px 8px 9px",
        borderRadius: "10px",
        background: "rgba(255,255,255,.96)",
        border: "1px solid rgba(15,23,42,.12)",
        boxShadow: "0 10px 26px rgba(15,23,42,.22)",
        font: '600 13px/1 "Inter Demo", system-ui, sans-serif',
        color: "#0b1220",
        transform: `translate(${from.x + 14}px, ${from.y + 12}px) rotate(-2deg)`,
      });
      document.documentElement.appendChild(chip);
      const follow = (e) => (chip.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px) rotate(-2deg)`);
      addEventListener("mousemove", follow, true);
      window.__demoChipOff = () => removeEventListener("mousemove", follow, true);
      window.__demoSet({ x: from.x, y: from.y });
    },
    { name, from },
  );
  await rec.moveTo(x, y + 20, 1100);
  // Hover the zone with a file: it highlights like a real drag.
  await el.evaluate((zoneEl, { name, content, type }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([content], name, { type }));
    window.__demoDT = dt;
    for (const t of ["dragenter", "dragover"]) zoneEl.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { name, content, type });
  await sleep(650);
  await ripple(rec, x, y + 20);
  await el.evaluate((zoneEl) => {
    window.__demoChipOff?.();
    document.getElementById("__demo-file")?.remove();
    zoneEl.dispatchEvent(new DragEvent("drop", { dataTransfer: window.__demoDT, bubbles: true, cancelable: true }));
  });
}

// ── Database tweaks (each clip runs on its own copy) ─────────────────────

export function openDb(file) {
  const Database = require("better-sqlite3");
  const db = new Database(file);
  db.pragma("busy_timeout = 5000");
  return db;
}

/** The demo user's id, account ids by name and category ids by name. */
export function demoIds(db) {
  const uid = db.prepare("SELECT id FROM users WHERE name = 'Alex'").get()?.id ?? db.prepare("SELECT id FROM users LIMIT 1").get().id;
  const accounts = Object.fromEntries(db.prepare("SELECT name, id FROM accounts WHERE user_id = ?").all(uid).map((r) => [r.name, r.id]));
  const categories = Object.fromEntries(db.prepare("SELECT name, id FROM categories WHERE user_id = ?").all(uid).map((r) => [r.name, r.id]));
  return { uid, accounts, categories };
}

/** Insert transactions (amounts in units, negative = spending) for the demo user. */
export function insertTransactions(db, rows) {
  const { uid, accounts, categories } = demoIds(db);
  const stmt = db.prepare(
    `INSERT INTO transactions (user_id, account_id, date, amount_cents, currency, description, category_id, import_hash, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'demo')`,
  );
  db.transaction(() => {
    rows.forEach((r, i) => {
      const accountId = accounts[r.account];
      if (!accountId) throw new Error(`No account ${r.account}`);
      const categoryId = r.category ? categories[r.category] : null;
      if (r.category && !categoryId) throw new Error(`No category ${r.category}`);
      stmt.run(uid, accountId, r.date, Math.round(r.amount * 100), r.currency ?? "EUR", r.description, categoryId, `demo-extra-${Date.now()}-${i}`);
    });
  })();
}

/** ISO date `days` before `iso` (UTC arithmetic, fine for dates). */
export function minusDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
