"use server";

import { gunzipSync } from "node:zlib";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { applyMapping, parseCsv, type CsvMapping } from "@/lib/csv-import";
import { countUncategorized, importTransactions } from "@/server/services/transactions";
import { getAccountRow } from "@/server/services/accounts";
import { requireUid } from "@/server/session";

const MAX_BYTES = 5 * 1024 * 1024;

const mappingSchema = z
  .object({
    date: z.string().min(1),
    description: z.string().min(1),
    amount: z.string().min(1).optional(),
    debit: z.string().min(1).optional(),
    credit: z.string().min(1).optional(),
    dateFormat: z.enum(["auto", "dmy", "mdy", "ymd"]).optional(),
    invertSign: z.boolean().optional(),
  })
  .refine((m) => m.amount || m.debit || m.credit, "Pick the amount column (or the debit / credit columns).");

export type ImportResult =
  | {
      ok: true;
      inserted: number;
      duplicates: number;
      categorized: number;
      /** Rows that couldn't be read (bad date / no amount). */
      skipped: number;
      uncategorized: number;
    }
  | { ok: false; error: string };

/**
 * Receives the raw CSV (gzipped by the browser when it can, to stay under the
 * server-action body limit) plus the column mapping, and re-parses everything
 * here: the browser preview is never trusted.
 */
export async function importCsvAction(fd: FormData): Promise<ImportResult> {
  const uid = await requireUid();
  const file = fd.get("csv");
  if (!(file instanceof Blob)) return { ok: false, error: "No file received." };

  let text: string;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    text =
      fd.get("encoding") === "gzip"
        ? gunzipSync(buf, { maxOutputLength: MAX_BYTES }).toString("utf8")
        : buf.subarray(0, MAX_BYTES + 1).toString("utf8");
  } catch {
    return { ok: false, error: "The file is larger than 5 MB or damaged." };
  }
  if (Buffer.byteLength(text) > MAX_BYTES) return { ok: false, error: "The file is larger than 5 MB." };

  let mapping: CsvMapping;
  try {
    mapping = mappingSchema.parse(JSON.parse(String(fd.get("mapping") ?? "")));
  } catch (e) {
    return { ok: false, error: e instanceof z.ZodError ? (e.issues[0]?.message ?? "Invalid mapping") : "Invalid mapping" };
  }

  let accountId: number | null = null;
  const rawAccount = String(fd.get("accountId") ?? "");
  if (rawAccount) {
    const n = Number(rawAccount);
    try {
      if (!Number.isInteger(n)) throw new Error();
      getAccountRow(uid, n);
    } catch {
      return { ok: false, error: "That account doesn't exist anymore." };
    }
    accountId = n;
  }

  const parsed = parseCsv(text);
  for (const col of [mapping.date, mapping.description, mapping.amount, mapping.debit, mapping.credit]) {
    if (col && !parsed.headers.includes(col)) return { ok: false, error: `Column “${col}” isn't in this file.` };
  }
  const { ok, errors } = applyMapping(parsed.rows, mapping);
  if (ok.length === 0) return { ok: false, error: "No readable rows with this column mapping." };

  const res = importTransactions(uid, ok, accountId);
  revalidatePath("/", "layout");
  return { ok: true, ...res, skipped: errors.length, uncategorized: countUncategorized(uid) };
}
