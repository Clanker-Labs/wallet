import { z } from "zod";
import { readonlyConnection } from "@/server/db/client";
import * as accountsSvc from "@/server/services/accounts";
import * as txSvc from "@/server/services/transactions";
import * as catSvc from "@/server/services/categories";
import * as budgetSvc from "@/server/services/budgets";
import * as reminderSvc from "@/server/services/reminders";
import { netWorthHistory, netWorthOn } from "@/server/services/networth";
import { getOverview } from "@/server/services/overview";
import { getSettings, today } from "@/server/services/settings";
import { purchaseInputSchema, simulatePurchase, capacityInputSchema, borrowingCapacity } from "@/lib/finance/mortgage";
import { buyVsRentInputSchema, simulateBuyVsRent } from "@/lib/finance/buy-vs-rent";
import { blendedAssumptions, projectNetWorth, projectionInputSchema } from "@/lib/finance/projection";
import { isISODate, isMonth, monthBounds } from "@/lib/dates";

/**
 * The single tool surface of the app. The Claude API agent, the MCP server
 * (stdio + HTTP) and local CLI agents all expose exactly these tools.
 */
export interface WalletTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Write tools change data; they can be disabled with WALLET_AGENT_READONLY=1. */
  readOnly: boolean;
  run: (input: z.output<S>) => unknown;
}

function tool<S extends z.ZodObject>(t: WalletTool<S>): WalletTool<S> {
  return t;
}

const isoDate = z.string().refine(isISODate, "Expected YYYY-MM-DD");
const month = z.string().refine(isMonth, "Expected YYYY-MM");

const SQL_SCHEMA = `Tables (amounts are INTEGER cents; dates are TEXT 'YYYY-MM-DD'):
- accounts(id, name, institution, type, asset_class ['cash','investments','retirement','real_estate','crypto','other','liabilities'], ownership_pct, include_in_net_worth, archived_at, linked_account_id, loan_params JSON, notes)
- balance_snapshots(id, account_id, date, balance_cents, note, source) — one row per account per day; liabilities store the amount owed as a positive number
- transactions(id, account_id, date, amount_cents [negative = spending], description, category_id, notes, source)
- categories(id, name, kind ['income','expense','transfer'], icon)
- category_rules(id, pattern, category_id) — lowercase substring of description → category
- budgets(id, category_id, amount_cents) — monthly envelope
- reminders(id, title, message, kind, account_id, frequency, day_of_month, day_of_week, month_of_year, date, time_of_day, nag_every_hours, enabled, next_run_at [ms epoch])
- simulations(id, name, type, params JSON)`;

