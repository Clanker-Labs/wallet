import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { callTool, enabledTools } from "../tools";
import { systemPrompt, type AgentChannel } from "../prompt";
import { appendMessage, loadMessages, type StoredMessage } from "../conversations";
import type { AgentEvent } from "../events";

type Block = Anthropic.Beta.BetaContentBlock;

const MAX_STEPS = 16;

export function anthropicModel() {
  return process.env.WALLET_AGENT_MODEL || "claude-opus-5-5";
}

function anthropicEffort(): "low" | "medium" | "high" | "xhigh" | "max" {
  const e = process.env.WALLET_AGENT_EFFORT;
  return e === "low" || e === "high" || e === "xhigh" || e === "max" ? e : "medium";
}

function toolDefinitions(): Anthropic.Beta.BetaTool[] {
  return enabledTools().map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
      // Stream tool input as it is generated; callTool validates it with zod.
      eager_input_streaming: true,
    };
  });
}

/**
 * A crash between "assistant asked for tools" and "results stored" would
 * leave a dangling tool_use. Answer it (append-only) before continuing.
 */
function repairDanglingToolUse(conversationId: string, history: StoredMessage[]) {
  const last = history.at(-1);
  if (!last || last.role !== "assistant" || typeof last.content === "string") return;
  const pending = last.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlockParam[];
  if (!pending.length) return;
  const repair: StoredMessage = {
    role: "user",
    content: pending.map((b) => ({
      type: "tool_result" as const,
      tool_use_id: b.id,
      is_error: true,
      content: "Interrupted before the tool ran.",
    })),
  };
  appendMessage(conversationId, repair);
  history.push(repair);
}

function finalText(content: Block[]): string {
  // After a server-side fallback, only the text produced after the switch counts.
  const lastFallback = content.findLastIndex((b) => b.type === "fallback");
  return content
    .slice(lastFallback + 1)
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** Run one user turn against the Claude API with the wallet tools. */
export async function runAnthropicTurn(opts: {
  userId: string;
  conversationId: string;
  /** Extra content blocks (attachments) placed before the text. */
  attachments?: Anthropic.Beta.BetaContentBlockParam[];
  message: string;
  channel: AgentChannel;
  onEvent: (e: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const client = new Anthropic();
  const history = loadMessages(opts.conversationId);
  repairDanglingToolUse(opts.conversationId, history);

  const userMessage: StoredMessage = {
    role: "user",
    content: [...(opts.attachments ?? []), { type: "text", text: opts.message }],
  };
  appendMessage(opts.conversationId, userMessage);
  history.push(userMessage);

  const tools = toolDefinitions();
  const system = systemPrompt(opts.userId, opts.channel);
  let lastText = "";
  let jsonRetries = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = client.beta.messages.stream(
      {
        model: anthropicModel(),
        max_tokens: 32000,
        system: [{ type: "text", text: system }],
        tools,
        messages: history,
        thinking: { type: "adaptive" },
        output_config: { effort: anthropicEffort() },
        // Auto-cache the growing transcript (tools + system + history).
        cache_control: { type: "ephemeral" },
        // On a safety-classifier refusal, let the API retry on its recommended fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal: opts.signal },
    );
    stream.on("text", (delta) => opts.onEvent({ type: "text", delta }));
    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start" && event.content_block.type === "fallback") {
        opts.onEvent({ type: "text_reset" });
      }
    });

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Only an unparseable streamed tool input is retried; API errors propagate.
      if (err instanceof Anthropic.APIError || opts.signal?.aborted || jsonRetries++ >= 2) throw err;
      opts.onEvent({ type: "text_reset" });
      continue;
    }

    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category;
      throw new Error(`The model declined this request${category ? ` (${category})` : ""}. Try rephrasing.`);
    }

    appendMessage(opts.conversationId, { role: "assistant", content: message.content as StoredMessage["content"] });
    history.push({ role: "assistant", content: message.content as StoredMessage["content"] });
    lastText = finalText(message.content) || lastText;

    if (message.stop_reason === "pause_turn") continue;

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!toolUses.length) break;
    if (message.stop_reason === "max_tokens") {
      // A tool input cut off mid-way must not run; answer it as an error instead.
      throw new Error("The response hit the output limit while calling a tool. Try a narrower question.");
    }

    const results = await Promise.all(
      toolUses.map(async (use) => {
        opts.onEvent({ type: "tool_start", id: use.id, name: use.name, input: use.input });
        const res = await callTool({ userId: opts.userId }, use.name, use.input);
        opts.onEvent({ type: "tool_end", id: use.id, name: use.name, ok: res.ok });
        return {
          type: "tool_result" as const,
          tool_use_id: use.id,
          content: res.content,
          ...(res.ok ? {} : { is_error: true }),
        };
      }),
    );
    const toolMessage: StoredMessage = { role: "user", content: results };
    appendMessage(opts.conversationId, toolMessage);
    history.push(toolMessage);
    opts.onEvent({ type: "step" });
  }

  return lastText;
}

export function anthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}
