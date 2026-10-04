"use client";

import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Check,
  CircleAlert,
  CloudUpload,
  FileSpreadsheet,
  ImageUp,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { AgentEvent } from "@/server/agent/events";
import {
  AttachmentChip,
  FileChip,
  MAX_ATTACHMENTS,
  pastedFiles,
  UPLOAD_ACCEPT,
  useAttachments,
  useWindowFileDrop,
  type UploadedFile,
  type UploadKind,
} from "./assistant-uploads";

interface ToolChip {
  id: string;
  name: string;
  state: "running" | "ok" | "error";
}

interface MessageFile {
  name: string;
  size?: number;
  kind?: UploadKind | null;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  tools: ToolChip[];
  files: MessageFile[];
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

/** Starters that open the file picker: the agent imports what's attached. */
const IMPORT_SUGGESTIONS = [
  {
    icon: FileSpreadsheet,
    title: "Drop a bank CSV or PDF statement and I'll import it",
    detail: "Transactions land in the right account, duplicates skipped, categories applied.",
    accept: ".csv,.tsv,.txt,.pdf,.ofx,.qif",
  },
  {
    icon: ImageUp,
    title: "Send a screenshot of your broker or bank app",
    detail: "I'll record the balances and add your positions as holdings.",
    accept: "image/*,.pdf",
  },
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
  list_holdings: "holdings",
  search_symbol: "symbol search",
  convert_currency: "currency",
  query_sql: "SQL query",
  simulate_mortgage: "mortgage sim",
  borrowing_capacity: "borrowing capacity",
  simulate_buy_vs_rent: "buy vs rent",
  project_net_worth: "projection",
  list_uploads: "uploads",
  read_upload: "read file",
  import_csv_upload: "import CSV",
  import_transactions: "import transactions",
  record_balance: "record balance",
  add_transaction: "add transaction",
  categorize_transactions: "categorize",
  create_category: "new category",
  set_budget: "set budget",
  create_account: "new account",
  update_account: "update account",
  upsert_holding: "update holding",
  delete_holding: "remove holding",
  refresh_prices: "refresh prices",
  create_reminder: "new reminder",
};

function Tools({ tools }: { tools: ToolChip[] }) {
  if (!tools.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {tools.map((t) => (
        <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-2">
          {t.state === "running" ? (
            <Loader2 size={11} className="animate-spin" aria-label="running" />
          ) : t.state === "ok" ? (
            <Check size={11} className="text-good-text" aria-label="done" />
          ) : (
            <X size={11} className="text-critical-text" aria-label="failed" />
          )}
          {TOOL_LABELS[t.name] ?? t.name.replaceAll("_", " ")}
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
  initialAttachments = [],
}: {
  ready: boolean;
  reason?: string;
  providerLabel: string;
  initialConversations: ConversationSummary[];
  /** Files handed over by the app-wide drop zone (/assistant?attach=…): sent right away. */
  initialAttachments?: UploadedFile[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [conversationId, setConversationId] = useState<string | null>(params.get("c"));
  const [conversations, setConversations] = useState(initialConversations);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const attachments = useAttachments(initialAttachments);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const autoSent = useRef(false);

  const dragging = useWindowFileDrop(attachments.add);
  const hasFiles = attachments.items.length > 0;
  const canSend = ready && !busy && !attachments.uploading && (input.trim() !== "" || attachments.done.length > 0);

  const pickFiles = (accept = UPLOAD_ACCEPT) => {
    const el = fileRef.current;
    if (!el) return;
    el.accept = accept;
    el.click();
  };

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
          data.messages.map(
            (m: { role: "user" | "assistant"; text: string; tools: string[]; files?: string[] }, i: number) => ({
              role: m.role,
              text: m.text,
              tools: m.tools.map((name, j) => ({ id: `${i}-${j}`, name, state: "ok" as const })),
              files: (m.files ?? []).map((name) => ({ name })),
            }),
          ),
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

  const send = async (text: string, opts: { fresh?: boolean } = {}) => {
    const message = text.trim();
    const files = attachments.done;
    if (!ready || busy || attachments.uploading || (!message && !files.length)) return;
    const threadId = opts.fresh ? null : conversationId;
    if (opts.fresh) setConversationId(null);
    setInput("");
    attachments.clear();
    setBusy(true);
    const userMessage: ChatMessage = {
      role: "user",
      text: message,
      tools: [],
      files: files.map((f) => ({ name: f.filename, size: f.size, kind: f.kind })),
    };
    setMessages((m) => [...(opts.fresh ? [] : m), userMessage, { role: "assistant", text: "", tools: [], files: [] }]);

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
        body: JSON.stringify({
          message,
          conversationId: threadId ?? undefined,
          attachments: files.map((f) => f.id),
          stream: true,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
      for await (const ev of readSse(res)) {
        switch (ev.type) {
          case "conversation":
            if (ev.id !== threadId) {
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

  // Files dropped elsewhere in the app arrive as ?attach=<ids>: import them right
  // away in a new conversation, and drop the param so a refresh doesn't resend.
  useEffect(() => {
    if (autoSent.current || !initialAttachments.length) return;
    autoSent.current = true;
    router.replace("/assistant", { scroll: false });
    if (ready) void send("", { fresh: true });
    else inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const placeholder = !ready
    ? "Configure the assistant first"
    : hasFiles
      ? "Import these, or add a note…"
      : "Ask, or attach a statement…";

  return (
    <div className="flex h-[calc(100dvh-7rem)] gap-5 md:h-[calc(100dvh-4rem)]">
      {/* Conversations */}
      <aside className="hidden w-56 shrink-0 flex-col lg:flex" aria-label="Conversations">
        <button
          onClick={() => openConversation(null)}
          className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2"
        >
          <MessageSquarePlus size={15} aria-hidden /> New chat
        </button>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {conversations.map((c) => (
            <li key={c.id} className="group flex items-center">
              <button
                onClick={() => openConversation(c.id)}
                aria-current={c.id === conversationId ? "page" : undefined}
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
                className="ml-1 rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-critical-text focus-visible:opacity-100"
                aria-label={`Delete conversation: ${c.title}`}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* Chat */}
      <section className="relative flex min-w-0 flex-1 flex-col rounded-2xl border border-border bg-surface" aria-label="Assistant chat">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold">Assistant</h1>
            <p className="truncate text-xs text-muted">{providerLabel} · reads and updates your wallet through its tools</p>
          </div>
          <button
            onClick={() => openConversation(null)}
            className="shrink-0 rounded-lg p-2 text-ink-2 hover:bg-surface-2 lg:hidden"
            aria-label="New chat"
          >
            <MessageSquarePlus size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5">
          {!ready && (
            <div className="mx-auto mb-6 max-w-xl rounded-xl border border-border bg-surface-2 p-4 text-sm break-words">
              <p className="font-medium">The assistant isn&apos;t configured yet</p>
              <p className="mt-1 text-ink-2">{reason}</p>
              <p className="mt-2 text-ink-2">
                Options: set <code>ANTHROPIC_API_KEY</code> in <code>.env</code>, or <code>WALLET_AGENT_PROVIDER=claude-code</code> /{" "}
                <code>codex</code> to use your local CLI login. You can also point Claude Code at the MCP server — see Settings →
                Integrations.
              </p>
              <p className="mt-2 text-ink-2">
                Uploads still work: files are kept, and MCP clients can import them (<code>list_uploads</code>).
              </p>
            </div>
          )}

          {messages.length === 0 ? (
            <div className="mx-auto max-w-xl sm:pt-4">
              <div className="grid gap-2 sm:grid-cols-2">
                {IMPORT_SUGGESTIONS.map(({ icon: Icon, title, detail, accept }) => (
                  <button
                    key={title}
                    type="button"
                    onClick={() => pickFiles(accept)}
                    className="group flex items-start gap-3 rounded-xl border border-dashed border-border-strong px-4 py-3 text-left transition-colors hover:border-accent hover:bg-brand-tint"
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-tint text-accent group-hover:bg-surface">
                      <Icon size={17} aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">{title}</span>
                      <span className="mt-0.5 block text-xs text-ink-2">{detail}</span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-6 mb-3 text-center text-sm text-ink-2">Or ask anything about your money:</p>
              <div className="grid gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={!ready || busy || attachments.uploading}
                    onClick={() => send(s)}
                    className="rounded-xl border border-border px-4 py-2.5 text-left text-sm text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent"
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
                  <div key={i} className="flex flex-col items-end gap-1.5">
                    {m.files.length > 0 && (
                      <ul className="flex max-w-[85%] flex-wrap justify-end gap-1.5" aria-label="Attached files">
                        {m.files.map((f, j) => (
                          <li key={j} className="max-w-full min-w-0">
                            <FileChip name={f.name} size={f.size} kind={f.kind} />
                          </li>
                        ))}
                      </ul>
                    )}
                    {m.text && (
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2 text-sm whitespace-pre-wrap text-accent-ink">
                        {m.text}
                      </div>
                    )}
                  </div>
                ) : (
                  <div key={i} className="text-sm">
                    <Tools tools={m.tools} />
                    {m.text ? (
                      <div className="prose-chat">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                      </div>
                    ) : busy && i === messages.length - 1 && !m.error ? (
                      <span className="inline-flex items-center gap-2 text-muted" role="status">
                        <Loader2 size={14} className="animate-spin" aria-hidden />
                        {m.tools.length ? "Working…" : messages[i - 1]?.files.length ? "Reading your files…" : "Thinking…"}
                      </span>
                    ) : null}
                    {m.error && (
                      <p className="mt-2 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-critical-text" role="alert">
                        <CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
                        <span className="min-w-0 break-words">{m.error}</span>
                      </p>
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
          <div className="mx-auto max-w-3xl">
            {hasFiles && (
              <ul className="-mx-3 mb-2 flex gap-2 overflow-x-auto px-3 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" aria-label="Files to send">
                {attachments.items.map((a) => (
                  <AttachmentChip key={a.key} item={a} onRemove={() => attachments.remove(a.key)} />
                ))}
              </ul>
            )}
            {hasFiles && !ready && (
              <p className="mb-2 flex items-start gap-1.5 text-xs text-ink-2">
                <CircleAlert size={13} className="mt-px shrink-0 text-muted" aria-hidden />
                Uploaded and kept, but the assistant can&apos;t import them until it&apos;s configured (see above).
              </p>
            )}
            <div className="flex items-end gap-1 rounded-xl border border-border bg-page px-1.5 py-1.5 transition-shadow focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--brand-tint)]">
              <button
                type="button"
                onClick={() => pickFiles()}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
                aria-label="Attach files"
                title={`Attach statements: CSV, OFX/QIF, PDF or images (up to ${MAX_ATTACHMENTS})`}
              >
                <Paperclip size={16} />
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                onPaste={(e) => {
                  const files = pastedFiles(e.clipboardData);
                  if (!files.length) return;
                  e.preventDefault();
                  attachments.add(files);
                }}
                rows={1}
                aria-label="Message the assistant"
                placeholder={placeholder}
                disabled={!ready}
                className="field-sizing-content max-h-40 min-h-[2rem] min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none! placeholder:text-muted disabled:cursor-not-allowed"
              />
              {busy ? (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink"
                  aria-label="Stop"
                >
                  <Square size={13} />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-ink disabled:opacity-40"
                  aria-label={attachments.uploading ? "Send (waiting for uploads)" : "Send"}
                  title={!ready ? "The assistant isn't configured" : attachments.uploading ? "Waiting for uploads…" : undefined}
                >
                  {attachments.uploading ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={15} />}
                </button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={UPLOAD_ACCEPT}
              className="hidden"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                attachments.add(Array.from(e.target.files ?? []));
                e.target.value = "";
                inputRef.current?.focus();
              }}
            />
          </div>
          <div className="sr-only" role="status" aria-live="polite">
            {attachments.announcement}
          </div>
        </form>

        {dragging && (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-surface/80 p-4 backdrop-blur-sm"
            aria-hidden
          >
            <div className="absolute inset-2 rounded-xl border-2 border-dashed border-accent/60 bg-brand-tint" />
            <div className="relative text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand-gradient text-white shadow-pop">
                <CloudUpload size={22} />
              </span>
              <p className="mt-3 text-base font-semibold text-ink">Drop statements to import</p>
              <p className="mt-1 text-sm text-ink-2">CSV, OFX/QIF, PDF or screenshots · 15 MB each</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
