import { beforeEach, describe, expect, it } from "vitest";
import { createDb, setDbForTests } from "@/server/db/client";
import { createAccount, listAccounts } from "@/server/services/accounts";
import { setBudget } from "@/server/services/budgets";
import { findCategory } from "@/server/services/categories";
import { acknowledgeReminder, createReminder, getReminder, markSent } from "@/server/services/reminders";
import { addTransaction, listTransactions } from "@/server/services/transactions";
import type { SendOptions, TgUpdate } from "@/server/telegram/api";
import {
  handleUpdate,
  parseAmountOnly,
  parseCommand,
  resolveCategoryAndNote,
  splitLeadingAmount,
  splitTrailingAmount,
  type AgentPort,
  type BotContext,
} from "@/server/telegram/bot";
import { markdownToHtml, renderHelp, renderReminder, renderReminders, splitMessage } from "@/server/telegram/messages";
import { tick } from "@/server/telegram/scheduler";

process.env.WALLET_TIMEZONE = "UTC";

const PRIMARY = 111;
const SECONDARY = 222;
const STRANGER = 999;
const HOUR = 3_600_000;

function fakeApi(opts: { failSend?: boolean } = {}) {
  let nextMessageId = 500;
  const sent: { chatId: number; text: string; opts?: SendOptions; messageId: number }[] = [];
  const answers: { id: string; text?: string }[] = [];
  const edits: { chatId: number; messageId: number }[] = [];
  return {
    sent,
    answers,
    edits,
    async sendMessage(chatId: number, text: string, o?: SendOptions) {
      if (opts.failSend) throw new Error("network down");
      const messageId = nextMessageId++;
      sent.push({ chatId, text, opts: o, messageId });
      return messageId;
    },
    async editMessageReplyMarkup(chatId: number, messageId: number) {
      edits.push({ chatId, messageId });
    },
    async answerCallbackQuery(id: string, text?: string) {
      answers.push({ id, text });
    },
    async sendChatAction() {},
  };
}

function fakeAgent(opts: { ready?: boolean; reason?: string; reply?: string; fail?: Error } = {}) {
  const calls: { conversationId?: string; message: string }[] = [];
  const port: AgentPort = {
    status: () => ({ ready: opts.ready ?? true, reason: opts.reason }),
    async run(o) {
      calls.push({ conversationId: o.conversationId, message: o.message });
      if (opts.fail) throw opts.fail;
      return { conversationId: `conv-${calls.length}`, text: opts.reply ?? "You spent **€42**." };
    },
  };
  return { calls, load: async () => port };
}

let api: ReturnType<typeof fakeApi>;
let agent: ReturnType<typeof fakeAgent>;
let ctx: BotContext;
let updateId = 1;

function textUpdate(chatId: number, text: string, replyToMessageId?: number): TgUpdate {
  const chat = { id: chatId, type: "private" };
  return {
    update_id: updateId++,
    message: {
      message_id: 10_000 + updateId,
      date: 0,
      chat,
      text,
      ...(replyToMessageId ? { reply_to_message: { message_id: replyToMessageId, date: 0, chat } } : {}),
    },
  };
}

function callbackUpdate(chatId: number, data: string, messageId = 700): TgUpdate {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: chatId },
      data,
      message: { message_id: messageId, date: 0, chat: { id: chatId, type: "private" } },
    },
  };
}

/** Send a message as a chat and return the bot's replies. */
async function say(text: string, chatId = PRIMARY, replyTo?: number) {
  const before = api.sent.length;
  await handleUpdate(textUpdate(chatId, text, replyTo), ctx);
  return api.sent.slice(before).map((m) => m.text);
}

/** Telegram rejects stray "<", ">" and "&" in HTML mode: only these tags and entities may appear. */
function expectTelegramHtml(html: string) {
  const text = html.replace(/<\/?(b|i|code|pre)>|<a href="[^"<>]*">|<\/a>/g, "");
  expect(text).not.toMatch(/[<>]/);
  expect(text).not.toMatch(/&(?!(amp|lt|gt|quot);)/);
}

