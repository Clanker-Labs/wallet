import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { createAccount, getAccount, listAccounts, listShares, recordBalance, shareAccount, unshareAccount } from "@/server/services/accounts";
import { netWorthOn } from "@/server/services/networth";
import { createUser } from "@/server/services/users";
import { listChanges } from "@/server/services/audit";
import { addTransaction } from "@/server/services/transactions";

let alex: string;
let sam: string;
beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  alex = freshUser("Alex");
  sam = createUser("Sam").id;
});

describe("sharing with a partner", () => {
  it("shows a shared account in the partner's net worth at their share, and respects view vs edit", () => {
    const flat = createAccount(alex, { name: "Our flat", type: "real_estate", currency: "USD", ownershipPct: 50, initialBalance: 400_000 });
    createAccount(sam, { name: "Sam's cash", type: "checking", currency: "USD", initialBalance: 1_000 });
    shareAccount(alex, flat.id, sam, "view", 50);

    expect(netWorthOn(alex).netCents).toBe(200_000_00);
    expect(netWorthOn(sam).netCents).toBe(200_000_00 + 1_000_00);
    const seen = listAccounts(sam).find((a) => a.id === flat.id)!;
    expect(seen).toMatchObject({ sharedBy: "Alex", shareRole: "view", ownershipPct: 50, ownedCents: 200_000_00 });
    expect(getAccount(sam, flat.id).snapshots).toHaveLength(1);
    expect(() => recordBalance(sam, { accountId: flat.id, balance: 410_000 })).toThrow(/to view, not to edit/);
    // Shared balances, private transactions: Sam can't put a transaction on it.
    expect(() => addTransaction(sam, { amount: -1, accountId: flat.id, description: "x" })).toThrow();

    shareAccount(alex, flat.id, sam, "edit", 50);
    recordBalance(sam, { accountId: flat.id, balance: 410_000 });
    expect(netWorthOn(alex).netCents).toBe(205_000_00);
    // In Alex's log, done by Sam.
    expect(listChanges(alex)[0]).toMatchObject({ entity: "balance", action: "record", actorName: "Sam" });
    expect(listShares(alex, flat.id)).toEqual([{ userId: sam, name: "Sam", role: "edit", sharePct: 50 }]);

    unshareAccount(alex, flat.id, sam);
    expect(listAccounts(sam).map((a) => a.name)).toEqual(["Sam's cash"]);
    expect(() => shareAccount(sam, flat.id, alex, "view", 50)).toThrow(); // not Sam's to share
  });

  it("logs what changed", () => {
    const a = createAccount(alex, { name: "Checking", type: "checking", initialBalance: 10 });
    addTransaction(alex, { amount: -5, description: "Coffee" });
    const log = listChanges(alex);
    expect(log.map((c) => `${c.entity}:${c.action}`)).toEqual(expect.arrayContaining(["account:create", "balance:record", "transaction:add"]));
    expect(listChanges(sam)).toEqual([]);
    void a;
  });
});
