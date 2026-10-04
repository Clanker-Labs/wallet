import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshUser } from "./helpers";
import { createAccount, getAccount, listAccounts, recordBalance } from "@/server/services/accounts";
import { netWorthOn } from "@/server/services/networth";
import { addTransaction, categorizeTransactions, listTransactions } from "@/server/services/transactions";
import { findCategory } from "@/server/services/categories";
import { budgetStatus } from "@/server/services/budgets";
import { setSetting } from "@/server/services/settings";
import { createUser, defaultUser, listUsers } from "@/server/services/users";
import { currenciesInUse, ensureFreshRates, fetchRates, fxConverter, parseCurrencyApi, storeRates } from "@/server/services/fx";
import { parseYahooChart, storePrices, yahooTypeToHolding } from "@/server/services/prices";
import { deleteHolding, holdingsSummary, listHoldings, upsertHolding } from "@/server/services/holdings";
import { getUpload, saveUpload, uploadKind, uploadText } from "@/server/services/uploads";
import { createMagicLink, redeemMagicLink } from "@/server/services/magic-link";
import { createTelegramLinkCode, redeemTelegramLinkCode } from "@/server/services/telegram-link";
import { callTool } from "@/server/agent/tools";
import { attachmentBlocks } from "@/server/agent/attachments";

const TODAY = "2026-10-15";

/** EUR = 0.9 per USD, GBP = 0.75 per USD, BTC = 1/60000 per USD. */
function seedRates(date = TODAY) {
  storeRates({ date, perUsd: { USD: 1, EUR: 0.9, GBP: 0.75, BTC: 1 / 60_000 } });
}

let uid: string;

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  uid = freshUser("Alex");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("users", () => {
  it("makes the first user the owner with USD defaults and their own categories", () => {
    const bob = createUser("Bob");
    expect(listUsers().map((u) => [u.name, u.role])).toEqual([
      ["Alex", "owner"],
      ["Bob", "member"],
    ]);
    expect(defaultUser().id).toBe(uid);
    expect(findCategory(uid, "groceries")).toBeDefined();
    expect(findCategory(bob.id, "groceries")!.id).not.toBe(findCategory(uid, "groceries")!.id);
    expect(netWorthOn(uid).currency).toBe("USD");
  });

  it("keeps every user's data separate, including through agent tools", async () => {
    const bob = createUser("Bob").id;
    const mine = createAccount(uid, { name: "Alex checking", type: "checking", initialBalance: 1_000 });
    createAccount(bob, { name: "Bob checking", type: "checking", initialBalance: 50 });
    const tx = addTransaction(uid, { amount: -20, description: "Alex lunch" });

    expect(listAccounts(bob).map((a) => a.name)).toEqual(["Bob checking"]);
    expect(netWorthOn(bob).netCents).toBe(50_00);
    expect(() => getAccount(bob, mine.id)).toThrow();
    expect(() => recordBalance(bob, { accountId: mine.id, balance: 0 })).toThrow();
    expect(listTransactions(bob).total).toBe(0);
    // Bob can't touch Alex's transaction, nor use Alex's categories.
    expect(categorizeTransactions(bob, [tx.id], findCategory(bob, "groceries")!.id).updated).toBe(0);
    expect(() => categorizeTransactions(bob, [tx.id], findCategory(uid, "groceries")!.id)).toThrow();

    const bobCtx = { userId: bob };
    expect((await callTool(bobCtx, "get_account", { id: mine.id })).ok).toBe(false);
    const sql = JSON.parse((await callTool(bobCtx, "query_sql", { sql: "SELECT name FROM accounts" })).content);
    expect(sql.rows).toEqual([{ name: "Bob checking" }]);
    const txSql = JSON.parse((await callTool(bobCtx, "query_sql", { sql: "SELECT count(*) AS n FROM transactions" })).content);
    expect(txSql.rows[0].n).toBe(0);

    // Writes invalidate the per-user SQL snapshot.
    await callTool(bobCtx, "add_transaction", { amount: -5, description: "Bob coffee" });
    const after = JSON.parse((await callTool(bobCtx, "query_sql", { sql: "SELECT description FROM transactions" })).content);
    expect(after.rows).toEqual([{ description: "Bob coffee" }]);
  });
});

