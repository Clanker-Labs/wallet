import type Anthropic from "@anthropic-ai/sdk";
import { getUpload, uploadKind, uploadText } from "@/server/services/uploads";

/**
 * Turns uploads into message content: PDFs and images go to Claude natively
 * (document / image blocks); CSV and text files are announced with a short
 * preview, and the agent imports the full file with import_csv_upload.
 */

const PREVIEW_LINES = 30;

type Block = Anthropic.Beta.BetaContentBlockParam;

export async function attachmentBlocks(userId: string, uploadIds: string[]): Promise<Block[]> {
  const blocks: Block[] = [];
  for (const id of uploadIds) {
    const upload = getUpload(userId, id);
    const kind = uploadKind(upload.mimeType, upload.filename);
    const label = `Attached file "${upload.filename}" (upload id ${upload.id}, ${kind}, ${Math.round(upload.size / 1024)} KB).`;
    if (kind === "pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: upload.data.toString("base64") },
        title: upload.filename,
      });
      blocks.push({ type: "text", text: label });
    } else if (kind === "image") {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: (upload.mimeType === "image/jpg" ? "image/jpeg" : upload.mimeType) as "image/png",
          data: upload.data.toString("base64"),
        },
      });
      blocks.push({ type: "text", text: label });
    } else {
      const { text } = await uploadText(upload);
      const lines = text.split(/\r?\n/);
      blocks.push({
        type: "text",
        text: `${label} ${lines.length} lines. First ${Math.min(PREVIEW_LINES, lines.length)}:\n\`\`\`\n${lines
          .slice(0, PREVIEW_LINES)
          .join("\n")}\n\`\`\`\nUse import_csv_upload / read_upload with this upload id for the full content.`,
      });
    }
  }
  return blocks;
}

/** Plain-text note for agents that can't take attachments directly (local CLIs). */
export function attachmentNote(userId: string, uploadIds: string[]): string {
  if (!uploadIds.length) return "";
  const lines = uploadIds.map((id) => {
    const u = getUpload(userId, id);
    return `- "${u.filename}" — upload id ${u.id} (${uploadKind(u.mimeType, u.filename)}, ${Math.round(u.size / 1024)} KB)`;
  });
  return `\n\nAttached files (read them with the read_upload tool; import CSVs with import_csv_upload):\n${lines.join("\n")}`;
}

export const DEFAULT_IMPORT_PROMPT = "Here's a file — please import it into my wallet and tell me what you added.";
