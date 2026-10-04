import { createDb, setDbForTests, type DB } from "@/server/db/client";

/** Fresh in-memory database (migrated + default categories) for each test. */
export function freshDb(): DB {
  const db = createDb(":memory:");
  setDbForTests(db);
  return db;
}
