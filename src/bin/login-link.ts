/**
 * Print a one-time sign-in link (15 min) for an account — first login of a
 * seeded/demo account, or recovery when every passkey is lost.
 *
 *   npm run auth:link                 # the owner
 *   npm run auth:link -- --user <id>  # a specific user
 *   npm run auth:link -- --list       # list users
 */
import { db } from "@/server/db/client";
import { createMagicLink } from "@/server/services/magic-link";
import { defaultUser, getUser, listUsers } from "@/server/services/users";

db();
const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const u of listUsers()) console.log(`${u.id}  ${u.role.padEnd(6)}  ${u.name}`);
  process.exit(0);
}
const idx = args.indexOf("--user");
const user = idx >= 0 ? getUser(args[idx + 1]) : defaultUser();
if (!user) {
  console.error("No such user. Use --list to see users.");
  process.exit(1);
}
const { code } = createMagicLink(user.id);
const base = (process.env.WALLET_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, "");
console.log(`Sign in as ${user.name} (valid 15 min, single use):\n${base}/api/auth/magic?code=${code}`);
console.log("Then add a passkey in Settings → Security.");
