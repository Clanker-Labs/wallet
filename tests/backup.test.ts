import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { createAccount, listAccounts, recordBalance } from "@/server/services/accounts";
import { addTransaction, listTransactions } from "@/server/services/transactions";
import { createBackup, listBackups, prune, restoreBackup } from "@/server/services/backup";
import { exportAll, importExport } from "@/server/services/export";
import { createUser } from "@/server/services/users";
import { saveGoal, listGoals } from "@/server/services/goals";
import { createRecurring, listRecurring } from "@/server/services/recurring";
import { db } from "@/server/db/client";

let dir: string;
beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-backup-"));
  process.env.WALLET_BACKUP_DIR = dir;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.WALLET_BACKUP_DIR;
});

describe("backups", () => {
  it("restores a backup, keeping a safety copy and the signed-in sessions", () => {
    const uid = freshUser();
    const a = createAccount(uid, { name: "Checking", type: "checking", initialBalance: 100 });
    const b = createBackup("manual");
    recordBalance(uid, { accountId: a.id, balance: 999 });
    createAccount(uid, { name: "Later", type: "savings" });
    db().$client.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('s1', ?, ?, ?)").run(uid, Date.now() + 1e9, Date.now());

    const r = restoreBackup(b.name);
    expect(r.safety).toMatch(/before-restore/);
    expect(listAccounts(uid).map((x) => x.name)).toEqual(["Checking"]);
    expect(listAccounts(uid)[0].balanceCents).toBe(100_00);
    expect(db().$client.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    expect(listBackups().map((x) => x.reason).sort()).toEqual(["before-restore", "manual"]);
  });

  it("refuses a file that isn't a wallet database", () => {
    freshUser();
    fs.writeFileSync(path.join(dir, "wallet-20260101-000000-manual.db"), "nope");
    expect(() => restoreBackup("wallet-20260101-000000-manual.db")).toThrow();
    expect(() => restoreBackup("../etc/passwd")).toThrow(/Not a backup/);
  });

  it("keeps 14 recent backups and a weekly one before that", () => {
    freshUser();
    for (let i = 0; i < 40; i++) {
      vi.setSystemTime(new Date(Date.parse("2026-08-01T03:00:00Z") + i * 86_400_000));
      const f = createBackup("daily");
      fs.utimesSync(path.join(dir, f.name), new Date(), new Date());
    }
    prune();
    const left = listBackups();
    expect(left.length).toBeGreaterThanOrEqual(14);
    expect(left.length).toBeLessThanOrEqual(14 + 8);
  });
});

describe("export and import", () => {
  it("moves a whole wallet into another user's empty one, references included", () => {
    const uid = freshUser();
    const acc = createAccount(uid, { name: "Checking", type: "checking", initialBalance: 1_000 });
    addTransaction(uid, { date: "2026-10-01", amount: -20, accountId: acc.id, description: "Coffee" });
    saveGoal(uid, { name: "Trip", target: 2_000, accountIds: [acc.id] });
    createRecurring(uid, { name: "Rent", pattern: "loyer", accountId: acc.id, amount: -1_500, cadence: "monthly", nextDate: "2026-11-05" });
    const dump = JSON.parse(JSON.stringify(exportAll(uid)));
    expect(dump.format).toBe(3);

    const bob = createUser("Bob").id;
    const counts = importExport(bob, dump);
    expect(counts).toMatchObject({ accounts: 1, transactions: 1, balance_snapshots: 1, goals: 1, recurring: 1 });
    const [bobAcc] = listAccounts(bob);
    expect(bobAcc.id).not.toBe(acc.id);
    expect(bobAcc.balanceCents).toBe(1_000_00);
    expect(listTransactions(bob).rows[0]).toMatchObject({ accountId: bobAcc.id, description: "Coffee" });
    expect(listGoals(bob)[0].accountIds).toEqual([bobAcc.id]);
    expect(listRecurring(bob)[0].accountId).toBe(bobAcc.id);
    expect(() => importExport(bob, dump)).toThrow(/empty wallet/);
  });
});
