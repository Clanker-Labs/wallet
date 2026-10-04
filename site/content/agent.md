---
title: Agent internals
description: The providers, the Claude API loop (adaptive thinking, prompt caching, server-side fallback, append-only transcripts, dangling tool_use repair), attachments, and the statement import workflow.
section: technical
order: 5
---

Code: [src/server/agent](gh:src/server/agent). Product view: [Assistant](assistant.html). Tool reference: [Agent tools](tools.html).

## Entry point: `runAgent()`

Every surface (the web chat through `POST /api/agent`, Telegram, the HTTP API) calls [runner.ts](gh:src/server/agent/runner.ts):

1. **Pick the provider** from `WALLET_AGENT_PROVIDER` and check it's ready. `anthropic` needs `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE` or an `~/.config/anthropic` profile from `ant auth login`; the CLI providers need their binary on the `PATH`. Not ready → an error with the reason, shown in the chat and in Settings.
2. **Find or create the conversation.** A conversation belongs to one user and one provider; a `conversationId` from another backend starts a new thread. An empty message with attachments becomes "Here's a file — please import it into my wallet and tell me what you added."
3. **Serialize turns per conversation** with an in-process lock, because the transcript is append-only and must stay ordered.
4. **Run the turn** with the provider, streaming [events](api.html#post-apiagent) (`text`, `tool_start`, `tool_end`, `step`, `text_reset`, `done`) to the caller.

The **system prompt** ([prompt.ts](gh:src/server/agent/prompt.ts)) is shared by every provider: who the user is, today's date and time zone, base currency and locale, the house rules (ground every figure in tool results, start broad questions with `get_overview`, how liabilities, ownership and transfers work), the import routine below, and a format section for the channel (Markdown for the web, short plain lines for Telegram). It only changes once a day per user, which keeps it cacheable.

## Providers

| | `anthropic` | `claude-code` | `codex` |
|---|---|---|---|
| Runs | Messages API, in-process | `claude -p … --output-format stream-json` | `codex exec --json` |
| Model | `WALLET_AGENT_MODEL` (default `claude-opus-5-5`) | `WALLET_CLAUDE_MODEL` or the CLI's default | `WALLET_CODEX_MODEL` or the CLI's default |
| Tools | Registry passed as tool definitions | Wallet MCP server (stdio), nothing else | Wallet MCP server (stdio), nothing else |
| Transcript | Full content blocks in `agent_messages` | The CLI's own session, resumed with `--resume`; text kept for display | Same, with `exec resume` |
| Attachments | Native PDF and image blocks | Text note + `read_upload` | Same |

## The Claude API loop

[providers/anthropic.ts](gh:src/server/agent/providers/anthropic.ts) runs one user turn as a loop of up to **16 model steps**:

```diagram
agent-loop
```

Each step streams `client.beta.messages.stream()` with:

| Parameter | Value | Why |
|---|---|---|
| `thinking` | `{ type: "adaptive" }` | The model decides when and how much to think. |
| `output_config.effort` | `WALLET_AGENT_EFFORT`: `low`, `medium` (default), `high`, `xhigh`, `max` | Trades depth for speed and cost. |
| `max_tokens` | 32 000 | |
| `cache_control` | `{ type: "ephemeral" }` at the top level | Automatic prompt caching of the growing prefix: tools, system prompt and history are read from cache on every later step and turn. |
| `betas`, `fallbacks` | `server-side-fallback-2026-07-01`, `"default"` | If the safety classifier refuses, the API retries on its recommended fallback model within the same request. |
| tools | every enabled tool, input schema from `z.toJSONSchema(input, { io: "input" })`, `eager_input_streaming: true` | Tool input streams as it's generated; `callTool` validates it with zod. |

What the loop does with the result:

- **Server-side fallback.** When a `fallback` content block starts, the runner emits `text_reset` so the UI drops text streamed before the switch, and the turn's answer is only the text after the last `fallback` block.
- **Refusal** (`stop_reason: "refusal"`): the turn fails with "The model declined this request (category). Try rephrasing."
- **`pause_turn`**: the step is stored and the loop continues.
- **Tool use**: every `tool_use` block runs **in parallel** through `callTool({ userId }, name, input)`; results go back as one user message of `tool_result` blocks, with `is_error: true` on failures, so the model can correct itself.
- **`max_tokens` while calling a tool**: a cut-off tool input must not run, so the turn fails with a hint to ask something narrower.
- **Unparseable streamed tool input**: the step is retried up to twice (with `text_reset`). API errors are not retried here.
- No more tool calls → the turn ends with the last text.

### Append-only transcripts

`agent_messages` stores each API message exactly as sent or received, content blocks included (`thinking` with its signature, `text`, `tool_use`, `tool_result`, `document`, `image`). Messages are only ever **appended**: never edited, reordered or deleted, except when the whole conversation is deleted. The next turn replays the history byte for byte, which the API requires for thinking blocks and which keeps the cached prefix valid.

### Dangling `tool_use` repair

If the process dies between "the model asked for tools" and "results stored", the transcript ends with an assistant message whose `tool_use` blocks have no answer, and the API would reject the next request. Before a new turn, `repairDanglingToolUse()` detects this and **appends** a user message answering each pending call with `is_error: true` and "Interrupted before the tool ran." History stays append-only, and the model learns the calls didn't happen.

## Attachments

Files are uploaded first (`POST /api/uploads`, or by the Telegram bot) into the `uploads` table, then attached to a turn by id ([attachments.ts](gh:src/server/agent/attachments.ts)).

| Kind | `anthropic` provider | CLI providers |
|---|---|---|
| PDF | `document` block (base64) + a label with filename and upload id | A note listing the file and its id; the model calls `read_upload`, which extracts the PDF's text (`unpdf`) and pages it with `offset` / `maxChars` |
| Image (PNG, JPEG, WebP, GIF) | `image` block (base64) + label | Not readable: `read_upload` explains that images need a vision model |
| CSV / text | A text block: label, line count and the first 30 lines, plus "use `import_csv_upload` / `read_upload` with this upload id" | Note + `read_upload` |

Attachment blocks come before the user's text. Text files are decoded as UTF-8, falling back to Windows-1252 when that produces replacement characters (common for bank exports).

## The import workflow

The system prompt gives the model a fixed routine for dropped files:

1. **Look first** (`read_upload` or the attached document): bank or broker, account, currency, period, and whether it holds transactions, balances or positions.
2. **Match or create the account** (`list_accounts`, `create_account` with the right currency). Ask only if it's genuinely ambiguous.
3. **Import**:
   - CSV → `import_csv_upload`. The server parses the whole file (no size limit from the context window), guesses the column mapping, and returns a preview and parse errors. With `dryRun: true` nothing is written, so the model checks dates and signs first and re-runs with an explicit `mapping` if needed.
   - PDF or screenshot → the model extracts the rows and calls `import_transactions` (signed amounts, ISO dates, up to 2000 rows per call).
   - Closing balances → `record_balance`. Broker positions → `upsert_holding`, with `search_symbol` (ISINs work) for tickers.
4. **Categorize** what the rules missed with `categorize_transactions`, using `rememberPattern` for recurring merchants, then **summarize** what changed.

Both import tools go through `importTransactions()`, so duplicates are skipped by the same `import_hash` as the CSV wizard and categorization rules apply.

## CLI providers

[providers/cli.ts](gh:src/server/agent/providers/cli.ts) spawns the user's own CLI so it runs on their existing login or subscription:

- **Claude Code**: `claude -p <message> --output-format stream-json --verbose --mcp-config <wallet server> --strict-mcp-config --tools "" --allowedTools mcp__wallet --append-system-prompt <prompt>`, plus `--resume <session>` for follow-ups.
- **Codex**: `codex exec --json --skip-git-repo-check` with the wallet server configured through `-c mcp_servers.wallet.*`, `approval_policy="never"` and `sandbox_mode="read-only"`. Codex has no system-prompt flag, so the instructions lead the first message of a thread; follow-ups use `exec resume <thread>`.
- The MCP server is `node bin/wallet-mcp.mjs` (or `WALLET_MCP_COMMAND`) with `WALLET_DB_PATH` (absolute) and `WALLET_USER_ID` set to the conversation's user, plus `WALLET_AGENT_READONLY`, `WALLET_TIMEZONE`, `WALLET_CURRENCY` and `WALLET_LOCALE` when set.
- The process starts in a neutral temporary directory (`$TMPDIR/wallet-agent`), so it reads no project files or instructions, and is killed if the request is aborted.
- Its JSON event stream is mapped to the same `AgentEvent`s (tool names lose their `mcp__wallet__` prefix). The CLI session id is stored on the conversation (`external_session_id`) to resume the thread.
