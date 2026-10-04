/** Apply database migrations (also done automatically on first use). */
import { db, dbPath } from "@/server/db/client";

db();
console.log(`Database ready at ${dbPath()}`);