const balanceOf = (name: string) => listAccounts().find((a) => a.name === name)?.balanceCents;

beforeEach(() => {
  setDbForTests(createDb(":memory:"));
  api = fakeApi();
  agent = fakeAgent();
  ctx = { api, allowedChatIds: [PRIMARY, SECONDARY], agent: agent.load, conversations: new Map(), log: () => {} };
});

describe("parsing", () => {
  it("parses commands, args and bot mentions", () => {
    expect(parseCommand("/balance livret a 1 234,56")).toEqual({ command: "balance", args: "livret a 1 234,56" });
    expect(parseCommand("/NW@WalletBot", "walletbot")).toEqual({ command: "nw", args: "" });
    expect(parseCommand("/budget@OtherBot 2026-09", "WalletBot")).toBeNull();
    expect(parseCommand("hello there")).toBeNull();
  });

  it("splits a trailing amount, including space-separated thousands", () => {
    expect(splitTrailingAmount("livret a 1 234,56")).toEqual({ rest: "livret a", amount: 1234.56 });
    expect(splitTrailingAmount("pea 12.5k")).toEqual({ rest: "pea", amount: 12500 });
    expect(splitTrailingAmount("PEA 2 5000")).toEqual({ rest: "PEA 2", amount: 5000 });
    expect(splitTrailingAmount("compte courant 1 500 €")).toEqual({ rest: "compte courant", amount: 1500 });
    expect(splitTrailingAmount("livret a")).toBeNull();
  });

  it("splits a leading amount and recognizes amount-only text", () => {
    expect(splitLeadingAmount("1 234,56 rent — june")).toEqual({ amount: 1234.56, rest: "rent — june" });
    expect(splitLeadingAmount("12 eur groceries")).toEqual({ amount: 12, rest: "groceries" });
    expect(splitLeadingAmount("groceries 12")).toBeNull();
    expect(parseAmountOnly("2 500")).toBe(2500);
    expect(parseAmountOnly("€ 42")).toBe(42);
    expect(parseAmountOnly("I have 5 apples")).toBeNull();
    expect(parseAmountOnly("done")).toBeNull();
  });

  it("resolves the category from the longest leading words; the rest is the note", () => {
    expect(resolveCategoryAndNote("groceries — lunch with Bob")).toMatchObject({
      category: { name: "Groceries" },
      note: "lunch with Bob",
    });
    expect(resolveCategoryAndNote("restaurants dinner")).toMatchObject({
      category: { name: "Restaurants & bars" },
      note: "dinner",
    });
    // "the" appears inside "Other expenses" but doesn't start a word.
    expect(resolveCategoryAndNote("the cinema").category).toBeUndefined();
  });
});

describe("allowlist", () => {
  it("answers /start from a stranger with their chat id only", async () => {
    createAccount({ name: "Livret A", type: "savings", initialBalance: 1000 });
    const replies = await say("/start", STRANGER);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(String(STRANGER));
    expect(replies[0]).toContain("TELEGRAM_CHAT_ID");
    expect(replies[0]).not.toContain("€");
  });

  it("ignores everything else from strangers", async () => {
    createAccount({ name: "Livret A", type: "savings", initialBalance: 1000 });
    expect(await say("/networth", STRANGER)).toEqual([]);
    expect(await say("/balance livret 5", STRANGER)).toEqual([]);
    expect(await say("what's my net worth?", STRANGER)).toEqual([]);
    expect(balanceOf("Livret A")).toBe(100_000);
    expect(agent.calls).toHaveLength(0);

    const r = createReminder({ title: "Pay rent", frequency: "monthly", dayOfMonth: 1, nagEveryHours: 2 });
    await handleUpdate(callbackUpdate(STRANGER, `done:${r.id}`), ctx);
    expect(api.answers).toHaveLength(0);
    expect(getReminder(r.id)?.acknowledgedAt).toBeNull();
  });
});

