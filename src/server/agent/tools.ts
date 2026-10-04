import { z } from "zod";
import * as accountsSvc from "@/server/services/accounts";
import * as txSvc from "@/server/services/transactions";
import * as catSvc from "@/server/services/categories";
import * as budgetSvc from "@/server/services/budgets";
import * as reminderSvc from "@/server/services/reminders";
import * as holdingsSvc from "@/server/services/holdings";
import * as uploadsSvc from "@/server/services/uploads";
import { ensureFreshRates, fxConverter, latestFxDate } from "@/server/services/fx";
import { refreshPrices, searchSymbols } from "@/server/services/prices";
import { netWorthHistory, netWorthOn } from "@/server/services/networth";
import { getOverview } from "@/server/services/overview";
import { today } from "@/server/services/settings";
import { purchaseInputSchema, simulatePurchase, capacityInputSchema, borrowingCapacity } from "@/lib/finance/mortgage";
import { buyVsRentInputSchema, simulateBuyVsRent } from "@/lib/finance/buy-vs-rent";
import { blendedAssumptions, projectNetWorth, projectionInputSchema } from "@/lib/finance/projection";
import { applyMapping, guessMapping, parseCsv, type CsvMapping } from "@/lib/csv-import";
import { isISODate, isMonth, monthBounds } from "@/lib/dates";
import { invalidateSqlSandbox, runUserSql } from "./sql-sandbox";

/**
 * The single tool surface of the app. The Claude API agent, the MCP server
 * (stdio + HTTP), local CLI agents and /api/tools all expose exactly these
 * tools. Every call runs on behalf of one user (`ctx.userId`).
 */
export interface ToolContext {
  userId: string;
}

export interface WalletTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Write tools change data; they can be disabled with WALLET_AGENT_READONLY=1. */
  readOnly: boolean;
  run: (input: z.output<S>, ctx: ToolContext) => unknown;
}

function tool<S extends z.ZodObject>(t: WalletTool<S>): WalletTool<S> {
  return t;
}

const isoDate = z.string().refine(isISODate, "Expected YYYY-MM-DD");
const month = z.string().refine(isMonth, "Expected YYYY-MM");

const SQL_SCHEMA = `Tables (only your data; amounts are INTEGER cents in the row's currency; dates are TEXT 'YYYY-MM-DD'):
- accounts(id, name, institution, type, asset_class ['cash','investments','retirement','real_estate','crypto','commodities','other','liabilities'], currency, ownership_pct, include_in_net_worth, archived_at, linked_account_id, loan_params JSON, notes)
- balance_snapshots(id, account_id, date, balance_cents, note, source) — one row per account per day, in the account currency; liabilities store the amount owed as a positive number
- holdings(id, account_id, symbol, name, asset_type, quantity REAL, currency, cost_basis REAL per unit, manual_price REAL)
- prices(symbol, date, close REAL, currency) — daily closes of held symbols
- fx_rates(currency, date, per_usd REAL) — units of currency per 1 USD
- transactions(id, account_id, date, amount_cents [negative = spending], currency, description, category_id, notes, source)
- categories(id, name, kind ['income','expense','transfer'], icon)
- category_rules(id, pattern, category_id) — lowercase substring of description → category
- budgets(id, category_id, amount_cents) — monthly envelope in the base currency
- reminders(id, title, message, kind, account_id, frequency, day_of_month, day_of_week, month_of_year, date, time_of_day, nag_every_hours, enabled, next_run_at [ms epoch])
- simulations(id, name, type, params JSON); settings(key, value) — key 'currency' = base currency`;

const csvMappingSchema = z.object({
  date: z.string().describe("Header of the date column"),
  description: z.string().describe("Header of the label/description column"),
  amount: z.string().optional().describe("Header of a single signed amount column"),
  debit: z.string().optional().describe("Header of the money-out column (when there is no single amount column)"),
  credit: z.string().optional().describe("Header of the money-in column"),
  dateFormat: z.enum(["auto", "dmy", "mdy", "ymd"]).default("auto"),
  invertSign: z.boolean().default(false).describe("True when the export shows spending as positive numbers"),
});

