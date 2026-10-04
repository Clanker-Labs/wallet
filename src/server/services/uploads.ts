import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db/client";
import { uploads, type Upload } from "@/server/db/schema";

/**
 * Files dropped into the assistant: bank exports (CSV, OFX/QIF, TXT), PDF
 * statements and screenshots. Stored in SQLite so a backup is one file.
 */

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export type UploadKind = "csv" | "text" | "pdf" | "image";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function uploadKind(mimeType: string, filename: string): UploadKind | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (mimeType === "application/pdf" || ext === "pdf") return "pdf";
  if (IMAGE_TYPES.has(mimeType) || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  if (["csv", "tsv"].includes(ext) || mimeType === "text/csv") return "csv";
  if (mimeType.startsWith("text/") || ["txt", "ofx", "qif", "qfx", "json", "md"].includes(ext)) return "text";
  return null;
}

export function saveUpload(uid: string, file: { filename: string; mimeType: string; data: Buffer }): Upload {
  if (file.data.length > MAX_UPLOAD_BYTES) throw new Error(`File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
  if (!uploadKind(file.mimeType, file.filename)) {
    throw new Error("Unsupported file: drop a CSV, TXT/OFX/QIF, PDF or an image (PNG/JPG)");
  }
  return db()
    .insert(uploads)
    .values({
      id: randomUUID(),
      userId: uid,
      filename: file.filename.slice(0, 200),
      mimeType: file.mimeType || "application/octet-stream",
      size: file.data.length,
      data: file.data,
    })
    .returning()
    .get();
}

export function getUpload(uid: string, id: string): Upload {
  const row = db()
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, id), eq(uploads.userId, uid)))
    .get();
  if (!row) throw new Error(`Upload ${id} not found`);
  return row;
}

export function listUploads(uid: string, limit = 20) {
  return db()
    .select({
      id: uploads.id,
      filename: uploads.filename,
      mimeType: uploads.mimeType,
      size: uploads.size,
      createdAt: uploads.createdAt,
    })
    .from(uploads)
    .where(eq(uploads.userId, uid))
    .orderBy(desc(uploads.createdAt))
    .limit(limit)
    .all();
}

export function deleteUpload(uid: string, id: string) {
  db()
    .delete(uploads)
    .where(and(eq(uploads.id, id), eq(uploads.userId, uid)))
    .run();
}

/** Bank exports are often Windows-1252 (accents, €); fall back when UTF-8 shows replacement chars. */
export function decodeText(data: Buffer): string {
  const utf8 = new TextDecoder("utf-8").decode(data).replace(/^﻿/, "");
  if (!utf8.includes("�")) return utf8;
  return new TextDecoder("windows-1252").decode(data);
}

/** Plain text of an upload (CSV/TXT as-is, PDF via text extraction). */
export async function uploadText(upload: Upload): Promise<{ text: string; pages?: number }> {
  const kind = uploadKind(upload.mimeType, upload.filename);
  if (kind === "csv" || kind === "text") return { text: decodeText(upload.data) };
  if (kind === "pdf") {
    const { extractText } = await import("unpdf");
    const { text, totalPages } = await extractText(new Uint8Array(upload.data), { mergePages: true });
    return { text: text.replace(/[ \t]+\n/g, "\n").trim(), pages: totalPages };
  }
  throw new Error("This upload is an image: it can only be read by a vision model (Claude API provider).");
}
