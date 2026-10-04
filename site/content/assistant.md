---
title: Assistant
description: Chat with your finances in the web app or on Telegram, and drop statements anywhere for it to import. Runs on the Claude API or on your local claude / codex CLI login.
blurb: Ask questions, drop statements, let it do the data entry.
section: features
order: 7
video: assistant
---

The assistant is a chat at `/assistant` (and in Telegram) that works on your data through the same [34 tools](tools.html) you can call yourself. It answers with figures from tool results, never from memory, and it can make changes: import transactions, record balances, add holdings, set budgets, create reminders.

## Asking

Answers stream in as they're written, and each tool call shows as a small chip: running, done or failed. Some things to try:

- "How is my net worth trending, and what drove the last 3 months?"
- "Where did my money go this month vs my 6-month average?"
- "Categorize my uncategorized transactions and create rules for recurring merchants."
- "Can I afford a €450k apartment with €80k down? Compare with renting at €1,400/month."
- "If I keep saving like this, when do I reach financial independence?"

Conversations are kept and listed on the side; **New chat** starts a fresh thread and **Stop** cancels a running answer. For anything the dedicated tools don't cover, the assistant writes a read-only SQL query over a private copy of your data ([SQL sandbox](security.html#the-sql-sandbox)).

## Dropping statements

Drag files **anywhere in the app** (or use the 📎 button, up to 10 files of 15 MB each): CSV/TSV, TXT, OFX/QIF, PDF statements, and screenshots (PNG, JPEG, WebP, GIF). They're uploaded, the assistant opens with them attached, and it starts importing even if you don't type anything. It follows a fixed routine:

1. **Look first**: identify the bank or broker, the account, currency, period, and whether the file lists transactions, balances or positions.
2. **Match or create the account** (with the right currency); it asks only when it's genuinely ambiguous.
3. **Import**:
   - CSV → `import_csv_upload`, which parses the **whole file on the server** whatever its size, guessing the columns; with unusual columns it does a dry run first and checks signs and dates in the preview.
   - PDF or screenshot → the model reads it, extracts the rows and calls `import_transactions` (signed amounts, ISO dates).
   - Closing balances → `record_balance`. Broker positions → `upsert_holding`, using `search_symbol` or ISINs to find tickers.
4. **Categorize** what the rules missed, creating rules for recurring merchants, then **summarize** what changed.

Duplicates are skipped exactly as in the CSV wizard, so dropping the same statement twice is harmless.

## Backends

Choose one with `WALLET_AGENT_PROVIDER` ([Configuration](configuration.html#assistant)):

| Provider | Runs on | PDFs and images | Setup |
|---|---|---|---|
| `anthropic` (default) | The Claude API: `claude-opus-5-5` by default (`WALLET_AGENT_MODEL`), adaptive thinking, effort `medium` (`WALLET_AGENT_EFFORT`) | Sent natively as document and image blocks | `ANTHROPIC_API_KEY`, or `ant auth login` |
| `claude-code` | Your local Claude Code login, headless (`claude -p`) | PDFs as extracted text through `read_upload`; images aren't readable | `claude` on the `PATH` |
| `codex` | Your local Codex login, headless (`codex exec`) | Same as claude-code | `codex` on the `PATH` |
| `none` | Disabled | | |

The local CLI providers get the wallet MCP server as their **only** tool: no shell, no file access, no project instructions. A conversation belongs to the backend that started it; switching providers starts a new thread. **Settings → Integrations** shows which backend is active and whether it's ready.

Set `WALLET_AGENT_READONLY=1` to remove every write tool: the assistant can then analyze but not change anything. How the loop works, including transcripts, caching and fallbacks: [Agent internals](agent.html).

## On Telegram

Any message that isn't a command goes to the assistant (or use `/ask`), and so does any file you send the bot. Each chat keeps one running conversation; `/new` starts a fresh one. Answers are formatted for Telegram: short lines, no tables. See [Reminders & Telegram](telegram.html).
