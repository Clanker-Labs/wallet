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