export const TOOLS = [
  tool({
    name: "get_overview",
    title: "Financial overview",
    description:
      "Snapshot of the user's finances in their base currency: net worth (total, assets, liabilities, per asset class), change over 1 month / YTD / 1 year, this month's budget status, the last 6 months of cash flow, upcoming reminders and a list of things that need attention. Start here for any broad question.",
    input: z.object({}),
    readOnly: true,
    run: (_i, { userId }) => {
      const o = getOverview(userId);
      return { ...o, netWorth: { ...o.netWorth, accounts: undefined } };
    },
  }),
  tool({
    name: "get_net_worth",
    title: "Net worth breakdown",
    description:
      "Net worth on a date (default today) with every account: balance in its own currency, owned share, and contribution in the base currency. Loans amortize automatically; accounts with holdings are valued at market prices.",
    input: z.object({ date: isoDate.optional().describe("YYYY-MM-DD, default today") }),
    readOnly: true,
    run: ({ date }, { userId }) => netWorthOn(userId, date),
  }),
  tool({
    name: "get_net_worth_history",
    title: "Net worth history",
    description: "Month-end net worth (total and per asset class, base currency) for the last N months, plus today.",
    input: z.object({ months: z.number().int().min(1).max(240).default(24) }),
    readOnly: true,
    run: ({ months }, { userId }) => netWorthHistory(userId, months),
  }),
  tool({
    name: "list_accounts",
    title: "List accounts",
    description:
      "All accounts with type, asset class, currency, current balance (own currency and base currency), ownership share, whether the value comes from holdings or a loan schedule, and when the balance was last updated.",
    input: z.object({ includeArchived: z.boolean().default(false) }),
    readOnly: true,
    run: ({ includeArchived }, { userId }) => accountsSvc.listAccounts(userId, { includeArchived }),
  }),
  tool({
    name: "get_account",
    title: "Account details",
    description: "One account with its full balance history (snapshots, in the account currency).",
    input: z.object({ accountId: z.number().int() }),
    readOnly: true,
    run: ({ accountId }, { userId }) => accountsSvc.getAccount(userId, accountId),
  }),
  tool({
    name: "list_transactions",
    title: "List transactions",
    description:
      "Transactions, newest first, with category, account, currency and the amount converted to the base currency. Filter by date range, account, category (\"none\" = uncategorized) or a description search.",
    input: z.object({
      from: isoDate.optional(),
      to: isoDate.optional(),
      accountId: z.number().int().optional(),
      categoryId: z.union([z.number().int(), z.literal("none")]).optional(),
      search: z.string().optional().describe("Case-insensitive substring of the description"),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
    }),
    readOnly: true,
    run: (f, { userId }) => txSvc.listTransactions(userId, f),
  }),
  tool({
    name: "get_spending_by_category",
    title: "Spending by category",
    description: "Total spending per expense category (base currency) over a date range (default: current month), largest first.",
    input: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
    readOnly: true,
    run: ({ from, to }, { userId }) => {
      const m = monthBounds(today(userId).slice(0, 7));
      return budgetSvc.spendingByCategory(userId, from ?? m.start, to ?? m.end);
    },
  }),
  tool({
    name: "get_budget_status",
    title: "Budget status",
    description:
      "For a month (default current): income, expenses, savings rate, and each category's budget vs spending (base currency) with a status (ok / ahead_of_pace / over / unbudgeted).",
    input: z.object({ month: month.optional().describe("YYYY-MM") }),
    readOnly: true,
    run: ({ month }, { userId }) => budgetSvc.budgetStatus(userId, month),
  }),
  tool({
    name: "get_cashflow",
    title: "Monthly cash flow",
    description: "Income, expenses, net savings and savings rate per month (base currency) for the last N months; transfers excluded.",
    input: z.object({ months: z.number().int().min(1).max(60).default(12) }),
    readOnly: true,
    run: ({ months }, { userId }) => budgetSvc.cashflow(userId, months),
  }),
  tool({
    name: "list_categories",
    title: "Categories & rules",
    description: "Transaction categories (ids, kind), auto-categorization rules and monthly budgets.",
    input: z.object({}),
    readOnly: true,
    run: (_i, { userId }) => ({
      categories: catSvc.listCategories(userId),
      rules: catSvc.listRules(userId),
      budgets: budgetSvc.listBudgets(userId),
    }),
  }),
  tool({
    name: "list_reminders",
    title: "List reminders",
    description: "Telegram reminders with their schedule, next run time and whether they're waiting to be acknowledged.",
    input: z.object({}),
    readOnly: true,
    run: (_i, { userId }) => reminderSvc.listReminders(userId),
  }),
  tool({
    name: "list_holdings",
    title: "Investment holdings",
    description:
      "Positions (stocks, ETFs, funds, bonds, crypto, commodities) with quantity, latest price, market value, gain vs cost basis, plus totals by asset type and currency (base currency).",
    input: z.object({ accountId: z.number().int().optional() }),
    readOnly: true,
    run: ({ accountId }, { userId }) =>
      accountId ? holdingsSvc.listHoldings(userId, { accountId }) : holdingsSvc.holdingsSummary(userId),
  }),
  tool({
    name: "search_symbol",
    title: "Find a market symbol",
    description:
      "Look up the market symbol of a stock, ETF, fund, crypto or commodity by name or ISIN (e.g. \"MSCI World Amundi\", \"Apple\", \"gold\"). Use the returned symbol with upsert_holding.",
    input: z.object({ query: z.string().min(1).max(80) }),
    readOnly: true,
    run: ({ query }) => searchSymbols(query),
  }),
  tool({
    name: "convert_currency",
    title: "Convert currency",
    description: "Convert an amount between currencies (ISO codes, plus BTC/ETH/XAU…) with the stored daily rates.",
    input: z.object({
      amount: z.number(),
      from: accountsSvc.currencySchema,
      to: accountsSvc.currencySchema,
      date: isoDate.optional(),
    }),
    readOnly: true,
    run: async ({ amount, from, to, date }) => {
      await ensureFreshRates();
      const fx = fxConverter();
      const on = date ?? latestFxDate() ?? today();
      const rate = fx.rate(from, to, on);
      if (rate === null) throw new Error(`No exchange rate for ${[...fx.missing].join(", ")}`);
      return { amount, from, to, rate, converted: amount * rate, ratesDate: latestFxDate() };
    },
  }),
  tool({
    name: "query_sql",
    title: "Read-only SQL",
    description: `Run a read-only SQLite SELECT over the user's own data for analysis the other tools don't cover. Returns at most 500 rows.\n${SQL_SCHEMA}`,
    input: z.object({ sql: z.string().min(1).describe("A single SELECT (or WITH … SELECT) statement") }),
    readOnly: true,
    run: ({ sql }, { userId }) => ({ ...runUserSql(userId, sql), note: "Amounts are in cents" }),
  }),
  tool({
    name: "simulate_mortgage",
    title: "Mortgage / purchase simulator",
    description:
      "Simulate buying a property with a mortgage (defaults follow French rules: notary fees, borrower insurance on initial capital, guarantee fees, 35% debt-to-income cap — override for other countries). Returns loan amount, monthly payment, total credit cost, APR, debt ratio and a yearly amortization/equity table.",
    input: purchaseInputSchema,
    readOnly: true,
    run: (i) => simulatePurchase(i),
  }),
  tool({
    name: "borrowing_capacity",
    title: "Borrowing capacity",
    description: "Maximum loan and property price affordable for a given income under a debt-to-income cap.",
    input: capacityInputSchema,
    readOnly: true,
    run: (i) => borrowingCapacity(i),
  }),
  tool({
    name: "simulate_buy_vs_rent",
    title: "Buy vs rent",
    description:
      "Compare buying (mortgage, ownership costs, appreciation, selling costs) against renting and investing the difference, year by year. Returns both net worths per year and the break-even year.",
    input: buyVsRentInputSchema,
    readOnly: true,
    run: (i) => simulateBuyVsRent(i),
  }),
  tool({
    name: "project_net_worth",
    title: "Net worth projection",
    description:
      "Project net worth over N years with monthly contributions, expected return, inflation, one-off events and a Monte Carlo p10/p50/p90 band. Any omitted parameter is filled from the user's data: current net worth, average monthly savings over the last 6 months, and a return/volatility blended from the current asset allocation.",
    input: withoutDefaults(projectionInputSchema),
    readOnly: true,
    run: (i, { userId }) => {
      const nw = netWorthOn(userId);
      const blended = blendedAssumptions(nw.byClassCents);
      const savings = budgetSvc.averageMonthlySavings(userId, 6);
      const assumptions = {
        startingNetWorth: nw.netCents / 100,
        monthlyContribution: Math.max(0, savings.netCents / 100),
        annualReturnPct: blended.returnPct,
        volatilityPct: blended.volatilityPct,
        annualExpenses: savings.expensesCents > 0 ? (savings.expensesCents * 12) / 100 : undefined,
      };
      const input = { ...assumptions, ...stripUndefined(i) };
      return { currency: nw.currency, assumptions: input, result: projectNetWorth(input) };
    },
  }),
  tool({
    name: "list_uploads",
    title: "Uploaded files",
    description: "Files the user dropped into the chat (bank CSV exports, PDF statements, screenshots), newest first.",
    input: z.object({}),
    readOnly: true,
    run: (_i, { userId }) => uploadsSvc.listUploads(userId),
  }),
  tool({
    name: "read_upload",
    title: "Read an uploaded file",
    description:
      "Text content of an uploaded file: CSV/TXT/OFX as-is, PDF statements via text extraction. Long files are paged with offset/maxChars. Use it to understand a statement before importing it.",
    input: z.object({
      uploadId: z.string(),
      offset: z.number().int().min(0).default(0),
      maxChars: z.number().int().min(500).max(60_000).default(20_000),
    }),
    readOnly: true,
    run: async ({ uploadId, offset, maxChars }, { userId }) => {
      const upload = uploadsSvc.getUpload(userId, uploadId);
      const { text, pages } = await uploadsSvc.uploadText(upload);
      return {
        filename: upload.filename,
        pages,
        totalChars: text.length,
        offset,
        text: text.slice(offset, offset + maxChars),
        more: offset + maxChars < text.length,
      };
    },
  }),

  // ── Writes ──────────────────────────────────────────────────────────────
  tool({
    name: "import_csv_upload",
    title: "Import a CSV upload",
    description:
      "Import every row of an uploaded bank CSV as transactions (server-side, any size). Without a mapping the columns are guessed; check the returned preview and re-run with an explicit mapping if dates/amounts/signs look wrong. Duplicates from earlier imports are skipped and categorization rules applied.",
    input: z.object({
      uploadId: z.string(),
      accountId: z.number().int().optional().describe("Account the statement belongs to"),
      currency: accountsSvc.currencySchema.optional().describe("Currency of the amounts (default: the account's)"),
      mapping: csvMappingSchema.optional(),
      dryRun: z.boolean().default(false).describe("Parse and preview without importing"),
    }),
    readOnly: false,
    run: async ({ uploadId, accountId, currency, mapping, dryRun }, { userId }) => {
      const upload = uploadsSvc.getUpload(userId, uploadId);
      const { text } = await uploadsSvc.uploadText(upload);
      const parsed = parseCsv(text);
      const used: CsvMapping = mapping ?? guessMapping(parsed.headers);
      const { ok, errors } = applyMapping(parsed.rows, used);
      const preview = ok.slice(0, 5);
      if (dryRun || !ok.length) {
        return { headers: parsed.headers, mapping: used, parsedRows: ok.length, errors: errors.slice(0, 10), preview, imported: false };
      }
      const result = txSvc.importTransactions(userId, ok, accountId ?? null, { currency, source: "agent" });
      invalidateSqlSandbox(userId);
      return { ...result, mapping: used, errorsCount: errors.length, errors: errors.slice(0, 10), preview, imported: true };
    },
  }),
  tool({
    name: "import_transactions",
    title: "Import transactions",
    description:
      "Bulk-add transactions you extracted yourself (e.g. from a PDF statement or a screenshot). Amounts are signed (negative = spending). Duplicates are skipped; `category` is matched to an existing category name, otherwise rules apply.",
    input: z.object({
      accountId: z.number().int().optional(),
      currency: accountsSvc.currencySchema.optional().describe("Default currency of the rows (default: the account's)"),
      rows: z
        .array(
          z.object({
            date: isoDate,
            amount: z.number(),
            description: z.string().min(1).max(300),
            currency: accountsSvc.currencySchema.optional(),
            category: z.string().optional().describe("Existing category name"),
          }),
        )
        .min(1)
        .max(2000),
    }),
    readOnly: false,
    run: ({ accountId, currency, rows }, { userId }) => {
      const result = txSvc.importTransactions(
        userId,
        rows.map((r) => ({
          date: r.date,
          amount: r.amount,
          description: r.description,
          currency: r.currency,
          categoryId: r.category ? (catSvc.findCategory(userId, r.category)?.id ?? null) : null,
        })),
        accountId ?? null,
        { currency, source: "agent" },
      );
      invalidateSqlSandbox(userId);
      return result;
    },
  }),
  tool({
    name: "record_balance",
    title: "Record account balance",
    description:
      "Set an account's balance (in the account's currency) for a date (default today), e.g. read from a bank app or statement. For loans, pass the amount still owed. Not needed for accounts valued from holdings.",
    input: z.object({
      accountId: z.number().int(),
      balance: z.number(),
      date: isoDate.optional(),
      note: z.string().max(500).optional(),
    }),
    readOnly: false,
    run: (i, { userId }) => accountsSvc.recordBalance(userId, { ...i, source: "agent" }),
  }),
  tool({
    name: "add_transaction",
    title: "Add transaction",
    description:
      "Add one transaction. Amount is signed: negative for spending, positive for income. Currency defaults to the account's. If categoryId is omitted, categorization rules are applied.",
    input: z.object({
      date: isoDate.optional(),
      amount: z.number(),
      currency: accountsSvc.currencySchema.optional(),
      description: z.string().min(1),
      categoryId: z.number().int().optional(),
      accountId: z.number().int().optional(),
      notes: z.string().optional(),
    }),
    readOnly: false,
    run: (i, { userId }) => txSvc.addTransaction(userId, { ...i, source: "agent" }),
  }),
  tool({
    name: "categorize_transactions",
    title: "Categorize transactions",
    description:
      "Assign a category to transactions. Optionally pass rememberPattern (a lowercase merchant keyword like \"carrefour\") to create a rule that also categorizes all other matching uncategorized transactions and future imports.",
    input: z.object({
      transactionIds: z.array(z.number().int()).max(500),
      categoryId: z.number().int(),
      rememberPattern: z.string().min(2).optional(),
    }),
    readOnly: false,
    run: ({ transactionIds, categoryId, rememberPattern }, { userId }) =>
      txSvc.categorizeTransactions(userId, transactionIds, categoryId, rememberPattern),
  }),
  tool({
    name: "create_category",
    title: "Create category",
    description: "Create a transaction category.",
    input: catSvc.categoryInputSchema,
    readOnly: false,
    run: (i, { userId }) => catSvc.createCategory(userId, i),
  }),
  tool({
    name: "set_budget",
    title: "Set monthly budget",
    description: "Set the monthly budget (base currency) of an expense category. 0 removes the budget.",
    input: z.object({ categoryId: z.number().int(), monthlyAmount: z.number().min(0) }),
    readOnly: false,
    run: ({ categoryId, monthlyAmount }, { userId }) =>
      budgetSvc.setBudget(userId, categoryId, monthlyAmount) ?? { removed: true },
  }),
  tool({
    name: "create_account",
    title: "Create account",
    description:
      "Create an account (bank, savings, brokerage, crypto wallet, property, loan…) in any currency. For an amortizing loan pass loanParams so its balance is computed automatically. For investment accounts, add positions with upsert_holding instead of a balance.",
    input: accountsSvc.accountInputSchema,
    readOnly: false,
    run: (i, { userId }) => accountsSvc.createAccount(userId, i),
  }),
  tool({
    name: "update_account",
    title: "Update account",
    description: "Change an account's name, institution, type, currency, ownership share, loan terms or notes.",
    input: accountsSvc.accountInputSchema.partial().omit({ initialBalance: true }).extend({ accountId: z.number().int() }),
    readOnly: false,
    run: ({ accountId, ...patch }, { userId }) => accountsSvc.updateAccount(userId, accountId, patch),
  }),
  tool({
    name: "upsert_holding",
    title: "Add or update a holding",
    description:
      "Add a position to an account (or update its quantity/cost if the account already holds that symbol). Use search_symbol to find the symbol. Physical assets without a market (e.g. gold coins, unlisted shares) take a manualPrice instead of a symbol. The latest price is fetched immediately.",
    input: holdingsSvc.holdingInputSchema,
    readOnly: false,
    run: async (i, { userId }) => {
      const r = await holdingsSvc.upsertHolding(userId, i);
      invalidateSqlSandbox(userId);
      return r;
    },
  }),
  tool({
    name: "delete_holding",
    title: "Remove a holding",
    description: "Remove a position (e.g. fully sold).",
    input: z.object({ holdingId: z.number().int() }),
    readOnly: false,
    run: ({ holdingId }, { userId }) => {
      holdingsSvc.deleteHolding(userId, holdingId);
      invalidateSqlSandbox(userId);
      return { deleted: true };
    },
  }),
  tool({
    name: "refresh_prices",
    title: "Refresh market prices",
    description: "Fetch the latest prices for all held symbols now (normally done automatically every few hours).",
    input: z.object({}),
    readOnly: false,
    run: async (_i, { userId }) => {
      const r = await refreshPrices({ maxAgeHours: 0 });
      accountsSvc.snapshotHoldingAccounts(userId);
      invalidateSqlSandbox(userId);
      return r;
    },
  }),
  tool({
    name: "create_reminder",
    title: "Create reminder",
    description:
      "Create a Telegram reminder (e.g. monthly on the 3rd at 19:00: import the bank statement). kind balance_update with accountId lets the user reply with the new balance. nagEveryHours re-sends until acknowledged.",
    input: reminderSvc.reminderInputSchema,
    readOnly: false,
    run: (i, { userId }) => reminderSvc.createReminder(userId, i),
  }),
] as const satisfies readonly WalletTool<z.ZodObject>[];

