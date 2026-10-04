# wallet

Self-hosted personal finance tracker in the spirit of Finary: **net worth** across every asset class, **monthly budgets**, purchase **simulations**, an **AI assistant** that can read (and update) your data, and **Telegram reminders** that nag you until you've updated your numbers.

Your data stays in one SQLite file on your machine.

![dashboard](docs/dashboard.png)

## What it does

| | |
|---|---|
| 📈 **Net worth** | Accounts grouped by asset class (cash, investments, retirement, real estate, crypto, other, liabilities). Balance snapshots over time → monthly history, 1M / YTD / 1Y change, allocation. Ownership share (a flat bought 50/50), mortgages that **amortize automatically** from their loan terms. |
| 🧾 **Budgets** | Monthly envelope per category with a "spending too fast" pace marker, income / expenses / savings rate, 12-month cash flow. Transfers between your own accounts are ignored. |
| 🏦 **Transactions** | Bank CSV import (French formats, `;`, decimal commas, debit/credit columns), duplicate-safe re-imports, one-click "always categorize *carrefour* as Groceries" rules. |
| 🏠 **Simulations** | Mortgage with French defaults (notary fees, borrower insurance, guarantee, HCSF 35% cap, APR), borrowing capacity, buy-vs-rent over N years, net-worth projection with Monte Carlo band and financial-independence date — prefilled from your data. |
| 🤖 **Assistant** | Chat in the web app or Telegram. Runs on the Claude API, **or on your local `claude` / `codex` CLI login**. The same 23 tools are exposed as an **MCP server** (stdio + HTTP) and a plain REST API. |
| 🔔 **Telegram** | Scheduled reminders (update balances, import the statement, monthly report…) with ✅ / snooze buttons that re-send until done. `/update` walks you through every account one question at a time (just reply with numbers). `/networth`, `/budget`, `/balance`, `/spent`, `/ask`. |

## Quick start

```bash
npm install
cp .env.example .env          # optional: currency, locale, API keys, Telegram
npm run db:seed-demo          # optional: 2 years of demo data
npm run dev                   # http://localhost:3000
```

Requires Node 22+. The database is created and migrated on first use (`./data/wallet.db`, override with `WALLET_DB_PATH`).

The monthly routine the app is built around:

1. 🔔 Telegram pings you on the 1st → tap **Update balances now** and answer one number per account (or click them in **Accounts**).
2. 📥 Import last month's bank CSV in **Transactions → Import**; rules categorize most of it.
3. 🤖 Ask the assistant to categorize the rest and explain what changed.

## Production (Docker)

```bash
cp .env.example .env   # set WALLET_PASSWORD, WALLET_API_TOKEN, Telegram, ANTHROPIC_API_KEY…
docker compose up -d   # web on :3000 + Telegram worker, sharing a `wallet-data` volume
```

Without Docker: `npm run build && npm start` for the web app and `npm run worker` for Telegram (keep both running, e.g. with systemd or pm2).

Put it behind HTTPS and **set `WALLET_PASSWORD`** if it's reachable from a network.

## AI assistant & agentic access

All agent surfaces share one tool registry ([`src/server/agent/tools.ts`](src/server/agent/tools.ts)): overview, net worth (+history), accounts, transactions, spending, budgets, cash flow, categories, reminders, read-only SQL, mortgage / capacity / buy-vs-rent / projection simulators, and write tools (record balance, add & categorize transactions, set budgets, create accounts / categories / reminders). Set `WALLET_AGENT_READONLY=1` to hide the write tools everywhere.

### 1. Built-in chat (web + Telegram)

Pick a backend with `WALLET_AGENT_PROVIDER`:

| Provider | Uses | Setup |
|---|---|---|
| `anthropic` (default) | Claude API (`claude-opus-5-5`, adaptive thinking, server-side refusal fallback) | `ANTHROPIC_API_KEY=…` or `ant auth login` |
| `claude-code` | your local Claude Code login, headless | `claude` on the PATH |
| `codex` | your local Codex login, headless | `codex` on the PATH |

Local CLI providers get the wallet MCP server as their **only** tool (no shell, no file access).

### 2. MCP server — use your wallet from Claude Code, Codex, Claude Desktop…

```bash
# Claude Code (stdio)
claude mcp add wallet -- node /path/to/wallet/bin/wallet-mcp.mjs

# Codex: ~/.codex/config.toml
[mcp_servers.wallet]
command = "node"
args = ["/path/to/wallet/bin/wallet-mcp.mjs"]

# Remote (Streamable HTTP) — requires WALLET_API_TOKEN
claude mcp add --transport http wallet https://wallet.example.com/api/mcp \
  --header "Authorization: Bearer $WALLET_API_TOKEN"
```

Opening Claude Code inside this repo picks up [`.mcp.json`](.mcp.json) automatically.

### 3. HTTP API

```bash
# Chat (JSON, or SSE with "stream": true)
curl -X POST localhost:3000/api/agent -H "Authorization: Bearer $WALLET_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"message":"How much did I spend on restaurants this year?"}'

# Call any tool directly (no LLM)
curl localhost:3000/api/tools -H "Authorization: Bearer $WALLET_API_TOKEN"            # list + JSON schemas
curl -X POST localhost:3000/api/tools/get_budget_status -H "Authorization: Bearer $WALLET_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"month":"2026-09"}'
```

## Telegram reminders

1. Create a bot with [@BotFather](https://t.me/BotFather) → `TELEGRAM_BOT_TOKEN`.
2. `npm run worker`, send `/start` to your bot: it replies with your chat id → `TELEGRAM_CHAT_ID` (comma-separated allowlist; nobody else gets any data).
3. Create reminders in **Reminders** (presets: update balances on the 1st, import the statement on the 3rd, monthly report…). Set "re-send every 24h" and it keeps nagging until you tap ✅.

`npm run worker -- --test` sends a test message; `--once` runs a single scheduler tick (for cron).

## Concepts

- **Accounts & snapshots** — an account's balance on any date is its latest snapshot on or before that date. Loans with loan terms compute their balance from the amortization schedule instead.
- **Liabilities** are stored as positive amounts owed and subtracted from net worth.
- **Ownership %** scales an account's contribution (joint flat, shared mortgage).
- **Categories** are `income`, `expense` or `transfer`; transfers (e.g. "to PEA") never count as spending. Uncategorized rows count by sign.
- **Rules** — "description contains *pattern*" → category; longest match wins; applied on import and on demand.

## Development

```bash
npm test            # vitest: finance math, services, reminders, Telegram bot, agent loop
npm run typecheck
npm run db:generate # after editing src/server/db/schema.ts
```

```
src/
  app/               Next.js pages + API routes (/api/agent, /api/mcp, /api/tools, /api/export)
  components/        UI primitives, charts
  lib/               pure code: money, dates, CSV import, schedules, finance/ (loan, mortgage, buy-vs-rent, projection)
  server/
    db/              drizzle schema + SQLite client (auto-migrates)
    services/        domain logic (accounts, net worth, budgets, transactions, reminders…)
    agent/           tool registry, prompt, providers (Claude API, local CLIs), MCP server
    telegram/        bot API client, commands, reminder scheduler
  bin/               worker (Telegram), mcp (stdio), seed-demo, migrate
bin/wallet-mcp.mjs   MCP launcher that works from any directory
```

## Roadmap ideas

- Bank sync (GoCardless / Powens) instead of CSV.
- Holdings with live prices (ETFs, crypto) instead of balance snapshots.
- Multi-currency accounts with FX.
- Budget overrides per month and rollover envelopes.