describe("exchange rates", () => {
  it("parses currency-api payloads and falls back between free sources", async () => {
    expect(parseCurrencyApi({ date: "2026-10-14", usd: { eur: 0.9, gbp: 0.75, bad: "x" } })).toEqual({
      date: "2026-10-14",
      perUsd: { EUR: 0.9, GBP: 0.75, USD: 1 },
    });
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      if (url.includes("frankfurter")) {
        return Response.json({ date: "2026-10-14", rates: { EUR: 0.9, GBP: 0.75, JPY: 150, CHF: 0.8, CAD: 1.4 } });
      }
      return new Response("nope", { status: 503 });
    }) as typeof fetch;
    const rates = await fetchRates("latest", fakeFetch);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain("currency-api");
    expect(rates.perUsd).toMatchObject({ USD: 1, EUR: 0.9, JPY: 150 });

    const failing = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchRates("latest", failing)).rejects.toThrow(/Could not fetch exchange rates/);
  });

  it("converts through USD using the latest rate on or before a date", () => {
    storeRates({ date: "2026-01-01", perUsd: { EUR: 0.8 } });
    seedRates();
    const fx = fxConverter();
    expect(fx.convertCents(100_00, "EUR", "USD", TODAY)).toBe(111_11);
    expect(fx.convertCents(90_00, "EUR", "GBP", TODAY)).toBe(75_00);
    expect(fx.convertCents(100_00, "EUR", "USD", "2026-06-01")).toBe(125_00);
    expect(fx.convertCents(100_00, "EUR", "USD", "2025-01-01")).toBe(125_00); // before any data: earliest known
    expect(fx.convert(0.5, "BTC", "USD", TODAY)).toBeCloseTo(30_000);
    expect(fx.convertCents(5_00, "XYZ", "USD", TODAY)).toBe(0);
    expect([...fx.missing]).toEqual(["XYZ"]);
  });

  it("values foreign accounts and transactions in the base currency", () => {
    seedRates();
    createAccount(uid, { name: "Compte courant", type: "checking", currency: "EUR", initialBalance: 900 });
    createAccount(uid, { name: "Chase", type: "checking", initialBalance: 100 });
    const nw = netWorthOn(uid);
    expect(nw.netCents).toBe(1_100_00);
    expect(nw.missingFx).toEqual([]);
    const eur = listAccounts(uid).find((a) => a.currency === "EUR")!;
    expect(eur.balanceCents).toBe(900_00); // native
    expect(eur.baseOwnedCents).toBe(1_000_00);

    addTransaction(uid, { date: "2026-10-02", amount: -90, currency: "EUR", description: "Paris dinner", categoryId: findCategory(uid, "restaurants")!.id });
    addTransaction(uid, { date: "2026-10-03", amount: -10, description: "NYC coffee", categoryId: findCategory(uid, "restaurants")!.id });
    const row = listTransactions(uid).rows.find((r) => r.currency === "EUR")!;
    expect(row.amountCents).toBe(-90_00);
    expect(row.baseAmountCents).toBe(-100_00);
    expect(budgetStatus(uid, "2026-10").expensesCents).toBe(110_00);

    setSetting(uid, "currency", "EUR");
    expect(netWorthOn(uid).netCents).toBe(990_00);
    expect(netWorthOn(uid).currency).toBe("EUR");
  });

  it("reports how a forced refresh went and which currencies are in use", async () => {
    const down = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const failed = await ensureFreshRates({ force: true, fetchImpl: down });
    expect(failed).toMatchObject({ status: "failed", date: null });
    expect(failed.error).toMatch(/HTTP 503/);
    const up = (async () => Response.json({ date: TODAY, usd: { eur: 0.9, gbp: 0.75, jpy: 150, chf: 0.8 } })) as unknown as typeof fetch;
    expect(await ensureFreshRates({ force: true, fetchImpl: up })).toEqual({ status: "updated", date: TODAY });
    expect(await ensureFreshRates()).toEqual({ status: "fresh", date: TODAY });

    const eur = createAccount(uid, { name: "Compte", type: "checking", currency: "EUR" });
    createAccount(uid, { name: "Chase", type: "checking" });
    addTransaction(uid, { amount: -5, currency: "GBP", description: "Tea", accountId: eur.id });
    await upsertHolding(uid, { accountId: eur.id, symbol: "VOD.L", quantity: 1, currency: "GBP" }, { fetchPrice: false });
    createAccount(createUser("Bob").id, { name: "Bob", type: "checking", currency: "JPY" });
    expect(currenciesInUse(uid)).toEqual([
      { currency: "EUR", usedIn: ["accounts"] },
      { currency: "GBP", usedIn: ["holdings", "transactions"] },
      { currency: "USD", usedIn: ["accounts"] },
    ]);
  });

  it("tells tool callers which currency amounts are in", async () => {
    setSetting(uid, "currency", "EUR");
    const ctx = { userId: uid };
    const spending = JSON.parse((await callTool(ctx, "get_spending_by_category", {})).content);
    expect(spending).toMatchObject({ baseCurrency: "EUR", items: expect.any(Array) });
    expect(JSON.parse((await callTool(ctx, "get_overview", {})).content).baseCurrency).toBe("EUR");
    expect(JSON.parse((await callTool(ctx, "get_net_worth", {})).content).currency).toBe("EUR"); // already labelled
    const sim = JSON.parse((await callTool(ctx, "borrowing_capacity", { monthlyNetIncome: 5000 })).content);
    expect(sim).not.toHaveProperty("baseCurrency"); // calculators work in whatever unit they're given
  });

  it("flags currencies without a rate instead of mixing them", () => {
    createAccount(uid, { name: "Swiss", type: "savings", currency: "CHF", initialBalance: 500 });
    const nw = netWorthOn(uid);
    expect(nw.netCents).toBe(0);
    expect(nw.missingFx).toEqual(["CHF"]);
  });
});