describe("/balance", () => {
  it("records the balance of the single matching account", async () => {
    createAccount({ name: "Livret A", institution: "BoursoBank", type: "savings", initialBalance: 1000 });
    createAccount({ name: "PEA", type: "pea", initialBalance: 5000 });
    const [reply] = await say("/balance livret 1 234,56");
    expect(balanceOf("Livret A")).toBe(123_456);
    expect(reply).toContain("€1,000.00 → <b>€1,234.56</b>");
    expect(listAccounts().find((a) => a.name === "PEA")?.balanceCents).toBe(500_000);
  });

  it("asks to be more specific when several accounts match", async () => {
    createAccount({ name: "Livret A", type: "savings", initialBalance: 1000 });
    createAccount({ name: "Livret Jeune", type: "savings", initialBalance: 200 });
    const [reply] = await say("/balance livret 500");
    expect(reply).toContain("Livret A");
    expect(reply).toContain("Livret Jeune");
    expect(reply).toContain("more specific");
    expect(balanceOf("Livret A")).toBe(100_000);
    expect(balanceOf("Livret Jeune")).toBe(20_000);
  });

  it("reports unknown accounts and bad usage", async () => {
    createAccount({ name: "Livret A", type: "savings" });
    expect((await say("/balance boursorama 10"))[0]).toContain("No account matches");
    expect((await say("/balance livret"))[0]).toContain("Usage");
  });
});

describe("/spent and /earned", () => {
  it("adds an expense in the matched category with a note", async () => {
    const [reply] = await say("/spent 12,50 groceries — lunch with Bob");
    const [tx] = listTransactions().rows;
    expect(tx).toMatchObject({ amountCents: -1250, categoryName: "Groceries", description: "lunch with Bob", source: "telegram" });
    expect(reply).toContain("€12.50");
  });

  it("falls back to uncategorized and says so", async () => {
    const [reply] = await say("/spent 5 zzzz");
    const [tx] = listTransactions().rows;
    expect(tx.amountCents).toBe(-500);
    expect(tx.categoryId).toBeNull();
    expect(reply).toContain("uncategorized");
  });

  it("adds income", async () => {
    await say("/earned 2 500 salary");
    expect(listTransactions().rows[0]).toMatchObject({ amountCents: 250_000, categoryName: "Salary" });
  });
});

describe("reminder replies", () => {
  it("updates the linked account when replying with an amount", async () => {
    const account = createAccount({ name: "Livret A", type: "savings", initialBalance: 1000 });
    const r = createReminder({
      title: "Update Livret A",
      kind: "balance_update",
      accountId: account.id,
      frequency: "monthly",
      dayOfMonth: 1,
      nagEveryHours: 4,
    });
    markSent(r.id, 555, { nag: false });
    expect(getReminder(r.id)?.nextNagAt).not.toBeNull();

    const [reply] = await say("2 500", PRIMARY, 555);
    expect(balanceOf("Livret A")).toBe(250_000);
    expect(reply).toContain("€2,500.00");
    const after = getReminder(r.id)!;
    expect(after.acknowledgedAt).not.toBeNull();
    expect(after.nextNagAt).toBeNull();
    expect(api.edits).toContainEqual({ chatId: PRIMARY, messageId: 555 });
    expect(agent.calls).toHaveLength(0);
  });

  it("acknowledges a reminder without account and says noted", async () => {
    const r = createReminder({ title: "Check savings", frequency: "monthly", dayOfMonth: 1, nagEveryHours: 4 });
    markSent(r.id, 556, { nag: false });
    const [reply] = await say("300", PRIMARY, 556);
    expect(reply).toContain("Noted");
    expect(getReminder(r.id)?.acknowledgedAt).not.toBeNull();
  });

  it("sends other replies to the agent", async () => {
    const r = createReminder({ title: "Check savings", frequency: "monthly", dayOfMonth: 1, nagEveryHours: 4 });
    markSent(r.id, 557, { nag: false });
    await say("what should I check?", PRIMARY, 557);
    expect(agent.calls).toHaveLength(1);
    expect(getReminder(r.id)?.acknowledgedAt).toBeNull();
  });
});

