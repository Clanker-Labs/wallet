import { Suspense } from "react";
import { agentStatus } from "@/server/agent/runner";
import { listConversations } from "@/server/agent/conversations";
import { AssistantChat } from "@/components/assistant-chat";
import type { UploadedFile } from "@/components/assistant-uploads";
import { getUpload, listUploads, uploadKind } from "@/server/services/uploads";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Assistant" };

const PROVIDER_LABELS = {
  anthropic: "Claude API",
  "claude-code": "Claude Code (local)",
  codex: "Codex (local)",
  none: "Disabled",
};

/** Uploads named in ?attach=<id>,<id> (handed over by the app-wide drop zone); unknown ids are skipped. */
function attachedUploads(uid: string, param: string | string[] | undefined): UploadedFile[] {
  const ids = [...new Set((Array.isArray(param) ? param.join(",") : (param ?? "")).split(","))]
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (!ids.length) return [];
  // Metadata only (no file contents); a fresh drop is always among the latest uploads.
  const recent = new Map(listUploads(uid, 50).map((u) => [u.id, u]));
  return ids.flatMap((id) => {
    try {
      const u = recent.get(id) ?? getUpload(uid, id);
      return [{ id: u.id, filename: u.filename, size: u.size, kind: uploadKind(u.mimeType, u.filename) }];
    } catch {
      return [];
    }
  });
}

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const uid = (await requireUser()).id;
  const status = agentStatus();
  const conversations = listConversations(uid, 50).map((c) => ({
    id: c.id,
    title: c.title,
    provider: c.provider,
    updatedAt: c.updatedAt.getTime(),
  }));
  const attachments = attachedUploads(uid, (await searchParams).attach);
  const label = status.model ? `${PROVIDER_LABELS[status.provider]} · ${status.model}` : PROVIDER_LABELS[status.provider];
  return (
    <Suspense>
      <AssistantChat
        ready={status.ready}
        reason={status.reason}
        providerLabel={label}
        initialConversations={conversations}
        initialAttachments={attachments}
      />
    </Suspense>
  );
}
