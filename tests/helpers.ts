import { createDb, setDbForTests, type DB } from "@/server/db/client";
import { createUser } from "@/server/services/users";

/** Fresh in-memory database (migrated) for each test. */
export function freshDb(): DB {
  const db = createDb(":memory:");
  setDbForTests(db);
  return db;
}

/** Fresh database with one user (owner, default categories); returns their id. */
export function freshUser(name = "Test"): string {
  freshDb();
  return createUser(name).id;
}