describe("reminder buttons", () => {
  function sentReminder() {
    const r = createReminder({ title: "Pay rent", frequency: "monthly", dayOfMonth: 1, nagEveryHours: 2 });
    markSent(r.id, 700, { nag: false });
    return r;
  }

  it("done acknowledges, toasts and removes the keyboard", async () => {
    const r = sentReminder();
    await handleUpdate(callbackUpdate(PRIMARY, `done:${r.id}`), ctx);
    expect(getReminder(r.id)?.acknowledgedAt).not.toBeNull();
    expect(getReminder(r.id)?.nextNagAt).toBeNull();
    expect(api.answers[0].text).toContain("Done");
    expect(api.edits).toEqual([{ chatId: PRIMARY, messageId: 700 }]);
  });

  it("snooze pushes the next nag", async () => {
    const r = sentReminder();
    const before = Date.now();
    await handleUpdate(callbackUpdate(SECONDARY, `snooze:${r.id}:3`), ctx);
    const nag = getReminder(r.id)!.nextNagAt!.getTime();
    expect(nag).toBeGreaterThanOrEqual(before + 3 * HOUR);
    expect(nag).toBeLessThan(before + 3 * HOUR + 60_000);
    expect(api.answers[0].text).toContain("3h");
    expect(api.edits).toEqual([{ chatId: SECONDARY, messageId: 700 }]);
  });

  it("rejects unknown actions without touching the keyboard", async () => {
    await handleUpdate(callbackUpdate(PRIMARY, "explode:1"), ctx);
    expect(api.answers[0].text).toContain("Unknown");
    expect(api.edits).toHaveLength(0);
  });
});

describe("scheduler", () => {
  it("sends due reminders once to every chat, then nags until done", async () => {
    const r = createReminder({ title: "Pay rent", frequency: "weekly", dayOfWeek: 1, nagEveryHours: 2 });
    const due = new Date(r.nextRunAt!.getTime() + 60_000);
    const chats = [PRIMARY, SECONDARY];
    const quiet = () => {};

    expect(await tick(new Date(r.nextRunAt!.getTime() - 60_000), api, chats, quiet)).toEqual({ sent: 0, nagged: 0, failed: 0 });

    expect(await tick(due, api, chats, quiet)).toEqual({ sent: 1, nagged: 0, failed: 0 });
    expect(api.sent.map((m) => m.chatId)).toEqual(chats);
    expect(api.sent[0].text).toContain("Pay rent");
    expect(api.sent[0].opts?.replyMarkup?.inline_keyboard[0].map((b) => b.callback_data)).toEqual([
      `done:${r.id}`,
      `snooze:${r.id}:3`,
      `snooze:${r.id}:24`,
    ]);
    const afterSend = getReminder(r.id)!;
    expect(afterSend.lastMessageId).toBe(api.sent[0].messageId);
    expect(afterSend.nextRunAt!.getTime()).toBe(r.nextRunAt!.getTime() + 7 * 24 * HOUR);

    // Same moment again (e.g. after a restart): nothing new.
    expect(await tick(due, api, chats, quiet)).toEqual({ sent: 0, nagged: 0, failed: 0 });
    expect(api.sent).toHaveLength(2);

    const nagTime = new Date(due.getTime() + 2 * HOUR + 60_000);
    expect(await tick(nagTime, api, chats, quiet)).toEqual({ sent: 0, nagged: 1, failed: 0 });
    expect(api.sent[2].text).toContain("Still pending");
    expect(getReminder(r.id)!.lastMessageId).toBe(api.sent[2].messageId);

    acknowledgeReminder(r.id);
    expect(await tick(new Date(nagTime.getTime() + 5 * HOUR), api, chats, quiet)).toEqual({ sent: 0, nagged: 0, failed: 0 });
  });

  it("retries on the next tick when nothing could be delivered", async () => {
    const r = createReminder({ title: "Pay rent", frequency: "weekly", dayOfWeek: 1 });
    const due = new Date(r.nextRunAt!.getTime() + 60_000);
    expect(await tick(due, fakeApi({ failSend: true }), [PRIMARY], () => {})).toEqual({ sent: 0, nagged: 0, failed: 1 });
    expect(getReminder(r.id)!.lastSentAt).toBeNull();
    expect(await tick(due, api, [PRIMARY], () => {})).toEqual({ sent: 1, nagged: 0, failed: 0 });
  });
});