export const TOOLS = [
  tool({
    name: "get_overview",
    title: "Financial overview",
    description:
      "Snapshot of the user's finances: net worth (total, assets, liabilities, per asset class), change over 1 month / YTD / 1 year, this month's budget status, the last 6 months of cash flow, upcoming reminders and a list of things that need attention. Start here for any broad question.",
    input: z.object({}),
    readOnly: true,
    run: () => {
      const o = getOverview();
      return { ...o, netWorth: { ...o.netWorth, accounts: undefined } };
    },
  }),
  tool({
    name: "get_net_worth",
    title: "Net worth breakdown",
    description:
      "Net worth on a date (default today) with every account's balance, ownership share and contribution. Loans with an amortization schedule are computed automatically.",
    input: z.object({ date: isoDate.optional().describe("YYYY-MM-DD, default today") }),
    readOnly: true,
    run: ({ date }) => netWorthOn(date),
  }),
  tool({
    name: "get_net_worth_history",
    title: "Net worth history",
    description: "Month-end net worth (total and per asset class) for the last N months, plus today.",
    input: z.object({ months: z.number().int().min(1).max(240).default(24) }),
    readOnly: true,
    run: ({ months }) => netWorthHistory(months),
  }),
  tool({
    name: "list_accounts",
    title: "List accounts",
    description:
      "All accounts with type, asset class, current balance, ownership share, and the date the balance was last updated.",
    input: z.object({ includeArchived: z.boolean().default(false) }),
    readOnly: true,
    run: ({ includeArchived }) => accountsSvc.listAccounts({ includeArchived }),
  }),
  tool({
    name: "get_account",
    title: "Account details",
    description: "One account with its full balance history (snapshots).",
    input: z.object({ accountId: z.number().int() }),
    readOnly: true,
    run: ({ accountId }) => accountsSvc.getAccount(accountId),
  }),
  tool({
    name: "list_transactions",
    title: "List transactions",
    description:
      "Transactions, newest first, with category and account names. Filter by date range, account, category (use \"none\" for uncategorized) or a description search.",
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
    run: (f) => txSvc.listTransactions(f),
  }),
  tool({
    name: "get_spending_by_category",
    title: "Spending by category",
    description: "Total spending per expense category over a date range (default: current month), largest first.",
    input: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
    readOnly: true,
    run: ({ from, to }) => {
      const m = monthBounds(today().slice(0, 7));
      return budgetSvc.spendingByCategory(from ?? m.start, to ?? m.end);
    },
  }),
  tool({
    name: "get_budget_status",
    title: "Budget status",
    description:
      "For a month (default current): income, expenses, savings rate, and each category's budget vs spending with a status (ok / ahead_of_pace / over / unbudgeted).",
    input: z.object({ month: month.optional().describe("YYYY-MM") }),
    readOnly: true,
    run: ({ month }) => budgetSvc.budgetStatus(month),
  }),
  tool({
    name: "get_cashflow",
    title: "Monthly cash flow",
    description: "Income, expenses, net savings and savings rate per month for the last N months (transfers excluded).",
    input: z.object({ months: z.number().int().min(1).max(60).default(12) }),
    readOnly: true,
    run: ({ months }) => budgetSvc.cashflow(months),
  }),
  tool({
    name: "list_categories",
    title: "Categories & rules",
    description: "Transaction categories (with ids and kind) and the auto-categorization rules.",
    input: z.object({}),
    readOnly: true,
    run: () => ({ categories: catSvc.listCategories(), rules: catSvc.listRules(), budgets: budgetSvc.listBudgets() }),
  }),
  tool({
    name: "list_reminders",
    title: "List reminders",
    description: "Telegram reminders with their schedule, next run time and whether they're waiting to be acknowledged.",
    input: z.object({}),
    readOnly: true,
    run: () => reminderSvc.listReminders(),
  }),
  tool({
    name: "query_sql",
    title: "Read-only SQL",
    description: `Run a read-only SQLite SELECT for analysis the other tools don't cover. Returns at most 500 rows.\n${SQL_SCHEMA}`,
    input: z.object({ sql: z.string().min(1).describe("A single SELECT (or WITH … SELECT) statement") }),
    readOnly: true,
    run: ({ sql }) => runReadonlySql(sql),
  }),
  tool({
    name: "simulate_mortgage",
    title: "Mortgage / purchase simulator",
    description:
      "Simulate buying a property with a mortgage (French defaults: notary fees, borrower insurance on initial capital, guarantee fees, HCSF 35% debt-to-income cap). Returns loan amount, monthly payment, total credit cost, APR, debt ratio and a yearly amortization/equity table.",
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
    run: (i) => {
      const nw = netWorthOn();
      const blended = blendedAssumptions(nw.byClassCents);
      const savings = budgetSvc.averageMonthlySavings(6);
      const assumptions = {
        startingNetWorth: nw.netCents / 100,
        monthlyContribution: Math.max(0, savings.netCents / 100),
        annualReturnPct: blended.returnPct,
        volatilityPct: blended.volatilityPct,
        annualExpenses: savings.expensesCents > 0 ? (savings.expensesCents * 12) / 100 : undefined,
      };
      const input = { ...assumptions, ...stripUndefined(i) };
      return { assumptions: input, result: projectNetWorth(input) };
    },
  }),

  // ── Writes ──────────────────────────────────────────────────────────────
  tool({
    name: "record_balance",
    title: "Record account balance",
    description:
      "Set an account's balance for a date (default today), e.g. after the user reads it from their bank app. For loans, pass the amount still owed.",
    input: z.object({
      accountId: z.number().int(),
      balance: z.number(),
      date: isoDate.optional(),
      note: z.string().max(500).optional(),
    }),
    readOnly: false,
    run: (i) => accountsSvc.recordBalance({ ...i, source: "agent" }),
  }),
  tool({
    name: "add_transaction",
    title: "Add transaction",
    description:
      "Add a transaction. Amount is signed: negative for spending, positive for income. If categoryId is omitted, categorization rules are applied.",
    input: z.object({
      date: isoDate.optional(),
      amount: z.number(),
      description: z.string().min(1),
      categoryId: z.number().int().optional(),
      accountId: z.number().int().optional(),
      notes: z.string().optional(),
    }),
    readOnly: false,
    run: (i) => txSvc.addTransaction({ ...i, source: "agent" }),
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
    run: ({ transactionIds, categoryId, rememberPattern }) =>
      txSvc.categorizeTransactions(transactionIds, categoryId, rememberPattern),
  }),
  tool({
    name: "create_category",
    title: "Create category",
    description: "Create a transaction category.",
    input: catSvc.categoryInputSchema,
    readOnly: false,
    run: (i) => catSvc.createCategory(i),
  }),
  tool({
    name: "set_budget",
    title: "Set monthly budget",
    description: "Set the monthly budget of an expense category. 0 removes the budget.",
    input: z.object({ categoryId: z.number().int(), monthlyAmount: z.number().min(0) }),
    readOnly: false,
    run: ({ categoryId, monthlyAmount }) => budgetSvc.setBudget(categoryId, monthlyAmount) ?? { removed: true },
  }),
  tool({
    name: "create_account",
    title: "Create account",
    description:
      "Create an account (bank, savings, brokerage, property, loan…). For an amortizing loan pass loanParams so its balance is computed automatically.",
    input: accountsSvc.accountInputSchema,
    readOnly: false,
    run: (i) => accountsSvc.createAccount(i),
  }),
  tool({
    name: "create_reminder",
    title: "Create reminder",
    description:
      "Create a Telegram reminder (e.g. monthly on the 3rd at 19:00: import the bank statement). kind balance_update with accountId lets the user reply with the new balance. nagEveryHours re-sends until acknowledged.",
    input: reminderSvc.reminderInputSchema,
    readOnly: false,
    run: (i) => reminderSvc.createReminder(i),
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

/** Validate input, run the tool and serialize its result for a model. */
export async function callTool(name: string, rawInput: unknown): Promise<ToolCallResult> {
  const t = enabledTools().find((x) => x.name === name);
  if (!t) return { ok: false, content: `Unknown or disabled tool: ${name}` };
  const parsed = t.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, content: `Invalid input: ${z.prettifyError(parsed.error)}` };
  }
  try {
    const result = await t.run(parsed.data);
    return { ok: true, content: JSON.stringify(present(result)) };
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Make service output model-friendly: `xxxCents` fields become `xxx` in
 * currency units, Dates become ISO strings, undefined is dropped.
 */
export function present(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
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
    } else out[k] = present(v);
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

const MAX_ROWS = 500;

export function runReadonlySql(sql: string) {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (trimmed.includes(";")) throw new Error("Only a single statement is allowed");
  const conn = readonlyConnection();
  const stmt = conn.prepare(trimmed);
  if (!stmt.reader || !stmt.readonly) throw new Error("Only read-only SELECT statements are allowed");
  const rows: unknown[] = [];
  for (const row of stmt.iterate()) {
    rows.push(row);
    if (rows.length >= MAX_ROWS) break;
  }
  return { rows, truncated: rows.length >= MAX_ROWS, note: "Amounts are in cents" };
}

export function currencyNote(): string {
  const s = getSettings();
  return `${s.currency} (${s.locale})`;
}
