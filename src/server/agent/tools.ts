import { z } from "zod";
import * as accountsSvc from "@/server/services/accounts";
import * as txSvc from "@/server/services/transactions";
import * as catSvc from "@/server/services/categories";
import * as budgetSvc from "@/server/services/budgets";
import * as reminderSvc from "@/server/services/reminders";
import * as holdingsSvc from "@/server/services/holdings";
import * as uploadsSvc from "@/server/services/uploads";
import * as connectionsSvc from "@/server/services/connections";
import * as brokerHistorySvc from "@/server/services/broker-history";
import { ensureFreshRates, fxConverter, latestFxDate } from "@/server/services/fx";
import { refreshPrices, searchSymbols } from "@/server/services/prices";
import { netWorthDaily, netWorthHistory, netWorthMoves, netWorthOn } from "@/server/services/networth";
import * as jobsSvc from "@/server/services/jobs";
import { matchTransfers } from "@/server/services/transfers";
import * as recurringSvc from "@/server/services/recurring";
import * as companiesSvc from "@/server/services/companies";
import * as taxSvc from "@/server/services/tax";
import * as goalsSvc from "@/server/services/goals";
import { listChanges } from "@/server/services/audit";
import { listUsers } from "@/server/services/users";
import { investmentAnalytics } from "@/server/services/investment-analytics";
import { getOverview } from "@/server/services/overview";
import { getSettings, today } from "@/server/services/settings";
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
- accounts(id, name, institution, type, asset_class ['cash','investments','retirement','real_estate','crypto','commodities','other','liabilities'], currency, ownership_pct, include_in_net_worth, archived_at, linked_account_id, loan_params JSON, gratuity_params JSON [a job: country, startDate, endDate, salaries — its balance is the end-of-service gratuity, computed, never stored], notes)
- balance_snapshots(id, account_id, date, balance_cents, note, source) — one row per account per day, in the account currency; liabilities store the amount owed as a positive number
- holdings(id, account_id, symbol, name, asset_type, quantity REAL, currency, cost_basis REAL per unit, manual_price REAL, connection_id, external_id) — connection_id set = synced from a brokerage, overwritten by the next sync
- prices(symbol, date, close REAL, currency) — daily closes of held symbols
- fx_rates(currency, date, per_usd REAL) — units of currency per 1 USD
- transactions(id, account_id, date, amount_cents [negative = spending], currency, description [bank label], payee [display name], tags JSON array, category_id, recurring_id, notes, source)
- transaction_splits(id, transaction_id, category_id, amount_cents) — parts of a split payment; when present they replace the transaction's category in totals
- categories(id, name, kind ['income','expense','transfer'], icon)
- category_rules(id, pattern, category_id, match_type, account_id, direction, min_amount_cents, max_amount_cents, rename_to, add_tag) — rule: label match + optional conditions → category (+ payee rename, tag)
- budgets(id, category_id, amount_cents, currency) — monthly envelope; currency NULL = the base currency
- reminders(id, title, message, kind, account_id, frequency, day_of_month, day_of_week, month_of_year, date, time_of_day, nag_every_hours, enabled, next_run_at [ms epoch])
- recurring(id, name, pattern, account_id, category_id, amount_cents [signed], currency, cadence, next_date, status ['active','suggested','paused','dismissed'], last_matched_date, last_change_pct) — expected payments; transactions.recurring_id links the real ones
- simulations(id, name, type, params JSON); settings(key, value) — key 'currency' = base currency
- broker_activity(id, account_id, kind ['trade','dividend','deposit','withdrawal','interest','fee','other'], external_id, at [ISO timestamp], date, ticker, symbol, name, quantity REAL [trades; negative = sale], price REAL [per unit, price_currency], price_currency, cash_cents [signed effect on the account's cash, account currency; a buy is negative], currency, realized_cents [realised P/L of a sale]) — imported broker history`;

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
    description:
      "Net worth over time (total and per asset class, base currency). granularity 'month' gives month-ends for the last N months plus today; 'day' gives every day for the last N days (investment accounts use their daily market snapshot).",
    input: z.object({
      granularity: z.enum(["month", "day"]).default("month"),
      months: z.number().int().min(1).max(240).default(24).describe("For granularity 'month'"),
      days: z.number().int().min(1).max(1830).default(90).describe("For granularity 'day'"),
    }),
    readOnly: true,
    run: ({ granularity, months, days }, { userId }) => (granularity === "day" ? netWorthDaily(userId, days) : netWorthHistory(userId, months)),
  }),
  tool({
    name: "get_net_worth_moves",
    title: "What moved net worth",
    description:
      "How net worth changed over 1 day, 1 week, 1 month, the year to date and 1 year (amount and %), with the accounts behind each change, biggest first. Each mover has a driver: 'balance' (a new balance was recorded), 'market' (prices of holdings), 'loan' (repayment schedule) or 'job' (end-of-service gratuity accruing) or 'fx' (same balance in its own currency, only the exchange rate moved). Movers add up to the change. Use it to answer 'why did my net worth go up/down'.",
    input: z.object({ period: z.enum(["1d", "1w", "1m", "ytd", "1y"]).optional().describe("One period only; default all") }),
    readOnly: true,
    run: ({ period }, { userId }) => {
      const { current, moves } = netWorthMoves(userId);
      return { currency: current.currency, netWorth: current.netCents / 100, moves: period ? moves.filter((m) => m.key === period) : moves };
    },
  }),
  tool({
    name: "list_jobs",
    title: "Jobs and end-of-service gratuity",
    description:
      "The user's jobs with the end-of-service gratuity (EOSG) accrued under each job's country's labour law: years of service, amount owed if they resigned today and if they were let go today, how it was computed, the figure counted in net worth, accrual per day, and the next date the rule improves (e.g. UAE 5-year step from 21 to 30 days a year). Amounts are in the job's currency. Statutory minimums: contracts can be more generous.",
    input: z.object({ includeArchived: z.boolean().default(false) }),
    readOnly: true,
    run: ({ includeArchived }, { userId }) =>
      jobsSvc.listJobs(userId, { includeArchived }).map(({ account: _a, ...j }) => j),
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
      "Transactions, newest first, with category, account, currency, payee (display name), tags, splitCount, recurringId and the amount converted to the base currency. Filter by date range, account, category (\"none\" = uncategorized), tag or a text search.",
    input: z.object({
      from: isoDate.optional(),
      to: isoDate.optional(),
      accountId: z.number().int().optional(),
      categoryId: z.union([z.number().int(), z.literal("none")]).optional(),
      search: z.string().optional().describe("Case-insensitive text in the bank label or payee"),
      tag: z.string().optional().describe("Only transactions with this tag"),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
    }),
    readOnly: true,
    run: (f, { userId }) => txSvc.listTransactions(userId, f),
  }),
  tool({
    name: "get_spending_by_category",
    title: "Spending by category",
    description: "Total spending per expense category (base currency, or `currency`) over a date range (default: current month), largest first.",
    input: z.object({ from: isoDate.optional(), to: isoDate.optional(), currency: z.string().optional() }),
    readOnly: true,
    run: ({ from, to, currency }, { userId }) => {
      const m = monthBounds(today(userId).slice(0, 7));
      return budgetSvc.spendingByCategory(userId, from ?? m.start, to ?? m.end, currency);
    },
  }),
  tool({
    name: "get_budget_status",
    title: "Budget status",
    description:
      "For a month (default current): income, expenses, savings rate, and each category's budget vs spending with a status (ok / ahead_of_pace / over / unbudgeted). Each envelope has its own currency (line.currency; budget/spent/remaining are in it, spending in other currencies converted at each transaction's date) and spentByCurrency shows what was actually paid in which currency. Income, expenses, totals and display* fields are in `currency` (default: base currency).",
    input: z.object({
      month: month.optional().describe("YYYY-MM"),
      currency: z.string().optional().describe("Show income, expenses and totals in this currency, e.g. AED"),
    }),
    readOnly: true,
    run: ({ month, currency }, { userId }) => budgetSvc.budgetStatus(userId, month, { currency }),
  }),
  tool({
    name: "get_cashflow",
    title: "Monthly cash flow",
    description: "Income, expenses, net savings and savings rate per month (base currency, or `currency`) for the last N months; transfers excluded.",
    input: z.object({ months: z.number().int().min(1).max(60).default(12), currency: z.string().optional() }),
    readOnly: true,
    run: ({ months, currency }, { userId }) => budgetSvc.cashflow(userId, months, currency),
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
    name: "list_connections",
    title: "List brokerage connections",
    description:
      "Brokerage accounts synced automatically (e.g. Trading 212): which wallet account each one fills, how many positions it holds, when it last synced and the last error. Synced holdings are overwritten on every sync (hourly), so change positions at the broker, not with upsert_holding. Connections are added in Settings → Brokerage connections; credentials are never exposed.",
    input: z.object({}),
    readOnly: true,
    run: (_i, { userId }) => connectionsSvc.listConnections(userId),
  }),
  tool({
    name: "list_investment_activity",
    title: "Investment activity",
    description:
      "Past trades, dividends, deposits, withdrawals, interest and fees imported from connected brokerages (e.g. Trading 212), newest first, with totals of the whole filtered set in the base currency (bought, sold, dividends, interest, deposited, withdrawn, fees, realised P/L). Amounts are in the account currency; cashCents is the signed effect on the account's cash (a buy is negative).",
    input: z.object({
      accountId: z.number().int().optional(),
      kind: z.enum(["trade", "dividend", "deposit", "withdrawal", "interest", "fee", "other"]).optional(),
      ticker: z.string().optional().describe("Broker ticker (AAPL_US_EQ) or Yahoo symbol (AAPL)"),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }),
    readOnly: true,
    run: (i, { userId }) => brokerHistorySvc.investmentActivity(userId, i),
  }),
  tool({
    name: "get_investment_income",
    title: "Investment income",
    description:
      "Dividends, interest on cash and realised gains per month (base currency), with totals over the window and this year to date, from imported brokerage history. Also money put in vs what it is worth now, the time-weighted return (deposits taken out) and the annual money-weighted return (XIRR).",
    input: z.object({ months: z.number().int().min(1).max(120).default(12) }),
    readOnly: true,
    run: ({ months }, { userId }) => {
      const perf = brokerHistorySvc.brokerPerformance(userId, { days: 365 });
      return {
        ...brokerHistorySvc.investmentIncome(userId, { months }),
        performance: perf && { ...perf, index: perf.index.filter((_, i) => i % 7 === 0 || i === perf.index.length - 1) },
      };
    },
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
      const { ok, errors, dateFormat } = applyMapping(parsed.rows, used);
      const preview = ok.slice(0, 5);
      const dateWarning = dateFormat.mixed
        ? "The date column mixes day-first and month-first values — check the file."
        : dateFormat.ambiguous
          ? `Every day in the file is 12 or less, so day-first vs month-first can't be told apart; ${dateFormat.format === "dmy" ? "day-first" : "month-first"} was assumed. Ask the user or pass mapping.dateFormat.`
          : undefined;
      if (dryRun || !ok.length || dateFormat.mixed) {
        return { headers: parsed.headers, mapping: used, dateFormat, dateWarning, parsedRows: ok.length, errors: errors.slice(0, 10), preview, imported: false };
      }
      const result = txSvc.importTransactions(userId, ok, accountId ?? null, { currency, source: "agent" });
      invalidateSqlSandbox(userId);
      return { ...result, mapping: used, dateFormat, dateWarning, errorsCount: errors.length, errors: errors.slice(0, 10), preview, imported: true };
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
    name: "save_rule",
    title: "Add or change a categorization rule",
    description:
      "A rule files transactions automatically (on add, on import, and with apply). Match the bank label (contains / starts / exact), optionally only on one account, only money in or out, or within an amount range; then set the category, and optionally rename the payee and add a tag. The most specific matching rule wins, then the longest pattern. Pass id to change a rule; set apply to also file existing uncategorized transactions.",
    input: catSvc.ruleInputSchema.extend({ id: z.number().int().optional(), apply: z.boolean().default(true) }),
    readOnly: false,
    run: ({ apply, ...i }, { userId }) => {
      const rule = catSvc.saveRule(userId, i);
      const applied = apply ? catSvc.applyRulesToUncategorized(userId) : 0;
      invalidateSqlSandbox(userId);
      return { rule, applied };
    },
  }),
  tool({
    name: "delete_rule",
    title: "Delete a rule",
    description: "Delete a categorization rule. Transactions it filed keep their category.",
    input: z.object({ id: z.number().int() }),
    readOnly: false,
    run: ({ id }, { userId }) => {
      catSvc.deleteRule(userId, id);
      return { deleted: id };
    },
  }),
  tool({
    name: "split_transaction",
    title: "Split a transaction",
    description:
      "Split one payment over several categories (e.g. a supermarket receipt: groceries + household). Parts are signed like the transaction and must add up to it exactly; budgets then count each part in its category. An empty parts list removes the split.",
    input: z.object({ transactionId: z.number().int(), parts: txSvc.splitInputSchema }),
    readOnly: false,
    run: ({ transactionId, parts }, { userId }) => {
      const r = txSvc.setSplits(userId, transactionId, parts);
      invalidateSqlSandbox(userId);
      return { parts: r };
    },
  }),
  tool({
    name: "tag_transactions",
    title: "Tag transactions",
    description: "Add and/or remove free tags (e.g. trip-japan, reimbursable) on transactions. list_transactions filters by tag.",
    input: z.object({ transactionIds: z.array(z.number().int()).max(1000), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() }),
    readOnly: false,
    run: ({ transactionIds, add, remove }, { userId }) => {
      const r = txSvc.tagTransactions(userId, transactionIds, { add, remove });
      invalidateSqlSandbox(userId);
      return { ...r, tags: txSvc.listTags(userId) };
    },
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
    description:
      "Set the monthly budget of an expense category, in a currency of your choice (e.g. rent in EUR, groceries in AED; default: keep the envelope's currency, or the base currency for a new one). Spending in other currencies counts at each transaction's exchange rate. 0 removes the budget.",
    input: z.object({ categoryId: z.number().int(), monthlyAmount: z.number().min(0), currency: z.string().optional() }),
    readOnly: false,
    run: ({ categoryId, monthlyAmount, currency }, { userId }) =>
      budgetSvc.setBudget(userId, categoryId, monthlyAmount, currency) ?? { removed: true },
  }),
  tool({
    name: "create_account",
    title: "Create account",
    description:
      "Create an account (bank, savings, brokerage, crypto wallet, property, loan…) in any currency. For an amortizing loan pass loanParams so its balance is computed automatically. For investment accounts, add positions with upsert_holding instead of a balance. Set country (FR for a French flat) so tax reports know where its income comes from, and companyId when the account belongs to one of the user's companies. Jobs and companies have their own tools (save_job, save_company).",
    input: accountsSvc.accountInputSchema,
    readOnly: false,
    run: (i, { userId }) => accountsSvc.createAccount(userId, i),
  }),
  tool({
    name: "list_companies",
    title: "Companies you own",
    description:
      "The user's companies as net-worth assets: country and legal form, valuation method (book = its own accounts' net value; revenue_multiple / profit_multiple = trailing-12-month figure × multiple; manual), value of 100% and the user's share (company currency and base currency), its own accounts (bank, brokerage, loans — counted through the company, never twice), revenue, expenses and profit per month and over the last 12 months, and the margin.",
    input: z.object({ months: z.number().int().min(1).max(120).default(24).describe("Months of P&L to return") }),
    readOnly: true,
    run: ({ months }, { userId }) =>
      companiesSvc.listCompanies(userId).map((c) => ({
        id: c.account.id,
        name: c.account.name,
        currency: c.account.currency,
        ownershipPct: c.account.ownershipPct,
        params: c.params,
        valueCents: c.valueCents,
        ownedCents: c.ownedCents,
        baseOwnedCents: c.baseOwnedCents,
        accounts: c.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, currency: a.currency, balanceCents: a.balanceCents })),
        ttm: c.ttm,
        marginPct: c.marginPct,
        months: c.months.slice(-months),
      })),
  }),
  tool({
    name: "save_company",
    title: "Add or update a company",
    description:
      "Add a company the user owns (omit accountId) or update one. params.country is where it is taxed (AE, FR…), params.valuation picks how it is valued: 'book' (its own accounts' net value — then attach its bank/brokerage/loan accounts with companyId on create_account/update_account), 'revenue_multiple' or 'profit_multiple' (with params.multiple), or 'manual' (with initialValue for 100%). ownershipPct is the user's share.",
    input: companiesSvc.companyInputSchema,
    readOnly: false,
    run: (i, { userId }) => {
      const c = companiesSvc.saveCompany(userId, i);
      invalidateSqlSandbox(userId);
      return { id: c.account.id, name: c.account.name, valueCents: c.valueCents, ownedCents: c.ownedCents, params: c.params };
    },
  }),
  tool({
    name: "set_company_financials",
    title: "Enter a company's month",
    description:
      "Record a company's revenue and expenses for one month (YYYY-MM, company currency, both positive), e.g. from the accountant, when its bank isn't imported. Added to what its accounts' transactions show. Zeros clear the month.",
    input: z.object({ companyId: z.number().int(), month, revenue: z.number().min(0), expenses: z.number().min(0), note: z.string().max(300).optional() }),
    readOnly: false,
    run: ({ companyId, month, revenue, expenses, note }, { userId }) => {
      const r = companiesSvc.setCompanyFinancials(userId, companyId, month, revenue, expenses, note);
      invalidateSqlSandbox(userId);
      return r ?? { cleared: month };
    },
  }),
  tool({
    name: "get_tax_report",
    title: "Tax estimate for a year",
    description:
      "Estimate a year's taxes from the user's data, by country: personal income tax where they live (UAE: none; France: barème with parts) and on French-source income for non-residents (20%/30% minimum rate + 17.2% social charges on rent), French rental income (micro-foncier 30% or réel with loan interest from the schedule), IFI on French real estate above 1.3 M€, and corporate tax for each company where it is (UAE 9% above AED 375k with Small Business Relief / Qualifying Free Zone; France IS 15%/25%). Also days spent per country and residency notes. Every line cites its law; inputs it can't infer are listed in `inputs` and set with set_tax_input. An estimate, not a filing.",
    input: z.object({ year: z.number().int().min(2000).max(2100) }),
    readOnly: true,
    run: ({ year }, { userId }) => taxSvc.taxReport(userId, year),
  }),
  tool({
    name: "set_tax_input",
    title: "Set a tax input",
    description:
      "Set what the tax estimate can't infer, for one year (or year 0 for every year): residence (ISO country, e.g. AE), homeOrJobInUae (true/false), fr.parts (family parts, e.g. 2 for a couple), fr.rental.regime (micro|reel), fr.rental.gross / fr.rental.expenses / fr.rental.interest (EUR, to override what was computed), fr.socialRate (standard|eea), fr.otherIncome, ifi.base (EUR), company.<id>.sbr / company.<id>.qfzp (true/false), company.<id>.rate (%), company.<id>.profit, other.<CC>.rate (% for income from a country without rules). An empty value clears it.",
    input: z.object({ year: z.number().int().min(0).max(2100), key: z.string(), value: z.string() }),
    readOnly: false,
    run: ({ year, key, value }, { userId }) => taxSvc.setTaxInput(userId, year, key, value) ?? { cleared: key },
  }),
  tool({
    name: "log_stay",
    title: "Log time spent in a country",
    description: "Record a stay (inclusive dates) in a country, for the tax-residency day count (UAE: 183 days, or 90 with a home or job there; France: séjour principal).",
    input: taxSvc.presenceInputSchema,
    readOnly: false,
    run: (i, { userId }) => taxSvc.addPresence(userId, i),
  }),
  tool({
    name: "list_stays",
    title: "Stays per country",
    description: "Logged stays, and days per country for a year.",
    input: z.object({ year: z.number().int().min(2000).max(2100) }),
    readOnly: true,
    run: ({ year }, { userId }) => ({ stays: taxSvc.listPresence(userId, year), ...taxSvc.daysByCountry(userId, `${year}-01-01`, `${year}-12-31`) }),
  }),
  tool({
    name: "share_account",
    title: "Share an account with a partner",
    description:
      "Share one of the user's accounts with another member of this wallet (memberId from list_members): it shows in their accounts and net worth at sharePct of it. role 'edit' lets them record balances; 'view' doesn't. remove: true stops sharing. Transactions stay private.",
    input: z.object({ accountId: z.number().int(), memberId: z.string(), role: z.enum(["view", "edit"]).default("view"), sharePct: z.number().min(0).max(100).default(50), remove: z.boolean().default(false) }),
    readOnly: false,
    run: ({ accountId, memberId, role, sharePct, remove }, { userId }) => {
      if (remove) accountsSvc.unshareAccount(userId, accountId, memberId);
      else accountsSvc.shareAccount(userId, accountId, memberId, role, sharePct);
      return { shares: accountsSvc.listShares(userId, accountId) };
    },
  }),
  tool({
    name: "list_members",
    title: "Members of this wallet",
    description: "The other people with an account on this wallet (id and name), to share accounts with.",
    input: z.object({}),
    readOnly: true,
    run: (_i, { userId }) => listUsers().filter((u) => u.id !== userId).map((u) => ({ id: u.id, name: u.name })),
  }),
  tool({
    name: "list_changes",
    title: "Recent changes (audit trail)",
    description: "What changed in the user's data and who did it (the user, the assistant, Telegram or a partner on a shared account), newest first.",
    input: z.object({ limit: z.number().int().min(1).max(500).default(50) }),
    readOnly: true,
    run: ({ limit }, { userId }) => listChanges(userId, limit).map((c) => ({ ...c, at: new Date(c.at).toISOString() })),
  }),
  tool({
    name: "list_goals",
    title: "Savings goals",
    description:
      "The user's goals: target amount and currency, optional date, the accounts that count (none = whole net worth), current progress and %, what's left, the monthly amount needed to arrive on the date, the pace used (planned monthly, or average savings) and the projected date, and whether it's on track.",
    input: z.object({ includeArchived: z.boolean().default(false) }),
    readOnly: true,
    run: ({ includeArchived }, { userId }) => goalsSvc.listGoals(userId, { includeArchived }).map(({ history: _h, ...g }) => g),
  }),
  tool({
    name: "save_goal",
    title: "Add or update a goal",
    description: "Add a goal (omit id) or change one: name, target and currency, optional targetDate, accountIds that hold it (empty = whole net worth), optional planned monthly contribution.",
    input: goalsSvc.goalInputSchema.extend({ id: z.number().int().optional() }),
    readOnly: false,
    run: (i, { userId }) => {
      const g = goalsSvc.saveGoal(userId, i);
      invalidateSqlSandbox(userId);
      return g;
    },
  }),
  tool({
    name: "delete_goal",
    title: "Delete a goal",
    description: "Delete a goal. Its accounts are untouched.",
    input: z.object({ id: z.number().int() }),
    readOnly: false,
    run: ({ id }, { userId }) => {
      goalsSvc.deleteGoal(userId, id);
      return { deleted: id };
    },
  }),
  tool({
    name: "get_investment_analytics",
    title: "Investment analytics",
    description:
      "Analytics of the portfolio held today, from daily prices in the base currency (exchange rates included): returns over 1M/3M/6M/YTD/1Y, annual volatility, max drawdown (peak, trough, recovery), Sharpe at 0% risk-free, best/worst day, % of up days, month-by-month returns, per-position weight, returns and 1-year change, allocation by type / currency / region (from the listing exchange) / account, and concentration (top position, top 5, effective number of positions). It describes current positions, not past trades.",
    input: z.object({ days: z.number().int().min(30).max(1830).default(365) }),
    readOnly: true,
    run: ({ days }, { userId }) => {
      const a = investmentAnalytics(userId, { days });
      return {
        ...a,
        index: a.index.filter((_, i) => i % 7 === 0 || i === a.index.length - 1),
        drawdown: undefined,
        actual: undefined,
        holdings: a.holdings.map(({ spark: _s, ...h }) => h),
        broker: a.broker && { ...a.broker, index: undefined },
      };
    },
  }),
  tool({
    name: "list_recurring",
    title: "Recurring payments",
    description:
      "Salary, rent, subscriptions and other scheduled money: each item (expected amount and currency, cadence, next date, last matched payment, last price change), suggestions detected from history waiting to be accepted, the next 30 days of expected payments (late = expected and not arrived), monthly totals in the base currency, and a cash forecast. Items are expectations matched against real transactions — they never create transactions on their own.",
    input: z.object({ days: z.number().int().min(1).max(365).default(30) }),
    readOnly: true,
    run: ({ days }, { userId }) => {
      const f = recurringSvc.forecastCash(userId, days);
      return {
        items: recurringSvc.listRecurring(userId, { status: ["active", "paused"] }),
        suggestions: recurringSvc.listRecurring(userId, { status: ["suggested"] }),
        upcoming: recurringSvc.upcoming(userId, days),
        summary: recurringSvc.recurringSummary(userId),
        attention: recurringSvc.recurringNudges(userId),
        forecast: { currency: f.currency, endCents: f.points.at(-1)?.cents, lowestCents: f.low.cents, lowestOn: f.low.date },
      };
    },
  }),
  tool({
    name: "detect_recurring",
    title: "Detect recurring payments",
    description:
      "Scan the last 18 months for payments that repeat (same payee and account, regular interval, similar amount) and store them as suggestions. Accept one with save_recurring (status active) or dismiss it (status dismissed).",
    input: z.object({}),
    readOnly: false,
    run: (_i, { userId }) => ({ suggested: recurringSvc.suggestRecurring(userId) }),
  }),
  tool({
    name: "save_recurring",
    title: "Add or update a recurring payment",
    description:
      "Add a recurring item (omit id) or change one (id): salary (+amount), rent or a subscription (−amount), with its cadence and next expected date. Use status 'active' to accept a suggestion, 'paused' or 'dismissed' to stop it. Statements are matched to it automatically; nothing is created on a schedule.",
    input: recurringSvc.recurringInputSchema.partial().extend({ id: z.number().int().optional() }),
    readOnly: false,
    run: ({ id, ...i }, { userId }) => {
      const r = id ? recurringSvc.updateRecurring(userId, id, i) : recurringSvc.createRecurring(userId, recurringSvc.recurringInputSchema.parse(i));
      recurringSvc.reconcileRecurring(userId);
      return r;
    },
  }),
  tool({
    name: "delete_recurring",
    title: "Delete a recurring payment",
    description: "Delete a recurring item. Transactions already matched to it stay, unlinked.",
    input: z.object({ id: z.number().int() }),
    readOnly: false,
    run: ({ id }, { userId }) => {
      recurringSvc.deleteRecurring(userId, id);
      return { deleted: id };
    },
  }),
  tool({
    name: "record_recurring_payment",
    title: "Record a recurring payment",
    description:
      "Write the transaction for a recurring item that no statement will bring (cash rent, an account you don't import). If a statement later contains the same payment (same account and amount, within 5 days), the import takes this row over instead of duplicating it.",
    input: z.object({ id: z.number().int(), date: isoDate.optional(), amount: z.number().optional() }),
    readOnly: false,
    run: ({ id, date, amount }, { userId }) => {
      const row = recurringSvc.recordOccurrence(userId, id, { date, amount });
      invalidateSqlSandbox(userId);
      return row;
    },
  }),
  tool({
    name: "match_transfers",
    title: "Match transfers between your accounts",
    description:
      "Find money moved between the user's own accounts — an uncategorized outflow on one account and an inflow on another within a few days, equal once converted (within ~2% for FX spread and fees, e.g. AED sent to a EUR account) — and file both sides under Transfers so budgets and cash flow stop counting them as spending and income. Runs automatically after imports; use dryRun to just list the pairs.",
    input: z.object({
      dryRun: z.boolean().default(false),
      from: isoDate.optional(),
      to: isoDate.optional(),
      days: z.number().int().min(0).max(10).default(3).describe("Max days between the two sides"),
      tolerancePct: z.number().min(0).max(10).default(2).describe("Max difference after conversion, %"),
    }),
    readOnly: false,
    run: ({ dryRun, from, to, days, tolerancePct }, { userId }) => {
      const r = matchTransfers(userId, { dryRun, from, to, days, tolerance: tolerancePct / 100 });
      if (r.matched) invalidateSqlSandbox(userId);
      return { matched: r.matched, pairs: r.pairs };
    },
  }),
  tool({
    name: "save_job",
    title: "Add or update a job",
    description:
      "Add a job (or update one with accountId) so its end-of-service gratuity accrues in net worth under the country's law. Countries: AE (UAE mainland: 21 days of basic a year for 5 years then 30, from 1 year, cap 2 years' pay), AE_DIFC (DEWS 5.83%/8.33% of basic a month), SA (half/full month a year, reduced on resignation), QA (3 weeks of basic a year), FR (indemnité légale on dismissal), CUSTOM (days a year). Give the salary the law uses — UAE and Qatar use BASIC salary without allowances — and its currency (e.g. AED). Pass salaries[] for raises. When the gratuity is paid out, archive the account.",
    input: jobsSvc.jobInputSchema,
    readOnly: false,
    run: (i, { userId }) => {
      const { account: _a, ...job } = jobsSvc.saveJob(userId, i);
      invalidateSqlSandbox(userId);
      return job;
    },
  }),
  tool({
    name: "add_loan_event",
    title: "Record an early repayment or a new rate",
    description:
      "For a loan with a schedule: record an early repayment (type prepayment, amount) or a renegotiated rate (type rate_change, ratePct) on a date. keep 'duration' keeps the end date and lowers the payment; keep 'payment' keeps the payment and ends the loan sooner. The balance, remaining interest and end date follow.",
    input: z.object({
      accountId: z.number().int(),
      date: isoDate,
      type: z.enum(["prepayment", "rate_change"]),
      amount: z.number().positive().optional(),
      ratePct: z.number().min(0).max(30).optional(),
      keep: z.enum(["duration", "payment"]).default("duration"),
    }),
    readOnly: false,
    run: ({ accountId, ...ev }, { userId }) => {
      const acc = accountsSvc.getAccountRow(userId, accountId);
      if (!acc.loanParams) throw new Error(`${acc.name} has no loan schedule.`);
      const updated = accountsSvc.updateAccount(userId, accountId, { loanParams: { ...acc.loanParams, events: [...(acc.loanParams.events ?? []), ev] } });
      invalidateSqlSandbox(userId);
      return { account: updated.name, events: updated.loanParams?.events };
    },
  }),
  tool({
    name: "update_account",
    title: "Update account",
    description:
      "Change an account's name, institution, type, currency, ownership share, loan terms, country, company or notes. Changing the currency of an account with recorded balances needs currencyChange: 'relabel' (the currency was wrong, keep the numbers) or 'convert' (it really changed: each past balance is converted at its date's rate).",
    input: accountsSvc.accountInputSchema
      .partial()
      .omit({ initialBalance: true })
      .extend({ accountId: z.number().int(), currencyChange: z.enum(["relabel", "convert"]).optional() }),
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
    name: "sync_connection",
    title: "Sync a brokerage connection",
    description:
      "Pull positions, average prices and cash from a connected brokerage now (normally hourly). Omit connectionId to sync every connection. Read-only at the broker: nothing is ever bought or sold. A failure (bad key, rate limit) comes back as ok: false with the error.",
    input: z.object({ connectionId: z.number().int().optional() }),
    readOnly: false,
    run: async ({ connectionId }, { userId }) => {
      const ids = connectionId ? [connectionId] : connectionsSvc.listConnections(userId).map((c) => c.id);
      const results = [];
      for (const id of ids) results.push(await connectionsSvc.syncConnection(userId, id, { force: true }));
      invalidateSqlSandbox(userId);
      return { results };
    },
  }),
  tool({
    name: "sync_broker_history",
    title: "Import brokerage history",
    description:
      "Import past trades, dividends, deposits, withdrawals and interest from a connected brokerage now (normally twice a day), then rebuild the account's value for every past day from them. full: true re-reads the whole history instead of stopping at what is already imported. Read-only at the broker. A long history takes minutes at the broker's rate limit.",
    input: z.object({ connectionId: z.number().int().optional(), full: z.boolean().default(false) }),
    readOnly: false,
    run: async ({ connectionId, full }, { userId }) => {
      const ids = connectionId ? [connectionId] : connectionsSvc.listConnections(userId).map((c) => c.id);
      const results = [];
      for (const id of ids) results.push(await brokerHistorySvc.syncBrokerHistory(userId, id, { full }));
      invalidateSqlSandbox(userId);
      return { results };
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
    return { ok: true, content: JSON.stringify(present(labelCurrency(t.name, result, ctx.userId))) };
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Make service output model-friendly: `xxxCents` fields become `xxx` in
 * currency units, Dates become ISO strings, Buffers and undefined are dropped.
 */
/** Tools whose amounts aren't the user's money (pure calculators, explicit conversions, raw SQL, file text). */
const UNLABELED = new Set([
  "simulate_mortgage",
  "borrowing_capacity",
  "simulate_buy_vs_rent",
  "convert_currency",
  "search_symbol",
  "query_sql",
  "read_upload",
  "list_uploads",
]);

/**
 * Say which currency the amounts are in. Clients outside the app (MCP) can't
 * know the user's base currency otherwise, and guess. Objects that already
 * carry `currency` keep it; arrays become `{ baseCurrency, items }`.
 */
export function labelCurrency(tool: string, value: unknown, uid: string): unknown {
  if (UNLABELED.has(tool) || value === null || typeof value !== "object" || value instanceof Date) return value;
  const baseCurrency = getSettings(uid).currency;
  if (Array.isArray(value)) return { baseCurrency, items: value };
  if ("currency" in value || "baseCurrency" in value) return value;
  return { baseCurrency, ...value };
}

export function present(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) return value.map(present);
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || k === "userId") continue; // always the caller: noise for the model
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