describe("market prices & holdings", () => {
  it("parses Yahoo charts, including pence-quoted London listings and the live price", () => {
    const series = parseYahooChart({
      chart: {
        result: [
          {
            meta: { symbol: "VUSA.L", currency: "GBp", longName: "Vanguard S&P 500", instrumentType: "ETF", gmtoffset: 3600, regularMarketPrice: 9_000, regularMarketTime: 1_791_820_800 },
            timestamp: [1_791_561_600, 1_791_648_000, 1_791_734_400],
            indicators: { quote: [{ close: [8_800, null, 8_950] }] },
          },
        ],
      },
    })!;
    expect(series).toMatchObject({ symbol: "VUSA.L", currency: "GBP", name: "Vanguard S&P 500", assetType: "etf" });
    expect(series.closes.map((c) => c.close)).toEqual([88, 89.5, 90]);
    expect(parseYahooChart({ chart: { result: [] } })).toBeNull();
    expect(yahooTypeToHolding("CRYPTOCURRENCY")).toBe("crypto");
    expect(yahooTypeToHolding("FUTURE")).toBe("commodity");
    expect(yahooTypeToHolding("MUTUALFUND")).toBe("fund");
  });

  it("values holdings live in their quote currency and converts to the base", async () => {
    seedRates();
    storePrices({ symbol: "CW8.PA", name: "MSCI World", currency: "EUR", assetType: "etf", closes: [{ date: "2026-10-14", close: 500 }] });
    storePrices({ symbol: "BTC-USD", name: "Bitcoin", currency: "USD", assetType: "crypto", closes: [{ date: "2026-10-15", close: 60_000 }] });
    const pea = createAccount(uid, { name: "PEA", type: "pea", currency: "EUR" });
    const wallet = createAccount(uid, { name: "Coinbase", type: "crypto" });
    const vault = createAccount(uid, { name: "Gold coins", type: "precious_metals" });

    await upsertHolding(uid, { accountId: pea.id, symbol: "cw8.pa", assetType: "etf", quantity: 9, costBasis: 400 }, { fetchPrice: false });
    await upsertHolding(uid, { accountId: wallet.id, symbol: "BTC-USD", assetType: "crypto", quantity: 0.5 }, { fetchPrice: false });
    const coins = await upsertHolding(uid, { accountId: vault.id, name: "Krugerrand", assetType: "commodity", quantity: 2, manualPrice: 2_500 }, { fetchPrice: false });

    const [etf] = listHoldings(uid, { accountId: pea.id });
    expect(etf).toMatchObject({ symbol: "CW8.PA", currency: "EUR", unitPrice: 500, valueCents: 4_500_00, gainCents: 900_00, priceSource: "market" });
    expect(etf.baseValueCents).toBe(5_000_00);

    const nw = netWorthOn(uid);
    expect(nw.byClassCents.investments).toBe(5_000_00);
    expect(nw.byClassCents.crypto).toBe(30_000_00);
    expect(nw.byClassCents.commodities).toBe(5_000_00);
    expect(nw.missingPrices).toEqual([]);
    expect(listAccounts(uid).find((a) => a.id === pea.id)).toMatchObject({ valuedByHoldings: true, balanceCents: 4_500_00 });

    const summary = holdingsSummary(uid);
    expect(summary.totalCents).toBe(40_000_00);
    expect(summary.byType.map((t) => [t.type, t.cents])).toEqual(
      expect.arrayContaining([["crypto", 30_000_00], ["etf", 5_000_00], ["commodity", 5_000_00]]),
    );
    expect(summary.byType[0].type).toBe("crypto"); // largest first

    // Same symbol in the same account updates the position instead of duplicating it.
    await upsertHolding(uid, { accountId: pea.id, symbol: "CW8.PA", assetType: "etf", quantity: 10 }, { fetchPrice: false });
    expect(listHoldings(uid, { accountId: pea.id })).toHaveLength(1);
    expect(listHoldings(uid, { accountId: pea.id })[0].costBasis).toBe(400);

    // Removing the last holding leaves a zero balance rather than a stale one.
    deleteHolding(uid, coins.holding.id);
    expect(listAccounts(uid).find((a) => a.id === vault.id)!.balanceCents).toBe(0);
  });

  it("reports holdings without any price", async () => {
    const brokerage = createAccount(uid, { name: "Brokerage", type: "brokerage" });
    await upsertHolding(uid, { accountId: brokerage.id, symbol: "NOPE", quantity: 3 }, { fetchPrice: false });
    expect(netWorthOn(uid).missingPrices).toEqual(["NOPE"]);
  });
});

