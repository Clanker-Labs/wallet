import { DateTime } from "luxon";

/** Calendar dates are plain ISO strings (YYYY-MM-DD); months are YYYY-MM. */

export function todayISO(zone?: string): string {
  return DateTime.now().setZone(zone ?? defaultZone()).toISODate()!;
}

export function currentMonth(zone?: string): string {
  return todayISO(zone).slice(0, 7);
}

export function defaultZone(): string {
  return process.env.WALLET_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

export function isMonth(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

export function monthBounds(month: string): { start: string; end: string } {
  const start = DateTime.fromISO(`${month}-01`);
  return { start: start.toISODate()!, end: start.endOf("month").toISODate()! };
}

export function addMonths(month: string, n: number): string {
  return DateTime.fromISO(`${month}-01`).plus({ months: n }).toFormat("yyyy-MM");
}

export function addDays(date: string, n: number): string {
  return DateTime.fromISO(date).plus({ days: n }).toISODate()!;
}

/** Inclusive list of months from `from` to `to`. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let m = from;
  while (m <= to) {
    out.push(m);
    m = addMonths(m, 1);
  }
  return out;
}

export function endOfMonth(month: string): string {
  return monthBounds(month).end;
}

export function formatMonth(month: string, locale = "en-GB"): string {
  return DateTime.fromISO(`${month}-01`).setLocale(locale).toFormat("LLL yyyy");
}

export function formatDate(date: string, locale = "en-GB"): string {
  return DateTime.fromISO(date).setLocale(locale).toFormat("d LLL yyyy");
}

/** Whole months between two ISO dates (b - a), floor. */
export function monthsBetween(a: string, b: string): number {
  const da = DateTime.fromISO(a);
  const db = DateTime.fromISO(b);
  return (db.year - da.year) * 12 + (db.month - da.month) - (db.day < da.day ? 1 : 0);
}

/** Parse a date in common bank-export formats into ISO. */
export function parseDate(input: string, hint?: "dmy" | "mdy" | "ymd"): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = DateTime.fromISO(s.slice(0, 10));
    return d.isValid ? d.toISODate() : null;
  }
  const m = s.match(/^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})$/);
  if (!m) return null;
  let [, a, b, c] = m;
  let y: number, mo: number, d: number;
  if (a.length === 4) {
    y = +a;
    mo = +b;
    d = +c;
  } else {
    if (c.length === 2) c = `20${c}`;
    y = +c;
    const order = hint ?? (+a > 12 ? "dmy" : +b > 12 ? "mdy" : "dmy");
    if (order === "mdy") {
      mo = +a;
      d = +b;
    } else {
      d = +a;
      mo = +b;
    }
  }
  const dt = DateTime.fromObject({ year: y, month: mo, day: d });
  return dt.isValid ? dt.toISODate() : null;
}
