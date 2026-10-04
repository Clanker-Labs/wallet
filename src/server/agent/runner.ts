import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { anthropicConfigured, anthropicModel, runAnthropicTurn } from "./providers/anthropic";
import { cliAvailable, runCliTurn, type CliKind } from "./providers/cli";
import { appendMessage, createConversation, getConversation, setExternalSession } from "./conversations";
import { attachmentBlocks, attachmentNote, DEFAULT_IMPORT_PROMPT } from "./attachments";
import type { AgentChannel } from "./prompt";
import type { AgentEvent } from "./events";

export type AgentProvider = "anthropic" | "claude-code" | "codex" | "none";

export function configuredProvider(): AgentProvider {
  const p = (process.env.WALLET_AGENT_PROVIDER || "anthropic").toLowerCase();
  if (p === "claude-code" || p === "claude") return "claude-code";
  if (p === "codex") return "codex";
  if (p === "none" || p === "off") return "none";
  return "anthropic";
}

export function agentStatus(): { provider: AgentProvider; ready: boolean; reason?: string; model?: string } {
  const provider = configuredProvider();
  switch (provider) {
    case "none":
      return { provider, ready: false, reason: "The assistant is disabled (WALLET_AGENT_PROVIDER=none)." };
    case "anthropic": {
      const profileDir = path.join(os.homedir(), ".config", "anthropic");
      const ready = anthropicConfigured() || fs.existsSync(profileDir);
      return ready
        ? { provider, ready, model: anthropicModel() }
        : {
            provider,
            ready,
            reason:
              "No Anthropic credentials: set ANTHROPIC_API_KEY (or run `ant auth login`), or set WALLET_AGENT_PROVIDER=claude-code / codex to use a local CLI.",
          };
    }
    case "claude-code":
    case "codex":
      return cliAvailable(provider)
        ? { provider, ready: true }
        : { provider, ready: false, reason: `The \`${provider === "codex" ? "codex" : "claude"}\` CLI is not on PATH.` };
  }
}

// Serialize turns per conversation: the transcript is append-only.
const locks = new Map<string, Promise<unknown>>();

export async function runAgent(opts: {
  userId: string;
  conversationId?: string;
  message: string;
  /** Upload ids dropped into the chat with this message. */
  attachments?: string[];
  channel: AgentChannel;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<{ conversationId: string; text: string }> {
  const status = agentStatus();
  if (!status.ready) throw new Error(status.reason ?? "Assistant not configured");
  const provider = status.provider as Exclude<AgentProvider, "none">;
  const onEvent = opts.onEvent ?? (() => {});
  const uploadIds = opts.attachments ?? [];
  const message = opts.message.trim() || (uploadIds.length ? DEFAULT_IMPORT_PROMPT : "");
  if (!message) throw new Error("Empty message");

  let conv = opts.conversationId ? getConversation(opts.userId, opts.conversationId) : undefined;
  // A thread belongs to one backend; switching backends starts a new thread.
  if (!conv || conv.provider !== provider) {
    conv = createConversation({ userId: opts.userId, channel: opts.channel, provider, title: message });
  }
  const conversationId = conv.id;
  onEvent({ type: "conversation", id: conversationId, provider });

  const previous = locks.get(conversationId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    if (provider === "anthropic") {
      return runAnthropicTurn({
        userId: opts.userId,
        conversationId,
        message,
        attachments: await attachmentBlocks(opts.userId, uploadIds),
        channel: opts.channel,
        onEvent,
        signal: opts.signal,
      });
    }
    const fresh = getConversation(opts.userId, conversationId)!;
    const fullMessage = message + attachmentNote(opts.userId, uploadIds);
    appendMessage(conversationId, { role: "user", content: [{ type: "text", text: fullMessage }] });
    const res = await runCliTurn({
      kind: provider as CliKind,
      userId: opts.userId,
      message: fullMessage,
      channel: opts.channel,
      sessionId: fresh.externalSessionId,
      onEvent,
      signal: opts.signal,
    });
    if (res.sessionId && res.sessionId !== fresh.externalSessionId) setExternalSession(conversationId, res.sessionId);
    appendMessage(conversationId, { role: "assistant", content: [{ type: "text", text: res.text || "(no answer)" }] });
    return res.text;
  });
  locks.set(conversationId, run);
  try {
    const text = await run;
    onEvent({ type: "done", text });
    return { conversationId, text };
  } finally {
    if (locks.get(conversationId) === run) locks.delete(conversationId);
  }
}