export function agentReadOnly(): boolean {
  return process.env.WALLET_AGENT_READONLY === "1" || process.env.WALLET_AGENT_READONLY === "true";
}

export function enabledTools(): WalletTool[] {
  const ro = agentReadOnly();
  return (TOOLS as readonly WalletTool[]).filter((t) => t.readOnly || !ro);
}

export interface ToolCallResult {
  ok: boolean;
  /** JSON text handed back to the model. */
  content: string;
}

/** Validate input, run the tool for a user and serialize its result for a model. */
export async function callTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolCallResult> {
  const t = enabledTools().find((x) => x.name === name);
  if (!t) return { ok: false, content: `Unknown or disabled tool: ${name}` };
  const parsed = t.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, content: `Invalid input: ${z.prettifyError(parsed.error)}` };
  }
  try {
    const result = await t.run(parsed.data, ctx);
    if (!t.readOnly) invalidateSqlSandbox(ctx.userId);
    return { ok: true, content: JSON.stringify(present(result)) };
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Make service output model-friendly: `xxxCents` fields become `xxx` in
 * currency units, Dates become ISO strings, Buffers and undefined are dropped.
 */
export function present(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) return value.map(present);
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (k.endsWith("Cents") && k.length > 5) {
      const key = k.slice(0, -5);
      if (typeof v === "number") out[key] = v / 100;
      else if (v && typeof v === "object")
        out[key] = Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, typeof vv === "number" ? vv / 100 : vv]));
      else out[key] = v;
    } else {
      const p = present(v);
      if (p !== undefined) out[k] = p;
    }
  }
  return out;
}

/** Same fields, all optional and without defaults (so omitted means "use my data"). */
function withoutDefaults<S extends z.ZodObject>(schema: S) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    const inner = field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : field;
    shape[key] = inner.optional().describe(field.description ?? inner.description ?? "");
  }
  return z.object(shape) as z.ZodObject<{ [K in keyof S["shape"]]: z.ZodOptional<z.ZodType<z.output<S>[K]>> }>;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
