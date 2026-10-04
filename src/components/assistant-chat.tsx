"use client";

import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Check, Loader2, MessageSquarePlus, Square, Trash2, Wrench, X } from "lucide-react";
import type { AgentEvent } from "@/server/agent/events";

interface ToolChip {
  id: string;
  name: string;
  state: "running" | "ok" | "error";
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  tools: ToolChip[];
  error?: string;
}

interface ConversationSummary {
  id: string;
  title: string;
  provider: string;
  updatedAt: string | number;
}

const SUGGESTIONS = [
  "How is my net worth trending, and what drove the last 3 months?",
  "Where did my money go this month vs my 6-month average?",
  "Categorize my uncategorized transactions and create rules for recurring merchants.",
  "Can I afford a €450k apartment with €80k down? Compare with renting at €1,400/month.",
  "If I keep saving like this, when do I reach financial independence?",
];

const TOOL_LABELS: Record<string, string> = {
  get_overview: "overview",
  get_net_worth: "net worth",
  get_net_worth_history: "net worth history",
  list_accounts: "accounts",
  get_account: "account",
  list_transactions: "transactions",
  get_spending_by_category: "spending",
  get_budget_status: "budgets",
  get_cashflow: "cash flow",
  list_categories: "categories",
  list_reminders: "reminders",
  query_sql: "SQL query",
  simulate_mortgage: "mortgage sim",
  borrowing_capacity: "borrowing capacity",
  simulate_buy_vs_rent: "buy vs rent",
  project_net_worth: "projection",
  record_balance: "record balance",
  add_transaction: "add transaction",
  categorize_transactions: "categorize",
  create_category: "new category",
  set_budget: "set budget",
  create_account: "new account",
  create_reminder: "new reminder",
};

function Tools({ tools }: { tools: ToolChip[] }) {
  if (!tools.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {tools.map((t) => (
        <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-2">
          {t.state === "running" ? (
            <Loader2 size={11} className="animate-spin" />
          ) : t.state === "ok" ? (
            <Check size={11} className="text-good-text" />
          ) : (
            <X size={11} className="text-critical-text" />
          )}
          {TOOL_LABELS[t.name] ?? t.name}
        </span>
      ))}
    </div>
  );
}

async function* readSse(response: Response): AsyncGenerator<AgentEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) yield JSON.parse(line.slice(6)) as AgentEvent;
      }
    }
  }
}

