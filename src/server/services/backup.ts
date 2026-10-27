import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { db, dbPath } from "@/server/db/client";

/**
 * Backups of the whole database (every user), and restore.
 *
 * A backup is `VACUUM INTO`: a consistent, compacted copy taken while the app
 * runs. The server takes one a day by itself (instrumentation.ts) and keeps
 * the last 14 plus one a week for 8 weeks. Restoring replaces the data with a
 * backup's, after taking a safety backup — but keeps who is signed in
 * (sessions, passkeys, pending sign-ins), so a restore never locks you out.
 */

const KEEP_DAILY = 14;
const KEEP_WEEKLY = 8;
/** Tables a restore leaves as they are. */
const KEEP_ON_RESTORE = new Set(["sessions", "passkeys", "auth_challenges", "__drizzle_migrations", "sqlite_sequence"]);

export function backupDir(): string {
  const configured = process.env.WALLET_BACKUP_DIR?.trim();
  if (configured) return configured;
  const file = dbPath();
  return path.join(file === ":memory:" ? process.cwd() : path.dirname(file), "backups");
}

export interface BackupFile {
  name: string;
  bytes: number;
  createdAt: string;
  reason: string;
}

const NAME = /^wallet-(\d{8})-(\d{6})(?:-([a-z-]+))?\.db$/;

export function listBackups(): BackupFile[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => NAME.test(n))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      const m = name.match(NAME)!;
      return { name, bytes: st.size, createdAt: st.mtime.toISOString(), reason: m[3] ?? "manual" };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function backupPath(name: string): string {
  if (!NAME.test(name)) throw new Error("Not a backup file name");
  return path.join(backupDir(), name);
}

/** Take a backup now. `reason` ends up in the file name (daily, before-restore…). */
export function createBackup(reason = "manual"): BackupFile {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const tag = reason.toLowerCase().replace(/[^a-z-]+/g, "-").slice(0, 20);
  let name = `wallet-${stamp}-${tag}.db`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `wallet-${stamp}-${tag}${"-x".repeat(i - 1)}.db`;
  const file = path.join(dir, name);
  db().$client.prepare("VACUUM INTO ?").run(file);
  fs.chmodSync(file, 0o600);
  prune();
  return listBackups().find((b) => b.name === name)!;
}

/** Keep the newest KEEP_DAILY, and the newest of each of the KEEP_WEEKLY weeks before them. */
export function prune(): string[] {
  const all = listBackups();
  const keep = new Set(all.filter((b) => b.reason !== "before-restore").slice(0, KEEP_DAILY).map((b) => b.name));
  const weeks = new Set<string>();
  for (const b of all) {
    if (keep.has(b.name) || b.reason === "before-restore") continue;
    const d = new Date(b.createdAt);
    const week = `${d.getUTCFullYear()}-${Math.floor((d.getTime() / 86_400_000 + 4) / 7)}`;
    if (!weeks.has(week) && weeks.size < KEEP_WEEKLY) {
      weeks.add(week);
      keep.add(b.name);
    }
  }
  // Safety copies taken before a restore: keep the last 3.
  for (const b of all.filter((x) => x.reason === "before-restore").slice(0, 3)) keep.add(b.name);
  const removed: string[] = [];
  for (const b of all) {
    if (keep.has(b.name)) continue;
    fs.rmSync(path.join(backupDir(), b.name), { force: true });
    removed.push(b.name);
  }
  return removed;
}

/** Take the daily backup if the newest one is more than a day old. */
export function ensureDailyBackup(now = Date.now()): BackupFile | null {
  const latest = listBackups()[0];
  if (latest && now - Date.parse(latest.createdAt) < 23 * 3_600_000) return null;
  return createBackup("daily");
}

/**
 * Replace the data with a backup's. Checks the file is a wallet database no
 * newer than this app, takes a safety backup, then copies every table across
 * in one transaction (columns the backup predates keep their defaults).
 */
export function restoreBackup(name: string): { tables: number; safety: string } {
  const file = backupPath(name);
  if (!fs.existsSync(file)) throw new Error("That backup doesn't exist.");
  const probe = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => (r as { name: string }).name);
    if (!tables.includes("accounts") || !tables.includes("users")) throw new Error("That file isn't a wallet database.");
    const theirs = tables.includes("__drizzle_migrations") ? (probe.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n : 0;
    const ours = (db().$client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;
    if (theirs > ours) throw new Error("That backup comes from a newer version of wallet: update the app first.");
  } finally {
    probe.close();
  }
  const safety = createBackup("before-restore");
  const conn = db().$client;
  conn.pragma("foreign_keys = OFF");
  let count = 0;
  conn.prepare("ATTACH DATABASE ? AS b").run(file);
  try {
    conn.transaction(() => {
      const ours = conn.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all().map((r) => (r as { name: string }).name);
      const theirs = new Set(conn.prepare("SELECT name FROM b.sqlite_master WHERE type = 'table'").all().map((r) => (r as { name: string }).name));
      for (const t of ours) {
        if (KEEP_ON_RESTORE.has(t)) continue;
        conn.prepare(`DELETE FROM main."${t}"`).run();
        if (!theirs.has(t)) continue;
        const mine = conn.prepare(`PRAGMA main.table_info("${t}")`).all().map((c) => (c as { name: string }).name);
        const cols = new Set(conn.prepare(`PRAGMA b.table_info("${t}")`).all().map((c) => (c as { name: string }).name));
        const common = mine.filter((c) => cols.has(c)).map((c) => `"${c}"`).join(", ");
        conn.prepare(`INSERT INTO main."${t}" (${common}) SELECT ${common} FROM b."${t}"`).run();
        count++;
      }
      // Sessions of users the backup doesn't have would point nowhere.
      conn.prepare("DELETE FROM main.sessions WHERE user_id NOT IN (SELECT id FROM main.users)").run();
      conn.prepare("DELETE FROM main.passkeys WHERE user_id NOT IN (SELECT id FROM main.users)").run();
    })();
  } finally {
    conn.prepare("DETACH DATABASE b").run();
    conn.pragma("foreign_keys = ON");
  }
  return { tables: count, safety: safety.name };
}
