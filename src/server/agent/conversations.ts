import { and, asc, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/server/db/client";
import { agentConversations, agentMessages } from "@/server/db/schema";

export type StoredMessage = Anthropic.Beta.BetaMessageParam;

export function createConversation(opts: { userId: string; channel: string; provider: string; title: string }) {
  return db()
    .insert(agentConversations)
    .values({
      id: randomUUID(),
      userId: opts.userId,
      channel: opts.channel,
      provider: opts.provider,
      title: opts.title.slice(0, 80),
    })
    .returning()
    .get();
}

/** A conversation of this user (never another user's). */
export function getConversation(uid: string, id: string) {
  return db()
    .select()
    .from(agentConversations)
    .where(and(eq(agentConversations.id, id), eq(agentConversations.userId, uid)))
    .get();
}

export function listConversations(uid: string, limit = 30) {
  return db()
    .select()
    .from(agentConversations)
    .where(eq(agentConversations.userId, uid))
    .orderBy(desc(agentConversations.updatedAt))
    .limit(limit)
    .all();
}

export function deleteConversation(uid: string, id: string) {
  db()
    .delete(agentConversations)
    .where(and(eq(agentConversations.id, id), eq(agentConversations.userId, uid)))
    .run();
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

const ATTACHED = /^Attached file "([^"]+)"/;
const CLI_NOTE = /\n\nAttached files \(read them[\s\S]*$/;

/** A display-friendly transcript: user/assistant text, attached file names and tool call names. */
export function transcript(conversationId: string) {
  const out: { role: "user" | "assistant"; text: string; tools: string[]; files: string[] }[] = [];
  for (const m of loadMessages(conversationId)) {
    if (m.role === "system") continue;
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    const files: string[] = [];
    const texts: string[] = [];
    for (const b of blocks) {
      if (b.type !== "text") continue;
      const attached = m.role === "user" ? b.text.match(ATTACHED) : null;
      if (attached) files.push(attached[1]);
      else if (m.role === "user" && CLI_NOTE.test(b.text)) {
        for (const f of b.text.matchAll(/^- "([^"]+)" — upload id/gm)) files.push(f[1]);
        texts.push(b.text.replace(CLI_NOTE, ""));
      } else texts.push(b.text);
    }
    const text = texts.join("\n").trim();
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
    } else if (text || tools.length || files.length) {
      out.push({ role: m.role, text, tools, files });
    }
  }
  return out;
}