export function AssistantChat({
  ready,
  reason,
  providerLabel,
  initialConversations,
}: {
  ready: boolean;
  reason?: string;
  providerLabel: string;
  initialConversations: ConversationSummary[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [conversationId, setConversationId] = useState<string | null>(params.get("c"));
  const [conversations, setConversations] = useState(initialConversations);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refreshList = useCallback(async () => {
    const res = await fetch("/api/agent/conversations");
    if (res.ok) setConversations(await res.json());
  }, []);

  // Load a conversation's transcript when opening it.
  useEffect(() => {
    if (!conversationId || busy) return;
    let cancelled = false;
    fetch(`/api/agent/conversations/${conversationId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setMessages(
          data.messages.map((m: { role: "user" | "assistant"; text: string; tools: string[] }, i: number) => ({
            role: m.role,
            text: m.text,
            tools: m.tools.map((name, j) => ({ id: `${i}-${j}`, name, state: "ok" as const })),
          })),
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const openConversation = (id: string | null) => {
    if (busy) return;
    setConversationId(id);
    if (!id) setMessages([]);
    router.replace(id ? `/assistant?c=${id}` : "/assistant", { scroll: false });
    inputRef.current?.focus();
  };

  const removeConversation = async (id: string) => {
    await fetch(`/api/agent/conversations/${id}`, { method: "DELETE" });
    if (id === conversationId) openConversation(null);
    refreshList();
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text: message, tools: [] }, { role: "assistant", text: "", tools: [] }]);

    // Text of finished steps vs the step currently streaming (which a reset may discard).
    let committed = "";
    let current = "";
    const patch = (fn: (msg: ChatMessage) => ChatMessage) =>
      setMessages((m) => [...m.slice(0, -1), fn(m[m.length - 1])]);
    const joined = () => [committed, current].filter(Boolean).join("\n\n");

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message, conversationId, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
      for await (const ev of readSse(res)) {
        switch (ev.type) {
          case "conversation":
            if (ev.id !== conversationId) {
              setConversationId(ev.id);
              router.replace(`/assistant?c=${ev.id}`, { scroll: false });
            }
            break;
          case "text":
            current += ev.delta;
            patch((msg) => ({ ...msg, text: joined() }));
            break;
          case "text_reset":
            current = "";
            patch((msg) => ({ ...msg, text: joined() }));
            break;
          case "step":
            if (current) committed = joined();
            current = "";
            break;
          case "tool_start":
            patch((msg) => ({ ...msg, tools: [...msg.tools, { id: ev.id, name: ev.name, state: "running" }] }));
            break;
          case "tool_end":
            patch((msg) => ({
              ...msg,
              tools: msg.tools.map((t) => (t.id === ev.id ? { ...t, state: ev.ok ? "ok" : "error" } : t)),
            }));
            break;
          case "error":
            patch((msg) => ({ ...msg, error: ev.message }));
            break;
          case "done":
            if (ev.text && !joined()) patch((msg) => ({ ...msg, text: ev.text }));
            break;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) patch((msg) => ({ ...msg, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
      abortRef.current = null;
      patch((msg) => ({ ...msg, tools: msg.tools.map((t) => (t.state === "running" ? { ...t, state: "error" } : t)) }));
      refreshList();
      router.refresh(); // the agent may have changed data shown elsewhere
    }
  };

  return (
    <div className="flex h-[calc(100dvh-7rem)] gap-5 md:h-[calc(100dvh-4rem)]">
      {/* Conversations */}
      <aside className="hidden w-56 shrink-0 flex-col lg:flex">
        <button
          onClick={() => openConversation(null)}
          className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2"
        >
          <MessageSquarePlus size={15} /> New chat
        </button>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {conversations.map((c) => (
            <li key={c.id} className="group flex items-center">
              <button
                onClick={() => openConversation(c.id)}
                className={clsx(
                  "flex-1 truncate rounded-lg px-3 py-1.5 text-left text-sm",
                  c.id === conversationId ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2",
                )}
                title={c.title}
              >
                {c.title}
              </button>
              <button
                onClick={() => removeConversation(c.id)}
                className="ml-1 rounded p-1 text-muted opacity-0 hover:text-critical-text group-hover:opacity-100"
                aria-label="Delete conversation"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* Chat */}
      <section className="flex min-w-0 flex-1 flex-col rounded-2xl border border-border bg-surface">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <h1 className="text-sm font-semibold">Assistant</h1>
            <p className="text-xs text-muted">{providerLabel} · reads your wallet data through its tools</p>
          </div>
          <button onClick={() => openConversation(null)} className="rounded-lg p-2 text-ink-2 hover:bg-surface-2 lg:hidden" aria-label="New chat">
            <MessageSquarePlus size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {!ready && (
            <div className="mx-auto mb-6 max-w-xl rounded-xl border border-border bg-surface-2 p-4 text-sm">
              <p className="font-medium">The assistant isn&apos;t configured yet</p>
              <p className="mt-1 text-ink-2">{reason}</p>
              <p className="mt-2 text-ink-2">
                Options: set <code>ANTHROPIC_API_KEY</code> in <code>.env</code>, or <code>WALLET_AGENT_PROVIDER=claude-code</code> /{" "}
                <code>codex</code> to use your local CLI login. You can also point Claude Code at the MCP server — see Settings →
                Integrations.
              </p>
            </div>
          )}

          {messages.length === 0 ? (
            <div className="mx-auto max-w-xl pt-6">
              <p className="mb-4 text-center text-sm text-ink-2">Ask anything about your money. Try:</p>
              <div className="grid gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    disabled={!ready}
                    onClick={() => send(s)}
                    className="rounded-xl border border-border px-4 py-2.5 text-left text-sm text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-5">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2 text-sm text-accent-ink">
                      {m.text}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="text-sm">
                    <Tools tools={m.tools} />
                    {m.text ? (
                      <div className="prose-chat">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                      </div>
                    ) : busy && i === messages.length - 1 && !m.error ? (
                      <span className="inline-flex items-center gap-2 text-muted">
                        <Loader2 size={14} className="animate-spin" />
                        {m.tools.length ? "Working…" : "Thinking…"}
                      </span>
                    ) : null}
                    {m.error && (
                      <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-critical-text">⚠️ {m.error}</p>
                    )}
                  </div>
                ),
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <form
          className="border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-border bg-page px-3 py-2 focus-within:border-accent">
            <Wrench size={15} className="mb-2 shrink-0 text-muted" aria-hidden />
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={1}
              placeholder={ready ? "Ask about your net worth, budgets, a purchase…" : "Configure the assistant first"}
              disabled={!ready}
              className="max-h-40 min-h-[2rem] flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted"
            />
            {busy ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="grid h-8 w-8 place-items-center rounded-lg bg-surface-2 text-ink"
                aria-label="Stop"
              >
                <Square size={13} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!ready || !input.trim()}
                className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-accent-ink disabled:opacity-40"
                aria-label="Send"
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
