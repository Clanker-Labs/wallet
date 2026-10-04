import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { AccountType, AssetClass, LoanParams } from "@/lib/domain";

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

/**
 * Anything that holds or owes money: bank accounts, brokerage, property, loans.
 * Liabilities store the amount owed as a positive balance.
 */
export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  institution: text("institution"),
  type: text("type").$type<AccountType>().notNull(),
  assetClass: text("asset_class").$type<AssetClass>().notNull(),
  /** Share of the account you own (e.g. 50 for a property bought as a couple). */
  ownershipPct: real("ownership_pct").notNull().default(100),
  includeInNetWorth: integer("include_in_net_worth", { mode: "boolean" }).notNull().default(true),
  archivedAt: text("archived_at"),
  /** A mortgage can point at the property it finances, to show equity. */
  linkedAccountId: integer("linked_account_id"),
  /** When set, the balance of a loan is derived from its amortization schedule. */
  loanParams: text("loan_params", { mode: "json" }).$type<LoanParams>(),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** ISO date (YYYY-MM-DD). One snapshot per account per day. */
    date: text("date").notNull(),
    balanceCents: integer("balance_cents").notNull(),
    note: text("note"),
    source: text("source").notNull().default("manual"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("balance_snapshots_account_date").on(t.accountId, t.date)],
);

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  kind: text("kind").$type<"income" | "expense" | "transfer">().notNull(),
  icon: text("icon"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id").references(() => accounts.id, { onDelete: "set null" }),
    date: text("date").notNull(),
    /** Signed: negative = money out, positive = money in. */
    amountCents: integer("amount_cents").notNull(),
    description: text("description").notNull(),
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    notes: text("notes"),
    /** Dedupe key for imported rows. */
    importHash: text("import_hash").unique(),
    source: text("source").notNull().default("manual"),
    createdAt: createdAt(),
  },
  (t) => [index("transactions_date").on(t.date), index("transactions_category").on(t.categoryId)],
);

/** "Description contains <pattern>" → category. Applied on import and on demand. */
export const categoryRules = sqliteTable("category_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pattern: text("pattern").notNull().unique(),
  categoryId: integer("category_id")
    .notNull()
    .references(() => categories.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

/** Monthly envelope per category. */
export const budgets = sqliteTable("budgets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  categoryId: integer("category_id")
    .notNull()
    .unique()
    .references(() => categories.id, { onDelete: "cascade" }),
  amountCents: integer("amount_cents").notNull(),
  createdAt: createdAt(),
});

export const reminders = sqliteTable("reminders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  message: text("message"),
  kind: text("kind").$type<ReminderKind>().notNull().default("custom"),
  accountId: integer("account_id").references(() => accounts.id, { onDelete: "set null" }),
  frequency: text("frequency").$type<ReminderFrequency>().notNull(),
  dayOfMonth: integer("day_of_month"),
  /** 1 = Monday … 7 = Sunday */
  dayOfWeek: integer("day_of_week"),
  monthOfYear: integer("month_of_year"),
  /** For one-off reminders (YYYY-MM-DD). */
  date: text("date"),
  timeOfDay: text("time_of_day").notNull().default("09:00"),
  /** Re-send every N hours until acknowledged. 0 = send once. */
  nagEveryHours: integer("nag_every_hours").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
  lastSentAt: integer("last_sent_at", { mode: "timestamp_ms" }),
  nextNagAt: integer("next_nag_at", { mode: "timestamp_ms" }),
  lastMessageId: integer("last_message_id"),
  acknowledgedAt: integer("acknowledged_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
});

export type ReminderKind = "custom" | "balance_update" | "statement" | "monthly_report";
export type ReminderFrequency = "once" | "weekly" | "monthly" | "quarterly" | "yearly";

export const simulations = sqliteTable("simulations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").$type<"mortgage" | "buy_vs_rent" | "projection">().notNull(),
  params: text("params", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
});

export const agentConversations = sqliteTable("agent_conversations", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  channel: text("channel").notNull().default("web"),
  /** Which agent backend owns this thread (anthropic | claude-code | codex). */
  provider: text("provider").notNull().default("anthropic"),
  /** Session id of a local CLI agent, used to resume its thread. */
  externalSessionId: text("external_session_id"),
  createdAt: createdAt(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * Raw API message history (content blocks incl. thinking & tool use), stored
 * append-only so every request replays the exact transcript the model produced.
 */
export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => agentConversations.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant" | "system">().notNull(),
    content: text("content", { mode: "json" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("agent_messages_conversation").on(t.conversationId)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type Account = typeof accounts.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type Budget = typeof budgets.$inferSelect;
export type Simulation = typeof simulations.$inferSelect;
