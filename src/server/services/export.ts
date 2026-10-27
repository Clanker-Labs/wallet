import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { categories, transactions, users } from "@/server/db/schema";

/**
 * Tables exported, in an order an import can follow (parents first). Every
 * column as stored (snake_case). Broker credentials, sessions, passkeys and
 * uploaded files are never exported.
 */
const EXPORT_TABLES = [
  "categories",
  "accounts",
  "balance_snapshots",
  "holdings",
  "recurring",
  "transactions",
  "transaction_splits",
  "category_rules",
  "budgets",
  "reminders",
  "simulations",
  "settings",
  "goals",
  "company_financials",
  "presence",
  "tax_inputs",
  "agent_conversations",
] as const;

/** Export of one user's data: every table except raw agent transcripts, uploads and credentials. */
export function exportAll(uid: string) {
  const c = db().$client;
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const t of EXPORT_TABLES) {
    tables[t] =
      t === "balance_snapshots"
        ? (c.prepare("SELECT s.* FROM balance_snapshots s JOIN accounts a ON a.id = s.account_id WHERE a.user_id = ?").all(uid) as Record<string, unknown>[])
        : (c.prepare(`SELECT * FROM "${t}" WHERE user_id = ?`).all(uid) as Record<string, unknown>[]);
  }
  return {
    app: "wallet",
    format: 3,
    exportedAt: new Date().toISOString(),
    user: db().select({ id: users.id, name: users.name, createdAt: users.createdAt }).from(users).where(eq(users.id, uid)).get(),
    tables,
  };
}

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Load a wallet export into this user's (empty) wallet: every id is new, and
 * every reference follows (accounts, categories, recurring items, companies).
 * Categories with the same name and kind as an existing one are merged into
 * it. Works with format 2 (camelCase) and 3 exports.
 */
