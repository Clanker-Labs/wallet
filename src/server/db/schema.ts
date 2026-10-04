import { sql } from "drizzle-orm";
import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { AccountType, AssetClass, HoldingType, LoanParams } from "@/lib/domain";

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

// ── People & auth ────────────────────────────────────────────────────────

/** A person with their own private wallet. The first user is the owner. */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").$type<"owner" | "member">().notNull().default("member"),
  /** Telegram chat linked to this user (reminders + bot commands). */
  telegramChatId: integer("telegram_chat_id").unique(),
  createdAt: createdAt(),
});

/** WebAuthn credentials (passkeys). A user can have several (phone, laptop…). */
export const passkeys = sqliteTable(
  "passkeys",
  {
    /** Credential ID, base64url. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    publicKey: blob("public_key", { mode: "buffer" }).notNull(),
    counter: integer("counter").notNull().default(0),
    transports: text("transports", { mode: "json" }).$type<string[]>(),
    deviceType: text("device_type"),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
    /** Human label, e.g. "iPhone" or "MacBook". */
    name: text("name"),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("passkeys_user").on(t.userId)],
);

/** Login sessions. `id` is the SHA-256 of the cookie token, never the token itself. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

/** Short-lived WebAuthn challenges and one-time codes (Telegram linking). */
export const authChallenges = sqliteTable("auth_challenges", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<"register" | "login" | "add_passkey" | "telegram_link" | "magic_link">().notNull(),
  challenge: text("challenge").notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  /** Name chosen at sign-up, kept until the passkey is verified. */
  pendingName: text("pending_name"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

const userId = () =>
  text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

// ── Money ────────────────────────────────────────────────────────────────

/**
 * Anything that holds or owes money: bank accounts, brokerage, property, loans.
 * Balances are in the account's own currency. Liabilities store the amount
 * owed as a positive balance.
 */
export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: userId(),
    name: text("name").notNull(),
    institution: text("institution"),
    type: text("type").$type<AccountType>().notNull(),
    assetClass: text("asset_class").$type<AssetClass>().notNull(),
    /** ISO 4217 code (or a crypto/metal code like BTC, XAU). */
    currency: text("currency").notNull().default("USD"),
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
  },
  (t) => [index("accounts_user").on(t.userId)],
);

export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** ISO date (YYYY-MM-DD). One snapshot per account per day. */
    date: text("date").notNull(),
    /** In the account's currency. */
    balanceCents: integer("balance_cents").notNull(),
    note: text("note"),
    source: text("source").notNull().default("manual"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("balance_snapshots_account_date").on(t.accountId, t.date)],
);

/**
 * A position inside an account: stock, ETF, fund, bond, crypto, commodity…
 * When an account has holdings, its balance is their market value.
 */
export const holdings = sqliteTable(
  "holdings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: userId(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Market symbol (Yahoo Finance style: AAPL, CW8.PA, BTC-USD, GC=F). Null for manual assets. */
    symbol: text("symbol"),
    name: text("name").notNull(),
    assetType: text("asset_type").$type<HoldingType>().notNull(),
    quantity: real("quantity").notNull(),
    /** Currency the price is quoted in. */
    currency: text("currency").notNull().default("USD"),
    /** Average cost per unit, in `currency`. */
    costBasis: real("cost_basis"),
    /** Price per unit used when there is no market symbol (or to override it). */
    manualPrice: real("manual_price"),
    createdAt: createdAt(),
  },
  (t) => [index("holdings_account").on(t.accountId), index("holdings_user").on(t.userId)],
);

/** Daily closing prices per market symbol (shared by all users). */
export const prices = sqliteTable(
  "prices",
  {
    symbol: text("symbol").notNull(),
    date: text("date").notNull(),
    close: real("close").notNull(),
    currency: text("currency").notNull(),
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.date] })],
);

/** Exchange rates as units of `currency` per 1 USD, per day (shared by all users). */
export const fxRates = sqliteTable(
  "fx_rates",
  {
    date: text("date").notNull(),
    currency: text("currency").notNull(),
    perUsd: real("per_usd").notNull(),
  },
  (t) => [primaryKey({ columns: [t.currency, t.date] })],
);

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: userId(),
    name: text("name").notNull(),
    kind: text("kind").$type<"income" | "expense" | "transfer">().notNull(),
    icon: text("icon"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("categories_user_name").on(t.userId, t.name)],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: userId(),
    accountId: integer("account_id").references(() => accounts.id, { onDelete: "set null" }),
    date: text("date").notNull(),
    /** Signed, in `currency`: negative = money out, positive = money in. */
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    description: text("description").notNull(),
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    notes: text("notes"),
    /** Dedupe key for imported rows (unique per user). */
    importHash: text("import_hash"),
    source: text("source").notNull().default("manual"),
    createdAt: createdAt(),
  },
  (t) => [
    index("transactions_user_date").on(t.userId, t.date),
    index("transactions_category").on(t.categoryId),
    uniqueIndex("transactions_user_import_hash").on(t.userId, t.importHash),
  ],
);

/** "Description contains <pattern>" → category. Applied on import and on demand. */
export const categoryRules = sqliteTable(
  "category_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: userId(),
    pattern: text("pattern").notNull(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("category_rules_user_pattern").on(t.userId, t.pattern)],
);

/** Monthly envelope per category, in the user's base currency. */
export const budgets = sqliteTable("budgets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: userId(),
  categoryId: integer("category_id")
    .notNull()
    .unique()
    .references(() => categories.id, { onDelete: "cascade" }),
  amountCents: integer("amount_cents").notNull(),
  createdAt: createdAt(),
});

export const reminders = sqliteTable(
  "reminders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: userId(),
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
  },
  (t) => [index("reminders_user").on(t.userId)],
);

export type ReminderKind = "custom" | "balance_update" | "statement" | "monthly_report";
export type ReminderFrequency = "once" | "weekly" | "monthly" | "quarterly" | "yearly";

export const simulations = sqliteTable("simulations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: userId(),
  name: text("name").notNull(),
  type: text("type").$type<"mortgage" | "buy_vs_rent" | "projection">().notNull(),
  params: text("params", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
});

// ── Assistant ────────────────────────────────────────────────────────────

export const agentConversations = sqliteTable("agent_conversations", {
  id: text("id").primaryKey(),
  userId: userId(),
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

/** Files dropped into the assistant (bank CSV / PDF statements, screenshots). */
export const uploads = sqliteTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("uploads_user").on(t.userId)],
);

/** Per-user preferences (base currency, locale, time zone). */
export const settings = sqliteTable(
  "settings",
  {
    userId: userId(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export type User = typeof users.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Holding = typeof holdings.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type Budget = typeof budgets.$inferSelect;
export type Simulation = typeof simulations.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