describe("rendering", () => {
  it("renders each reminder kind", () => {
    const account = createAccount({ name: "Livret <A>", type: "savings", initialBalance: 1000 });
    const balance = createReminder({ title: "Balances", kind: "balance_update", accountId: account.id, frequency: "monthly" });
    expect(renderReminder(balance)).toContain("Reply to this message");
    expect(renderReminder(balance)).toContain("Livret &lt;A&gt;");

    process.env.WALLET_PUBLIC_URL = "https://wallet.example.com/";
    const statement = createReminder({ title: "Statement", kind: "statement", frequency: "monthly" });
    expect(renderReminder(statement)).toContain('href="https://wallet.example.com/transactions/import"');
    delete process.env.WALLET_PUBLIC_URL;

    const groceries = findCategory("groceries")!;
    setBudget(groceries.id, 100);
    const report = createReminder({ title: "Monthly report", kind: "monthly_report", frequency: "monthly" });
    setBudget(findCategory("restaurants")!.id, 50);
    addTransaction({ amount: -80, description: "Dinner", categoryId: findCategory("restaurants")!.id });
    const text = renderReminder(report);
    expect(text).toContain("Net worth: €1,000");
    expect(text).toContain("1 month");

    for (const r of [balance, statement, report]) expectTelegramHtml(renderReminder(r));
    expectTelegramHtml(renderReminders());

    const custom = createReminder({ title: "Call the bank", message: "Ask about fees", frequency: "monthly" });
    expect(renderReminder(custom, { nag: true })).toBe("🔁 Still pending: <b>Call the bank</b>\nAsk about fees");
  });

  it("renders /networth and /budget", async () => {
    createAccount({ name: "Livret A", type: "savings", initialBalance: 1000 });
    createAccount({ name: "PEA", type: "pea", initialBalance: 3000 });
    const [nw] = await say("/nw");
    expect(nw).toContain("Net worth: €4,000");
    expect(nw).toContain("Investments: €3,000 · 75%");
    expect(nw).toContain("YTD");
    expectTelegramHtml(nw);

    const groceries = findCategory("groceries")!;
    setBudget(groceries.id, 500);
    addTransaction({ amount: -600, description: "Big shop", categoryId: groceries.id });
    const [budget] = await say("/budget");
    expect(budget).toContain("🔴 🛒 <b>Groceries</b>");
    expect(budget).toContain("▓▓▓▓▓▓▓▓ 120% · €600 / €500");
    expectTelegramHtml(budget);
    expectTelegramHtml((await say("/spent 20 restaurants & bars — pizza"))[0]);
    expect((await say("/budget 2026-13"))[0]).toContain("Usage");
  });

  it("escapes help text and converts agent markdown", () => {
    expect(renderHelp()).toContain("&lt;account&gt;");
    expect(renderHelp()).not.toContain("<account>");
    expectTelegramHtml(renderHelp());
    expect(markdownToHtml("## Total\n- **€42** at `A<B>`")).toBe("<b>Total</b>\n• <b>€42</b> at <code>A&lt;B&gt;</code>");
    expect(splitMessage("a\n".repeat(3000), 4000).every((p) => p.length <= 4000)).toBe(true);
  });
});

