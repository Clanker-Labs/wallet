import Papa from "papaparse";
import { parseAmount } from "./money";
import { parseDate } from "./dates";

/** Bank CSV → normalized rows. Pure: runs in the browser for previews and on the server for the real import. */

export interface CsvMapping {
  date: string;
  description: string;
  /** Single signed amount column… */
  amount?: string;
  /** …or separate debit / credit columns. */
  debit?: string;
  credit?: string;
  dateFormat?: "auto" | "dmy" | "mdy" | "ymd";
  /** Flip signs when the bank exports expenses as positive numbers. */
  invertSign?: boolean;
}

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  delimiter: string;
}

export interface ImportRow {
  date: string;
  amount: number;
  description: string;
}

const HEADER_HINTS = /date|libell|label|description|montant|amount|debit|débit|credit|crédit|wording|payee|merchant/i;

export function parseCsv(text: string): ParsedCsv {
  // Some banks prepend account info lines: start at the first header-looking line.
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const start = Math.max(
    0,
    lines.findIndex((l) => HEADER_HINTS.test(l) && /[;,\t]/.test(l)),
  );
  const body = lines.slice(start).join("\n");
  const res = Papa.parse<Record<string, string>>(body, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const headers = (res.meta.fields ?? []).filter((h) => h !== "");
  return { headers, rows: res.data, delimiter: res.meta.delimiter };
}

const pick = (headers: string[], ...patterns: RegExp[]) => {
  for (const p of patterns) {
    const h = headers.find((x) => p.test(x));
    if (h) return h;
  }
  return undefined;
};

export function guessMapping(headers: string[]): CsvMapping {
  const date =
    pick(headers, /^date$/i, /date.*op/i, /booking.*date/i, /^date/i, /date/i) ?? headers[0] ?? "";
  const description =
    pick(headers, /libell/i, /^label/i, /description/i, /wording/i, /payee|merchant|counterparty/i, /d[ée]tail/i) ??
    headers[1] ??
    "";
  const amount = pick(headers, /^montant$/i, /^amount$/i, /montant/i, /amount/i, /^value$/i);
  const debit = pick(headers, /d[ée]bit/i, /withdrawal|paid out|money out/i);
  const credit = pick(headers, /cr[ée]dit/i, /deposit|paid in|money in/i);
  if (amount) return { date, description, amount, dateFormat: "auto" };
  return { date, description, debit, credit, dateFormat: "auto" };
}

export function applyMapping(
  rows: Record<string, string>[],
  mapping: CsvMapping,
): { ok: ImportRow[]; errors: { row: number; reason: string }[] } {
  const ok: ImportRow[] = [];
  const errors: { row: number; reason: string }[] = [];
  const hint = mapping.dateFormat && mapping.dateFormat !== "auto" ? mapping.dateFormat : undefined;
  rows.forEach((r, idx) => {
    const date = parseDate(r[mapping.date] ?? "", hint);
    if (!date) {
      errors.push({ row: idx + 1, reason: `Unreadable date "${r[mapping.date] ?? ""}"` });
      return;
    }
    let amount: number | null;
    if (mapping.amount) {
      amount = parseAmount(r[mapping.amount]);
    } else {
      const debit = mapping.debit ? parseAmount(r[mapping.debit]) : null;
      const credit = mapping.credit ? parseAmount(r[mapping.credit]) : null;
      amount = debit === null && credit === null ? null : (credit ?? 0) - Math.abs(debit ?? 0);
    }
    if (amount === null) {
      errors.push({ row: idx + 1, reason: "No amount" });
      return;
    }
    if (mapping.invertSign) amount = -amount;
    const description = (r[mapping.description] ?? "").replace(/\s+/g, " ").trim() || "(no description)";
    ok.push({ date, amount, description });
  });
  return { ok, errors };
}
