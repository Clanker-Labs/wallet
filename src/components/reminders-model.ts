import type { ScheduleRule } from "@/lib/schedule";

/** Plain (server + client) reminder types and labels. */

export type ReminderKind = "custom" | "balance_update" | "statement" | "monthly_report";
export type ReminderFrequency = ScheduleRule["frequency"];

export const KIND_LABELS: Record<ReminderKind, string> = {
  balance_update: "Balance update",
  statement: "Bank statement",
  monthly_report: "Monthly report",
  custom: "Custom",
};

export interface ReminderValues {
  title: string;
  message: string;
  kind: ReminderKind;
  accountId: number | null;
  frequency: ReminderFrequency;
  dayOfMonth: number;
  dayOfWeek: number;
  monthOfYear: number;
  date: string;
  timeOfDay: string;
  nagEveryHours: number;
  enabled: boolean;
}
