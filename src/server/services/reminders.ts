import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { accounts, reminders, type Reminder } from "@/server/db/schema";
import { nextOccurrence, describeRule } from "@/lib/schedule";
import { isISODate } from "@/lib/dates";
import { getSettings } from "./settings";

export const reminderInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    message: z.string().max(1000).nullish(),
    kind: z.enum(["custom", "balance_update", "statement", "monthly_report"]).default("custom"),
    accountId: z.number().int().nullish().describe("For balance_update: the account to update"),
    frequency: z.enum(["once", "weekly", "monthly", "quarterly", "yearly"]),
    dayOfMonth: z.number().int().min(1).max(31).nullish(),
    dayOfWeek: z.number().int().min(1).max(7).nullish().describe("1 = Monday … 7 = Sunday"),
    monthOfYear: z.number().int().min(1).max(12).nullish(),
    date: z.string().refine(isISODate, "Expected YYYY-MM-DD").nullish(),
    timeOfDay: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm")
      .default("09:00"),
    nagEveryHours: z.number().int().min(0).max(168).default(0).describe("Re-send every N hours until marked done"),
    enabled: z.boolean().default(true),
  })
  .refine((r) => r.frequency !== "once" || !!r.date, { message: "One-off reminders need a date", path: ["date"] });
export type ReminderInput = z.input<typeof reminderInputSchema>;

function computeNext(r: Pick<Reminder, "frequency" | "dayOfMonth" | "dayOfWeek" | "monthOfYear" | "date" | "timeOfDay">, after = new Date()) {
  return nextOccurrence(r, after, getSettings().timezone);
}

export function listReminders() {
  return db()
    .select({ reminder: reminders, accountName: accounts.name })
    .from(reminders)
    .leftJoin(accounts, eq(accounts.id, reminders.accountId))
    .orderBy(asc(reminders.nextRunAt))
    .all()
    .map(({ reminder, accountName }) => ({ ...reminder, accountName, schedule: describeRule(reminder) }));
}

export function getReminder(id: number): Reminder | undefined {
  return db().select().from(reminders).where(eq(reminders.id, id)).get();
}

export function createReminder(raw: ReminderInput): Reminder {
  const input = reminderInputSchema.parse(raw);
  const values = {
    ...input,
    message: input.message ?? null,
    accountId: input.accountId ?? null,
    dayOfMonth: input.dayOfMonth ?? null,
    dayOfWeek: input.dayOfWeek ?? null,
    monthOfYear: input.monthOfYear ?? null,
    date: input.date ?? null,
  };
  return db()
    .insert(reminders)
    .values({ ...values, nextRunAt: input.enabled ? computeNext(values) : null })
    .returning()
    .get();
}

export function updateReminder(id: number, raw: ReminderInput): Reminder {
  const input = reminderInputSchema.parse(raw);
  const values = {
    ...input,
    message: input.message ?? null,
    accountId: input.accountId ?? null,
    dayOfMonth: input.dayOfMonth ?? null,
    dayOfWeek: input.dayOfWeek ?? null,
    monthOfYear: input.monthOfYear ?? null,
    date: input.date ?? null,
  };
  const updated = db()
    .update(reminders)
    .set({ ...values, nextRunAt: input.enabled ? computeNext(values) : null })
    .where(eq(reminders.id, id))
    .returning()
    .get();
  if (!updated) throw new Error(`Reminder ${id} not found`);
  return updated;
}

export function setReminderEnabled(id: number, enabled: boolean) {
  const r = getReminder(id);
  if (!r) throw new Error(`Reminder ${id} not found`);
  db()
    .update(reminders)
    .set({ enabled, nextRunAt: enabled ? computeNext(r) : null, nextNagAt: enabled ? r.nextNagAt : null })
    .where(eq(reminders.id, id))
    .run();
}

export function deleteReminder(id: number) {
  db().delete(reminders).where(eq(reminders.id, id)).run();
}

/** Reminders whose scheduled time has come. */
export function dueReminders(now = new Date()): Reminder[] {
  return db()
    .select()
    .from(reminders)
    .where(and(eq(reminders.enabled, true), isNotNull(reminders.nextRunAt), lte(reminders.nextRunAt, now)))
    .all();
}

/** Sent-but-unacknowledged reminders that should be re-sent. */
export function dueNags(now = new Date()): Reminder[] {
  return db()
    .select()
    .from(reminders)
    .where(and(eq(reminders.enabled, true), isNotNull(reminders.nextNagAt), lte(reminders.nextNagAt, now)))
    .all();
}

/** Record a delivery and schedule the next occurrence / nag. */
export function markSent(id: number, messageId: number | null, opts: { nag: boolean }, now = new Date()) {
  const r = getReminder(id);
  if (!r) return;
  const patch: Partial<typeof reminders.$inferInsert> = {
    lastSentAt: now,
    lastMessageId: messageId,
    nextNagAt: r.nagEveryHours > 0 ? new Date(now.getTime() + r.nagEveryHours * 3_600_000) : null,
  };
  if (!opts.nag) {
    patch.acknowledgedAt = null;
    patch.nextRunAt = computeNext(r, now);
    // A one-off reminder without nagging is done once delivered.
    if (r.frequency === "once" && r.nagEveryHours === 0) patch.enabled = false;
  }
  db().update(reminders).set(patch).where(eq(reminders.id, id)).run();
}

export function acknowledgeReminder(id: number, now = new Date()) {
  const r = getReminder(id);
  if (!r) return undefined;
  db()
    .update(reminders)
    .set({
      acknowledgedAt: now,
      nextNagAt: null,
      enabled: r.frequency === "once" ? false : r.enabled,
    })
    .where(eq(reminders.id, id))
    .run();
  return r;
}

export function snoozeReminder(id: number, hours: number, now = new Date()) {
  db()
    .update(reminders)
    .set({ nextNagAt: new Date(now.getTime() + hours * 3_600_000) })
    .where(eq(reminders.id, id))
    .run();
}

export function findReminderByMessageId(messageId: number): Reminder | undefined {
  return db().select().from(reminders).where(eq(reminders.lastMessageId, messageId)).get();
}

export function upcomingReminders(limit = 5) {
  return listReminders()
    .filter((r) => r.enabled && (r.nextRunAt || r.nextNagAt))
    .slice(0, limit);
}

/** Reminders that were sent and are still waiting for a ✅. */
export function pendingReminders() {
  return listReminders().filter((r) => r.enabled && r.nextNagAt !== null);
}
