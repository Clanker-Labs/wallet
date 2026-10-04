import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import { DEFAULT_CATEGORIES } from "@/lib/domain";

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function dbPath(): string {
  return process.env.WALLET_DB_PATH || path.join(process.cwd(), "data", "wallet.db");
}

function migrationsFolder(): string {
  const candidates = [
    process.env.WALLET_MIGRATIONS_DIR,
    path.join(process.cwd(), "drizzle"),
  ].filter(Boolean) as string[];
  const found = candidates.find((p) => fs.existsSync(path.join(p, "meta", "_journal.json")));
  if (!found) throw new Error(`Drizzle migrations not found (looked in ${candidates.join(", ")})`);
  return found;
}

/** Open a database, apply migrations and seed default categories. */
export function createDb(file = dbPath()): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema }) as DB;
  migrate(db, { migrationsFolder: migrationsFolder() });
  seedDefaults(db);
  return db;
}

function seedDefaults(db: DB) {
  const count = db.$client.prepare("SELECT COUNT(*) AS n FROM categories").get() as { n: number };
  if (count.n > 0) return;
  db.insert(schema.categories)
    .values(DEFAULT_CATEGORIES.map((c, idx) => ({ ...c, sortOrder: idx })))
    .run();
}

// One connection per process; survive Next.js dev hot reloads.
const globalForDb = globalThis as unknown as { __walletDb?: DB };

export function db(): DB {
  if (!globalForDb.__walletDb) globalForDb.__walletDb = createDb();
  return globalForDb.__walletDb;
}

/** Test hook: swap the process-wide database. */
export function setDbForTests(next: DB) {
  globalForDb.__walletDb = next;
}

/**
 * A separate read-only connection for agent-authored SQL. SQLite enforces
 * read-only at the connection level, so even a crafted statement cannot write.
 */
const globalForRo = globalThis as unknown as { __walletRo?: Database.Database };

export function readonlyConnection(): Database.Database {
  const file = dbPath();
  if (file === ":memory:") return db().$client; // tests: guarded by statement check
  if (!globalForRo.__walletRo) {
    db(); // ensure the file exists and is migrated
    globalForRo.__walletRo = new Database(file, { readonly: true, fileMustExist: true });
    globalForRo.__walletRo.pragma("busy_timeout = 5000");
  }
  return globalForRo.__walletRo;
}
