import Database from "better-sqlite3";
import { db } from "@/server/db/client";

/**
 * Read-only SQL for the agent, scoped to one user: their rows are copied into
 * a private in-memory database (other users, sessions, passkeys and uploads
 * never exist there), cached for a few seconds across a burst of queries.
 */

const USER_TABLES = [
  "accounts",
  "holdings",
  "categories",
  "category_rules",
  "budgets",
  "transactions",
  "reminders",
  "simulations",
  "settings",
] as const;

const TTL_MS = 15_000;
const cache = new Map<string, { conn: Database.Database; at: number }>();

function createTableSql(table: string): string {
  const row = db().$client.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
    | undefined;
  if (!row) throw new Error(`Missing table ${table}`);
  return row.sql;
}

function copy(target: Database.Database, table: string, rows: Record<string, unknown>[]) {
  target.exec(createTableSql(table));
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const stmt = target.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const r of rows) stmt.run(...cols.map((c) => r[c] as never));
}

function build(uid: string): Database.Database {
  const src = db().$client;
  const mem = new Database(":memory:");
  mem.transaction(() => {
    for (const t of USER_TABLES) copy(mem, t, src.prepare(`SELECT * FROM "${t}" WHERE user_id = ?`).all(uid) as never);
    copy(
      mem,
      "balance_snapshots",
      src
        .prepare("SELECT s.* FROM balance_snapshots s JOIN accounts a ON a.id = s.account_id WHERE a.user_id = ?")
        .all(uid) as never,
    );
    copy(
      mem,
      "prices",
      src
        .prepare("SELECT * FROM prices WHERE symbol IN (SELECT DISTINCT upper(symbol) FROM holdings WHERE user_id = ?)")
        .all(uid) as never,
    );
    copy(
      mem,
      "fx_rates",
      src
        .prepare(
          `SELECT * FROM fx_rates WHERE currency IN (
             SELECT currency FROM accounts WHERE user_id = ?1
             UNION SELECT currency FROM transactions WHERE user_id = ?1
             UNION SELECT currency FROM holdings WHERE user_id = ?1
             UNION SELECT value FROM settings WHERE user_id = ?1 AND key = 'currency'
             UNION SELECT 'USD')`,
        )
        .all(uid) as never,
    );
  })();
  return mem;
}

function sandbox(uid: string): Database.Database {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.conn;
  hit?.conn.close();
  const conn = build(uid);
  cache.set(uid, { conn, at: Date.now() });
  return conn;
}

const MAX_ROWS = 500;

export function runUserSql(uid: string, sql: string) {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (trimmed.includes(";")) throw new Error("Only a single statement is allowed");
  const stmt = sandbox(uid).prepare(trimmed);
  if (!stmt.reader || !stmt.readonly) throw new Error("Only read-only SELECT statements are allowed");
  const rows: unknown[] = [];
  for (const row of stmt.iterate()) {
    rows.push(row);
    if (rows.length >= MAX_ROWS) break;
  }
  return { rows, truncated: rows.length >= MAX_ROWS };
}

/** Drop cached sandboxes (after writes, so the next query sees fresh data). */
export function invalidateSqlSandbox(uid?: string) {
  for (const [key, entry] of cache) {
    if (!uid || key === uid) {
      entry.conn.close();
      cache.delete(key);
    }
  }
}
