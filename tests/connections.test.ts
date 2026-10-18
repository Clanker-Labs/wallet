import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { db } from "@/server/db/client";
import { createAccount, listAccounts } from "@/server/services/accounts";
import { listHoldings, upsertHolding } from "@/server/services/holdings";
import {
  createConnection,
  deleteConnection,
  listConnections,
  syncConnection,
  syncStaleConnections,
  updateConnectionCredentials,
} from "@/server/services/connections";
import { majorUnit, resetTrading212CachesForTests, toYahooSymbol } from "@/server/connectors/trading212";
import { runUserSql } from "@/server/agent/sql-sandbox";
import { TOOLS } from "@/server/agent/tools";

const TODAY = "2026-10-15";

interface FakeState {
  status?: number;
  cash: Record<string, number>;
  portfolio: Record<string, unknown>[];
}

/** Trading 212 answered locally; every request is recorded (method, path, auth). */
function fakeT212(state: FakeState) {
  const calls: { method: string; url: string; auth: string | null }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", url, auth: headers.get("authorization") });
    if (!url.includes("trading212.com")) return new Response("not found", { status: 404 });
    if (state.status) return new Response("{}", { status: state.status, headers: { "retry-after": "12" } });
    if (url.endsWith("/equity/account/info")) return Response.json({ id: 4242, currencyCode: "EUR" });
    if (url.endsWith("/equity/account/cash")) return Response.json(state.cash);
    if (url.endsWith("/equity/portfolio")) return Response.json(state.portfolio);
    if (url.endsWith("/equity/metadata/instruments")) {
      return Response.json([
        { ticker: "AAPL_US_EQ", name: "Apple", currencyCode: "USD", type: "STOCK" },
        { ticker: "VUSAl_EQ", name: "Vanguard S&P 500", currencyCode: "GBX", type: "ETF" },
        { ticker: "SAPd_EQ", name: "SAP", currencyCode: "EUR", type: "STOCK" },
      ]);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const CREDS = { apiKey: "key-123", apiSecret: "secret-456" };

let uid: string;
let state: FakeState;

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  uid = freshUser();
  resetTrading212CachesForTests();
  state = {
    cash: { free: 120.5, pieCash: 4.5, blocked: 0, total: 9999, invested: 0 },
    portfolio: [
      { ticker: "AAPL_US_EQ", quantity: 2, averagePrice: 150, currentPrice: 200 },
      { ticker: "VUSAl_EQ", quantity: 10, averagePrice: 7000, currentPrice: 8000 },
    ],
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Trading 212 ticker mapping", () => {
  it("maps venues to Yahoo symbols", () => {
    expect(toYahooSymbol("AAPL_US_EQ")).toBe("AAPL");
    expect(toYahooSymbol("BRK.B_US_EQ")).toBe("BRK-B");
    expect(toYahooSymbol("VUSAl_EQ")).toBe("VUSA.L");
    expect(toYahooSymbol("SAPd_EQ")).toBe("SAP.DE");
    expect(toYahooSymbol("not a ticker")).toBeNull();
  });

  it("normalizes pence to pounds", () => {
    expect(majorUnit("GBX")).toEqual(["GBP", 100]);
    expect(majorUnit("usd")).toEqual(["USD", 1]);
  });
});

describe("brokerage connections", () => {
  it("creates an account and mirrors positions + cash into it", async () => {
    const t212 = fakeT212(state);
    const { connection, sync } = await createConnection(
      uid,
      { provider: "trading212", environment: "live", credentials: CREDS },
      { fetchImpl: t212.impl, fetchPrices: false },
    );
    expect(sync).toMatchObject({ ok: true, positions: 2, added: 2, removed: 0, cash: 125, currency: "EUR" });
    expect(connection).toMatchObject({ providerName: "Trading 212", accountName: "Trading 212", accountCurrency: "EUR", holdingsCount: 2 });

    // HTTP Basic, key as user, secret as password.
    expect(t212.calls[0].auth).toBe("Basic " + Buffer.from("key-123:secret-456").toString("base64"));
    expect(t212.calls[0].url).toBe("https://live.trading212.com/api/v0/equity/account/info");

    const rows = listHoldings(uid, { accountId: connection.accountId });
    const vusa = rows.find((h) => h.symbol === "VUSA.L")!;
    // Pence → pounds, and today's price is the broker's own.
    expect(vusa).toMatchObject({ currency: "GBP", costBasis: 70, unitPrice: 80, assetType: "etf", name: "Vanguard S&P 500" });
    expect(rows.find((h) => h.symbol === "AAPL")).toMatchObject({ currency: "USD", unitPrice: 200, costBasis: 150 });
    expect(rows.find((h) => h.assetType === "cash")).toMatchObject({ quantity: 125, currency: "EUR", unitPrice: 1 });
  });

  it("never calls anything but GET", async () => {
    const t212 = fakeT212(state);
    const { connection } = await createConnection(uid, { provider: "trading212", environment: "demo", credentials: CREDS }, { fetchImpl: t212.impl, fetchPrices: false });
    await syncConnection(uid, connection.id, { fetchImpl: t212.impl, force: true, fetchPrices: false });
    expect(t212.calls.length).toBeGreaterThan(0);
    expect(new Set(t212.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
    expect(t212.calls.every((c) => c.url.startsWith("https://demo.trading212.com/"))).toBe(true);
  });

  it("keeps practice accounts out of net worth", async () => {
    const t212 = fakeT212(state);
    const { connection } = await createConnection(uid, { provider: "trading212", environment: "demo", credentials: CREDS }, { fetchImpl: t212.impl, fetchPrices: false });
    const account = listAccounts(uid).find((a) => a.id === connection.accountId)!;
    expect(account).toMatchObject({ name: "Trading 212 (practice)", includeInNetWorth: false, type: "brokerage" });
  });

  it("adds new positions, removes sold ones and leaves manual holdings alone", async () => {
    const t212 = fakeT212(state);
    const { connection } = await createConnection(uid, { provider: "trading212", environment: "live", credentials: CREDS }, { fetchImpl: t212.impl, fetchPrices: false });
    await upsertHolding(uid, { accountId: connection.accountId, name: "Gold coin", assetType: "commodity", quantity: 1, manualPrice: 2000 }, { fetchPrice: false });

    state.portfolio = [
      { ticker: "AAPL_US_EQ", quantity: 3, averagePrice: 160, currentPrice: 210 },
      { ticker: "SAPd_EQ", quantity: 1, averagePrice: 100, currentPrice: 120 },
    ];
    state.cash = { free: 10, pieCash: 0, blocked: 0 };
    const r = await syncConnection(uid, connection.id, { fetchImpl: t212.impl, force: true, fetchPrices: false });
    expect(r).toMatchObject({ ok: true, positions: 2, added: 1, removed: 1, cash: 10 });

    const names = listHoldings(uid, { accountId: connection.accountId }).map((h) => h.name).sort();
    expect(names).toEqual(["Apple", "Cash", "Gold coin", "SAP"]);
    expect(listHoldings(uid).find((h) => h.symbol === "AAPL")!.quantity).toBe(3);
  });

  it("records broker failures on the connection instead of throwing", async () => {
    const t212 = fakeT212(state);
    const { connection } = await createConnection(uid, { provider: "trading212", environment: "live", credentials: CREDS }, { fetchImpl: t212.impl, fetchPrices: false });

    state.status = 401;
    resetTrading212CachesForTests();
    const r = await syncConnection(uid, connection.id, { fetchImpl: t212.impl, force: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/401/);
    expect(listConnections(uid)[0]).toMatchObject({ lastSyncOk: false, lastError: expect.stringMatching(/rejected/) });
    // Positions survive a failed sync.
    expect(listHoldings(uid, { accountId: connection.accountId })).toHaveLength(3);

    state.status = 429;
    const limited = await syncConnection(uid, connection.id, { fetchImpl: t212.impl, force: true });
    expect(limited.error).toMatch(/rate limit.*12 s/);
  });

  it("saves nothing when the broker rejects the credentials", async () => {
    state.status = 401;
    const t212 = fakeT212(state);
    await expect(
      createConnection(uid, { provider: "trading212", environment: "live", credentials: CREDS }, { fetchImpl: t212.impl }),
    ).rejects.toThrow(/401/);
    expect(listConnections(uid)).toHaveLength(0);
    expect(listAccounts(uid)).toHaveLength(0);
  });

  it("refuses the same broker account twice, and an account already synced", async () => {
    const t212 = fakeT212(state);
    const { connection } = await createConnection(uid, { provider: "trading212", environment: "live", credentials: CREDS }, { fetchImpl: t212.impl, fetchPrices: false });
    await expect(
      createConnection(uid, { provider: "trading212", environment: "live", credentials: CREDS }, { fetchImpl: t212.impl }),
    ).rejects.toThrow(/already connected/);
    await expect(
      createConnection(uid, { provider: "trading212", environment: "demo", credentials: CREDS, accountId: connection.accountId }, { fetchImpl: t212.impl }),
    ).rejects.toThrow(/already synced/);
  });

  it("syncs into an existing account", async () => {
    const existing = createAccount(uid, { name: "My T212", type: "brokerage", currency: "EUR" });
    const t212 = fakeT212(state);
    const { connection } = await createConnection(uid, { provider: "trading212", environment: "live", credentials: CREDS, accountId: existing.id }, { fetchImpl: t212.impl, fetchPrices: false });
    expect(connection.accountId).toBe(existing.id);
    expect(listAccounts(uid)).toHaveLength(1);
  });

  it("stores credentials encrypted and keeps them out of the agent's SQL", async () => {
    const t212 = fakeT212(state);
    await createConnection(uid, { provider: "trading212", environment: "live", credentials: CREDS }, { fetchImpl: t212.impl, fetchPrices: false });
    const raw = db().$client.prepare("SELECT credentials FROM broker_connections").get() as { credentials: string };
    expect(raw.credentials).toMatch(/^v1:/);
    expect(raw.credentials).not.toContain("secret-456");
    expect(raw.credentials).not.toContain("key-123");

    expect(() => runUserSql(uid, "SELECT * FROM broker_connections")).toThrow(/no such table/);
    expect(JSON.stringify(listConnections(uid))).not.toContain("secret-456");
    // The agent tool view is the same safe view.
    const list = TOOLS.find((t) => t.name === "list_connections")!;
    expect(JSON.stringify(await list.run({} as never, { userId: uid }))).not.toContain("secret");
  });

  it("rotates credentials but refuses a different broker account", async () => {
    const t212 = fakeT212(state);
    const { connection } = await createConnection(uid, { provider: "trading212", environment: "live", credentials: CREDS }, { fetchImpl: t212.impl, fetchPrices: false });
    const r = await updateConnectionCredentials(uid, connection.id, { apiKey: "new-key", apiSecret: "new-secret" }, { fetchImpl: t212.impl, fetchPrices: false });
    expect(r.ok).toBe(true);
    await syncConnection(uid, connection.id, { fetchImpl: t212.impl, force: true, fetchPrices: false });
    expect(t212.calls.at(-1)!.auth).toBe("Basic " + Buffer.from("new-key:new-secret").toString("base64"));

    db().$client.prepare("UPDATE broker_connections SET external_account_id = '999'").run();
    await expect(
      updateConnectionCredentials(uid, connection.id, { apiKey: "other", apiSecret: "other" }, { fetchImpl: t212.impl }),
    ).rejects.toThrow(/different/);
  });

  it("disconnecting keeps the positions as manual holdings", async () => {
    const t212 = fakeT212(state);
    const { connection } = await createConnection(uid, { provider: "trading212", environment: "live", credentials: CREDS }, { fetchImpl: t212.impl, fetchPrices: false });
    deleteConnection(uid, connection.id);
    expect(listConnections(uid)).toHaveLength(0);
    const rows = listHoldings(uid, { accountId: connection.accountId });
    expect(rows).toHaveLength(3);
    expect(rows.every((h) => h.connectionId === null && h.externalId === null)).toBe(true);
  });

  it("background sync only touches stale connections", async () => {
    const t212 = fakeT212(state);
    await createConnection(uid, { provider: "trading212", environment: "live", credentials: CREDS }, { fetchImpl: t212.impl, fetchPrices: false });
    const before = t212.calls.length;
    expect((await syncStaleConnections({ fetchImpl: t212.impl })).log).toEqual([]);
    expect(t212.calls.length).toBe(before);

    vi.setSystemTime(new Date(`${TODAY}T13:00:00Z`));
    const { log } = await syncStaleConnections({ fetchImpl: t212.impl });
    expect(log).toEqual([expect.stringMatching(/synced: 2 positions/)]);
  });

  it("connections are private to their user", async () => {
    const t212 = fakeT212(state);
    const { connection } = await createConnection(uid, { provider: "trading212", environment: "live", credentials: CREDS }, { fetchImpl: t212.impl, fetchPrices: false });
    const { createUser } = await import("@/server/services/users");
    const other = createUser("Other").id;
    expect(listConnections(other)).toHaveLength(0);
    await expect(syncConnection(other, connection.id, { fetchImpl: t212.impl })).rejects.toThrow(/not found/);
    expect(() => deleteConnection(other, connection.id)).toThrow(/not found/);
  });
});