describe("agent", () => {
  it("keeps one rolling conversation per chat; /new resets it", async () => {
    const [answer] = await say("how much did I spend?");
    expect(answer).toBe("You spent <b>€42</b>.");
    await say("/ask and last month?");
    await say("/new");
    await say("hello again");
    expect(agent.calls).toEqual([
      { conversationId: undefined, message: "how much did I spend?" },
      { conversationId: "conv-1", message: "and last month?" },
      { conversationId: undefined, message: "hello again" },
    ]);
  });

  it("replies with help when the agent is not ready", async () => {
    ctx.agent = fakeAgent({ ready: false, reason: "no API key" }).load;
    const [reply] = await say("hello");
    expect(reply).toContain("no API key");
    expect(reply).toContain("/networth");
  });

  it("reports handler errors instead of crashing", async () => {
    ctx.agent = fakeAgent({ fail: new Error("boom") }).load;
    expect(await say("/ask anything")).toEqual(["⚠️ boom"]);
    expect((await say("/ask"))[0]).toContain("Usage");
  });
});

describe("/update walkthrough", () => {
  it("asks for each account, stalest first, then summarizes", async () => {
    createAccount({ name: "Checking", type: "checking", initialBalance: 1_000 });
    createAccount({ name: "PEA", type: "pea" }); // never updated → asked first
    createAccount({
      name: "Mortgage",
      type: "mortgage",
      loanParams: { principal: 100_000, annualRatePct: 1, durationMonths: 120, startDate: "2026-01-05" },
    }); // amortizes on its own → skipped by the walkthrough

    await handleUpdate(textUpdate(PRIMARY, "/update"), ctx);
    expect(api.sent.at(-1)!.text).toContain("1/2 · PEA");

    await handleUpdate(textUpdate(PRIMARY, "12 500"), ctx);
    expect(api.sent.at(-1)!.text).toContain("2/2 · Checking");
    expect(listAccounts().find((a) => a.name === "PEA")!.balanceCents).toBe(12_500_00);

    await handleUpdate(textUpdate(PRIMARY, "what?"), ctx);
    expect(api.sent.at(-1)!.text).toMatch(/Send a number/);
    expect(agent.calls).toHaveLength(0); // not forwarded to the assistant

    await handleUpdate(textUpdate(PRIMARY, "skip"), ctx);
    expect(api.sent.at(-1)!.text).toMatch(/1 updated, 1 skipped/);

    // Walkthrough is over: plain text goes to the assistant again.
    await handleUpdate(textUpdate(PRIMARY, "how am I doing?"), ctx);
    expect(agent.calls).toHaveLength(1);
  });

  it("starts from a general balance reminder's button", async () => {
    createAccount({ name: "Livret A", type: "savings" });
    const r = createReminder({ title: "Update balances", kind: "balance_update", frequency: "monthly", dayOfMonth: 1 });
    const keyboard = (await import("@/server/telegram/messages")).reminderKeyboard(r);
    expect(keyboard.inline_keyboard[0][0].callback_data).toBe("walk:start");
    await handleUpdate(
      { update_id: updateId++, callback_query: { id: "cb1", from: { id: PRIMARY }, data: "walk:start", message: { message_id: 1, date: 0, chat: { id: PRIMARY, type: "private" } } } } as TgUpdate,
      ctx,
    );
    expect(api.sent.at(-1)!.text).toContain("1/1 · Livret A");
    await handleUpdate(textUpdate(PRIMARY, "stop"), ctx);
    expect(api.sent.at(-1)!.text).toMatch(/0 updated/);
  });
});
