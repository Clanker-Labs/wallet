import { DateTime } from "luxon";

/** Recurrence rules for reminders, evaluated in a given IANA time zone. */
export interface ScheduleRule {
  frequency: "once" | "weekly" | "monthly" | "quarterly" | "yearly";
  dayOfMonth?: number | null;
  /** 1 = Monday … 7 = Sunday */
  dayOfWeek?: number | null;
  monthOfYear?: number | null;
  date?: string | null;
  timeOfDay?: string | null;
}

function atTime(dt: DateTime, timeOfDay: string | null | undefined): DateTime {
  const [h, m] = (timeOfDay ?? "09:00").split(":").map(Number);
  return dt.set({ hour: h || 0, minute: m || 0, second: 0, millisecond: 0 });
}

/** Clamp a day-of-month to the month's length (31 → 28/29/30 when needed). */
function onDay(month: DateTime, day: number): DateTime {
  return month.set({ day: Math.min(Math.max(1, day), month.daysInMonth ?? 28) });
}

/**
 * Next occurrence strictly after `after`. Returns null for a one-off reminder
 * whose date has passed.
 */
export function nextOccurrence(rule: ScheduleRule, after: Date, zone: string): Date | null {
  const now = DateTime.fromJSDate(after).setZone(zone);
  const time = rule.timeOfDay;

  switch (rule.frequency) {
    case "once": {
      if (!rule.date) return null;
      const dt = atTime(DateTime.fromISO(rule.date, { zone }), time);
      return dt > now ? dt.toJSDate() : null;
    }
    case "weekly": {
      const dow = rule.dayOfWeek ?? 1;
      let dt = atTime(now.set({ weekday: dow as 1 | 2 | 3 | 4 | 5 | 6 | 7 }), time);
      while (dt <= now) dt = dt.plus({ weeks: 1 });
      return dt.toJSDate();
    }
    case "monthly":
    case "quarterly":
    case "yearly": {
      const step = rule.frequency === "monthly" ? 1 : rule.frequency === "quarterly" ? 3 : 12;
      const day = rule.dayOfMonth ?? 1;
      const anchorMonth = rule.monthOfYear ?? 1;
      let month = now.startOf("month");
      // Align quarterly/yearly to the anchor month.
      if (step > 1) {
        const offset = (((month.month - anchorMonth) % step) + step) % step;
        month = month.minus({ months: offset });
      }
      for (let k = 0; k < 40; k++) {
        const dt = atTime(onDay(month, day), time);
        if (dt > now) return dt.toJSDate();
        month = month.plus({ months: step });
      }
      return null;
    }
  }
}

export function describeRule(rule: ScheduleRule): string {
  const time = rule.timeOfDay ?? "09:00";
  const ord = (n: number) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  const weekday = (d: number) =>
    ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][d - 1] ?? "Monday";
  const monthName = (m: number) => DateTime.fromObject({ month: m }).toFormat("LLLL");
  switch (rule.frequency) {
    case "once":
      return `Once on ${rule.date} at ${time}`;
    case "weekly":
      return `Every ${weekday(rule.dayOfWeek ?? 1)} at ${time}`;
    case "monthly":
      return `Monthly on the ${ord(rule.dayOfMonth ?? 1)} at ${time}`;
    case "quarterly":
      return `Quarterly on the ${ord(rule.dayOfMonth ?? 1)} (from ${monthName(rule.monthOfYear ?? 1)}) at ${time}`;
    case "yearly":
      return `Yearly on ${ord(rule.dayOfMonth ?? 1)} ${monthName(rule.monthOfYear ?? 1)} at ${time}`;
  }
}
