import { asc, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/server/db/client";
import { agentConversations, agentMessages } from "@/server/db/schema";

export type StoredMessage = Anthropic.Beta.BetaMessageParam;

export function createConversation(opts: { channel: string; provider: string; title: string }) {
  return db()
    .insert(agentConversations)
    .values({ id: randomUUID(), channel: opts.channel, provider: opts.provider, title: opts.title.slice(0, 80) })
    .returning()
    .get();
}

export function getConversation(id: string) {
  return db().select().from(agentConversations).where(eq(agentConversations.id, id)).get();
}

export function listConversations(limit = 30) {
  return db().select().from(agentConversations).orderBy(desc(agentConversations.updatedAt)).limit(limit).all();
}

export function deleteConversation(id: string) {
  db().delete(agentConversations).where(eq(agentConversations.id, id)).run();
}

export function setExternalSession(id: string, sessionId: string) {
  db().update(agentConversations).set({ externalSessionId: sessionId }).where(eq(agentConversations.id, id)).run();
}

/** Full raw transcript, in order. */
export function loadMessages(conversationId: string): StoredMessage[] {
  return db()
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId))
    .orderBy(asc(agentMessages.id))
    .all()
    .map((m) => ({ role: m.role, content: m.content as StoredMessage["content"] }));
}

/** Append-only: history is never edited, so replayed thinking blocks stay valid. */
export function appendMessage(conversationId: string, message: StoredMessage) {
  db()
    .insert(agentMessages)
    .values({ conversationId, role: message.role, content: message.content })
    .run();
  db().update(agentConversations).set({ updatedAt: new Date() }).where(eq(agentConversations.id, conversationId)).run();
}

/** A display-friendly transcript: user/assistant text plus tool call names. */
export function transcript(conversationId: string) {
  const out: { role: "user" | "assistant"; text: string; tools: string[] }[] = [];
  for (const m of loadMessages(conversationId)) {
    if (m.role === "system") continue;
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    const text = blocks
      .filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const tools = blocks
      .filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use")
      .map((b) => b.name);
    const onlyToolResults = m.role === "user" && blocks.every((b) => b.type === "tool_result");
    if (onlyToolResults) continue;
    const last = out.at(-1);
    // Merge consecutive assistant steps of one turn into a single bubble.
    if (m.role === "assistant" && last?.role === "assistant") {
      if (text) last.text = last.text ? `${last.text}\n\n${text}` : text;
      last.tools.push(...tools);
    } else if (text || tools.length) {
      out.push({ role: m.role, text, tools });
    }
  }
  return out;
}