describe("uploads & agent import", () => {
  const csv = "Date;Libellé;Montant\n01/10/2026;CB CAFÉ DE FLORE;-12,50\n02/10/2026;VIR SALAIRE;2 500,00\n";

  it("detects kinds and decodes legacy encodings", async () => {
    expect(uploadKind("text/csv", "a.csv")).toBe("csv");
    expect(uploadKind("", "statement.PDF")).toBe("pdf");
    expect(uploadKind("image/png", "x.png")).toBe("image");
    expect(uploadKind("application/vnd.ms-excel", "export.csv")).toBe("csv");
    expect(uploadKind("audio/mpeg", "song.mp3")).toBeNull();
    const latin1 = saveUpload(uid, { filename: "bank.csv", mimeType: "text/csv", data: Buffer.from(csv, "latin1") });
    expect((await uploadText(latin1)).text).toContain("CAFÉ DE FLORE");
    expect(() => saveUpload(uid, { filename: "song.mp3", mimeType: "audio/mpeg", data: Buffer.from("x") })).toThrow();
    const other = createUser("Bob").id;
    expect(() => getUpload(other, latin1.id)).toThrow();
  });

  it("imports a CSV upload through the agent tool, idempotently, in the account's currency", async () => {
    const ctx = { userId: uid };
    const account = createAccount(uid, { name: "Compte courant", type: "checking", currency: "EUR" });
    const upload = saveUpload(uid, { filename: "octobre.csv", mimeType: "text/csv", data: Buffer.from(csv) });

    const preview = JSON.parse((await callTool(ctx, "import_csv_upload", { uploadId: upload.id, dryRun: true })).content);
    expect(preview).toMatchObject({ imported: false, parsedRows: 2, mapping: { date: "Date", description: "Libellé", amount: "Montant" } });
    expect(listTransactions(uid).total).toBe(0);

    const first = JSON.parse((await callTool(ctx, "import_csv_upload", { uploadId: upload.id, accountId: account.id })).content);
    expect(first).toMatchObject({ imported: true, inserted: 2, duplicates: 0 });
    const again = JSON.parse((await callTool(ctx, "import_csv_upload", { uploadId: upload.id, accountId: account.id })).content);
    expect(again).toMatchObject({ inserted: 0, duplicates: 2 });

    const rows = listTransactions(uid).rows;
    expect(rows.map((r) => [r.description, r.amountCents, r.currency, r.source])).toEqual([
      ["VIR SALAIRE", 2_500_00, "EUR", "agent"],
      ["CB CAFÉ DE FLORE", -12_50, "EUR", "agent"],
    ]);

    // Another user can't read it.
    expect((await callTool({ userId: createUser("Bob").id }, "read_upload", { uploadId: upload.id })).ok).toBe(false);
  });

  it("imports rows the agent extracted itself (e.g. from a PDF), mapping category names", async () => {
    const res = JSON.parse(
      (
        await callTool({ userId: uid }, "import_transactions", {
          currency: "GBP",
          rows: [
            { date: "2026-10-01", amount: -4.2, description: "Pret A Manger", category: "restaurants & bars" },
            { date: "2026-10-02", amount: -60, description: "Tesco", category: "Groceries", currency: "EUR" },
          ],
        })
      ).content,
    );
    expect(res.inserted).toBe(2);
    const rows = listTransactions(uid).rows;
    expect(rows.map((r) => [r.description, r.currency, r.categoryName])).toEqual([
      ["Tesco", "EUR", "Groceries"],
      ["Pret A Manger", "GBP", "Restaurants & bars"],
    ]);
  });

  it("attaches uploads to the model as document, image and text blocks", async () => {
    const pdf = saveUpload(uid, { filename: "releve.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4 fake") });
    const img = saveUpload(uid, { filename: "screen.png", mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    const sheet = saveUpload(uid, { filename: "bank.csv", mimeType: "text/csv", data: Buffer.from(csv) });
    const blocks = (await attachmentBlocks(uid, [pdf.id, img.id, sheet.id])) as { type: string; text?: string; source?: { media_type?: string } }[];
    expect(blocks.filter((b) => b.type === "document")[0].source!.media_type).toBe("application/pdf");
    expect(blocks.filter((b) => b.type === "image")[0].source!.media_type).toBe("image/png");
    const texts = blocks.filter((b) => b.type === "text").map((b) => b.text!).join("\n");
    expect(texts).toContain(pdf.id);
    expect(texts).toContain("CB CAFÉ DE FLORE");
    await expect(attachmentBlocks(createUser("Bob").id, [pdf.id])).rejects.toThrow();
  });
});

describe("one-time codes", () => {
  it("magic sign-in links work once and expire", () => {
    const { code } = createMagicLink(uid);
    expect(redeemMagicLink(code)?.id).toBe(uid);
    expect(redeemMagicLink(code)).toBeNull();
    const late = createMagicLink(uid);
    vi.setSystemTime(new Date(Date.now() + 16 * 60_000));
    expect(redeemMagicLink(late.code)).toBeNull();
    expect(redeemMagicLink("garbage")).toBeNull();
  });

  it("Telegram link codes are forgiving about case and expire after 30 minutes", () => {
    const { code } = createTelegramLinkCode(uid);
    expect(redeemTelegramLinkCode(` ${code.toLowerCase().slice(0, 4)}-${code.slice(4)} `, 42)?.telegramChatId).toBe(42);
    const late = createTelegramLinkCode(uid);
    vi.setSystemTime(new Date(Date.now() + 31 * 60_000));
    expect(redeemTelegramLinkCode(late.code, 43)).toBeNull();
  });
});

describe("token-less local API access", async () => {
  const { tokenlessAccess, signupAllowed } = await import("@/server/auth");
  const ok = (h: Record<string, string>) => tokenlessAccess(new Headers(h)).ok;

  it("accepts local tools (curl, MCP clients) and the app itself", () => {
    expect(ok({ host: "localhost:3000" })).toBe(true);
    expect(ok({ host: "127.0.0.1:3000" })).toBe(true);
    expect(ok({ host: "[::1]:3000" })).toBe(true);
    expect(ok({ host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" })).toBe(true);
  });

  it("refuses other hosts, proxies and cross-site browser requests", () => {
    expect(ok({ host: "evil.example:3000" })).toBe(false); // DNS rebinding
    expect(ok({ host: "192.168.1.20:3000" })).toBe(false); // LAN, needs a token
    expect(ok({ host: "localhost:3000", "x-forwarded-host": "wallet.example.com" })).toBe(false); // behind a reverse proxy
    expect(ok({ host: "localhost:3000", "x-forwarded-host": "localhost:3000", "x-forwarded-for": "::1" })).toBe(true); // what Next adds itself
    expect(ok({ host: "localhost:3000", origin: "https://evil.example" })).toBe(false);
    expect(ok({ host: "localhost:3000", origin: "null" })).toBe(false);
    expect(ok({ host: "localhost:3000", "sec-fetch-site": "cross-site" })).toBe(false);
    process.env.WALLET_ALLOWED_HOSTS = "nas.local";
    expect(ok({ host: "nas.local:3000" })).toBe(true);
    delete process.env.WALLET_ALLOWED_HOSTS;
  });

  it("only lets the first account sign up unless enabled", () => {
    expect(signupAllowed(0)).toBe(true);
    expect(signupAllowed(1)).toBe(false);
    process.env.WALLET_ALLOW_SIGNUP = "1";
    expect(signupAllowed(1)).toBe(true);
    delete process.env.WALLET_ALLOW_SIGNUP;
  });
});