export function importExport(uid: string, data: unknown): Record<string, number> {
  const d = data as { app?: string; format?: number; tables?: Record<string, Record<string, unknown>[]> };
  if (d?.app !== "wallet" || !d.tables || typeof d.tables !== "object") throw new Error("That file isn't a wallet export.");
  const c = db().$client;
  const has = (t: string) => (c.prepare(`SELECT count(*) AS n FROM "${t}" WHERE user_id = ?`).get(uid) as { n: number }).n;
  if (has("accounts") || has("transactions")) throw new Error("Import into an empty wallet: this one already has accounts or transactions.");
  // Format 2 wrote camelCase keys and ISO timestamps; the database wants snake_case and milliseconds.
  const rows = (t: string) =>
    (d.tables![t] ?? []).map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => {
          const key = snake(k);
          return [key, key.endsWith("_at") && key !== "archived_at" && typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : v];
        }),
      ),
    );
  const columns = new Map<string, Set<string>>();
  const cols = (t: string) => {
    if (!columns.has(t)) columns.set(t, new Set(c.prepare(`PRAGMA table_info("${t}")`).all().map((x) => (x as { name: string }).name)));
    return columns.get(t)!;
  };
  const insert = (t: string, row: Record<string, unknown>): number => {
    const keep = Object.entries(row).filter(([k]) => cols(t).has(k) && k !== "id");
    const vals = keep.map(([, v]) => (v !== null && typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? Number(v) : v));
    const res = c.prepare(`INSERT INTO "${t}" (${keep.map(([k]) => `"${k}"`).join(", ")}) VALUES (${keep.map(() => "?").join(", ")})`).run(...(vals as never[]));
    return Number(res.lastInsertRowid);
  };
  const maps = { categories: new Map<number, number>(), accounts: new Map<number, number>(), recurring: new Map<number, number>(), transactions: new Map<number, number>() };
  const m = (map: Map<number, number>, v: unknown) => (v === null || v === undefined ? null : (map.get(Number(v)) ?? null));
  const counts: Record<string, number> = {};
  const count = (t: string) => (counts[t] = (counts[t] ?? 0) + 1);
  c.pragma("foreign_keys = OFF");
  try {
    c.transaction(() => {
      const existing = c.prepare("SELECT id, name, kind FROM categories WHERE user_id = ?").all(uid) as { id: number; name: string; kind: string }[];
      for (const r of rows("categories")) {
        const same = existing.find((e) => e.name.toLowerCase() === String(r.name).toLowerCase() && e.kind === r.kind);
        maps.categories.set(Number(r.id), same ? same.id : (count("categories"), insert("categories", { ...r, user_id: uid })));
      }
      const accs = rows("accounts");
      for (const r of accs) {
        maps.accounts.set(Number(r.id), insert("accounts", { ...r, user_id: uid, linked_account_id: null, company_id: null }));
        count("accounts");
      }
      for (const r of accs) {
        c.prepare("UPDATE accounts SET linked_account_id = ?, company_id = ? WHERE id = ?").run(m(maps.accounts, r.linked_account_id), m(maps.accounts, r.company_id), maps.accounts.get(Number(r.id))!);
      }
      for (const r of rows("balance_snapshots")) {
        const a = m(maps.accounts, r.account_id);
        if (a) (insert("balance_snapshots", { ...r, account_id: a }), count("balance_snapshots"));
      }
      for (const r of rows("holdings")) {
        const a = m(maps.accounts, r.account_id);
        if (a) (insert("holdings", { ...r, user_id: uid, account_id: a, connection_id: null, external_id: null }), count("holdings"));
      }
      for (const r of rows("recurring")) {
        maps.recurring.set(Number(r.id), insert("recurring", { ...r, user_id: uid, account_id: m(maps.accounts, r.account_id), category_id: m(maps.categories, r.category_id) }));
        count("recurring");
      }
      for (const r of rows("transactions")) {
        maps.transactions.set(
          Number(r.id),
          insert("transactions", { ...r, user_id: uid, account_id: m(maps.accounts, r.account_id), category_id: m(maps.categories, r.category_id), recurring_id: m(maps.recurring, r.recurring_id) }),
        );
        count("transactions");
      }
      for (const r of rows("transaction_splits")) {
        const tx = m(maps.transactions, r.transaction_id);
        if (tx) (insert("transaction_splits", { ...r, user_id: uid, transaction_id: tx, category_id: m(maps.categories, r.category_id) }), count("transaction_splits"));
      }
      for (const r of rows("category_rules")) {
        const cat = m(maps.categories, r.category_id);
        if (cat) (insert("category_rules", { ...r, user_id: uid, category_id: cat, account_id: m(maps.accounts, r.account_id) }), count("category_rules"));
      }
      for (const r of rows("budgets")) {
        const cat = m(maps.categories, r.category_id);
        if (!cat) continue;
        c.prepare("DELETE FROM budgets WHERE category_id = ?").run(cat);
        insert("budgets", { ...r, user_id: uid, category_id: cat });
        count("budgets");
      }
      for (const r of rows("reminders")) (insert("reminders", { ...r, user_id: uid, account_id: m(maps.accounts, r.account_id) }), count("reminders"));
      for (const r of rows("simulations")) (insert("simulations", { ...r, user_id: uid }), count("simulations"));
      for (const r of rows("settings")) {
        c.prepare("DELETE FROM settings WHERE user_id = ? AND key = ?").run(uid, r.key);
        insert("settings", { ...r, user_id: uid });
        count("settings");
      }
      for (const r of rows("goals")) {
        const ids = (typeof r.account_ids === "string" ? JSON.parse(r.account_ids) : (r.account_ids ?? [])) as number[];
        insert("goals", { ...r, user_id: uid, account_ids: ids.map((x) => maps.accounts.get(x)).filter(Boolean) });
        count("goals");
      }
      for (const r of rows("company_financials")) {
        const co = m(maps.accounts, r.company_id);
        if (co) (insert("company_financials", { ...r, user_id: uid, company_id: co }), count("company_financials"));
      }
      for (const r of rows("presence")) (insert("presence", { ...r, user_id: uid }), count("presence"));
      for (const r of rows("tax_inputs")) {
        // Inputs about a company carry its id: follow it.
        const key = String(r.key).replace(/^company\.(\d+)\./, (_, id) => `company.${maps.accounts.get(Number(id)) ?? id}.`);
        c.prepare("DELETE FROM tax_inputs WHERE user_id = ? AND year = ? AND key = ?").run(uid, r.year, key);
        insert("tax_inputs", { ...r, user_id: uid, key });
        count("tax_inputs");
      }
    })();
  } finally {
    c.pragma("foreign_keys = ON");
  }
  return counts;
}

/** Row counts of the user's main tables. */
export function dataCounts(uid: string) {
  const count = (table: "accounts" | "transactions" | "categories" | "reminders" | "simulations" | "holdings") =>
    (db().$client.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(uid) as { n: number }).n;
  const snapshots = (
    db()
      .$client.prepare(
        "SELECT COUNT(*) AS n FROM balance_snapshots s JOIN accounts a ON a.id = s.account_id WHERE a.user_id = ?",
      )
      .get(uid) as { n: number }
  ).n;
  return {
    accounts: count("accounts"),
    balance_snapshots: snapshots,
    holdings: count("holdings"),
    transactions: count("transactions"),
    categories: count("categories"),
    reminders: count("reminders"),
    simulations: count("simulations"),
  };
}

/** How many transactions each category holds (for delete warnings). */
export function transactionCountsByCategory(uid: string): Record<number, number> {
  const rows = db()
    .select({ id: transactions.categoryId, n: sql<number>`count(*)` })
    .from(transactions)
    .where(eq(transactions.userId, uid))
    .groupBy(transactions.categoryId)
    .all();
  const out: Record<number, number> = {};
  for (const r of rows) if (r.id !== null) out[r.id] = r.n;
  return out;
}

export function uncategorizedCount(uid: string): number {
  return (
    db()
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(and(eq(transactions.userId, uid), isNull(transactions.categoryId)))
      .get()?.n ?? 0
  );
}
