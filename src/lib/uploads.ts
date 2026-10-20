/** Which files the assistant accepts (shared by the upload API and the browser). */

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

/**
 * Where a file dropped on the CSV importer goes: the importer itself, the
 * assistant (statements, OFX/QIF, screenshots), or nowhere yet: spreadsheets
 * need saving as CSV first.
 */
export type ImportRoute = "importer" | "assistant" | "spreadsheet" | "unsupported";

const SPREADSHEET_EXTS = ["xlsx", "xlsm", "xls", "ods", "numbers"];
const ASSISTANT_TEXT_EXTS = ["ofx", "qif", "qfx", "json", "md"];

export function importRoute(mimeType: string, filename: string): ImportRoute {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (SPREADSHEET_EXTS.includes(ext)) return "spreadsheet";
  const kind = uploadKind(mimeType, filename);
  if (kind === "csv" || (kind === "text" && !ASSISTANT_TEXT_EXTS.includes(ext))) return "importer";
  return kind ? "assistant" : "unsupported";
}
