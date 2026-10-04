import { Suspense } from "react";
import { agentStatus } from "@/server/agent/runner";
import { listConversations } from "@/server/agent/conversations";
import { AssistantChat } from "@/components/assistant-chat";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Assistant" };

const PROVIDER_LABELS = {
  anthropic: "Claude API",
  "claude-code": "Claude Code (local)",
  codex: "Codex (local)",
  none: "Disabled",
};

export default async function AssistantPage() {
  const uid = (await requireUser()).id;
  const status = agentStatus();
  const conversations = listConversations(uid, 50).map((c) => ({
    id: c.id,
    title: c.title,
    provider: c.provider,
    updatedAt: c.updatedAt.getTime(),
  }));
  const label = status.model ? `${PROVIDER_LABELS[status.provider]} · ${status.model}` : PROVIDER_LABELS[status.provider];
  return (
    <Suspense>
      <AssistantChat ready={status.ready} reason={status.reason} providerLabel={label} initialConversations={conversations} />
    </Suspense>
  );
}
