---
title: Architecture
description: How the code is layered, which processes run, and how a request travels from a browser, an MCP client or Telegram down to the SQLite file.
section: technical
order: 1
---

wallet is one Next.js 16 app (App Router, React 19, Tailwind v4) over one SQLite database (better-sqlite3 + drizzle), plus a small worker process. There is no separate API server and no queue: pages, API routes, agent tools and the Telegram bot all call the same service functions in-process.

```diagram
architecture
```

## Layers

| Layer | Where | Rules |
|---|---|---|
| Pure code | [src/lib](gh:src/lib) | Money (integer cents), dates, CSV parsing, reminder schedules, finance math (loans, mortgage, buy vs rent, projection). No I/O: safe in the browser and on the server. |
| Database | [src/server/db](gh:src/server/db) | drizzle schema and the SQLite client. One connection per process, migrated on open. |
| Services | [src/server/services](gh:src/server/services) | All domain logic, and the **only** code that queries the database. Every function takes the user id (`uid`) first and filters on it. |
| Agent | [src/server/agent](gh:src/server/agent) | The tool registry, system prompt, providers (Claude API, local CLIs), MCP server, attachments and the per-user SQL sandbox. Tools call services. |
| Telegram | [src/server/telegram](gh:src/server/telegram) | Bot API client, command handling, `/update` walkthrough, reminder scheduler. Calls services and the agent. |
| App | [src/app](gh:src/app), [src/components](gh:src/components) | Server components by default; mutations through colocated `actions.ts` server actions followed by `revalidatePath`. API routes under `src/app/api`. |
| Entry points | [src/bin](gh:src/bin), [bin/wallet-mcp.mjs](gh:bin/wallet-mcp.mjs) | Worker, stdio MCP server, demo seed, sign-in link, migrations. Run from source with `tsx`. |

## Processes

| Process | Command | Does |
|---|---|---|
| Web | `npm run dev` / `npm start` | Pages, server actions, `/api/*` (auth, assistant, uploads, tools, MCP over HTTP, export, health). |
| Worker | `npm run worker` | Long-polls Telegram, answers commands, runs the reminder scheduler every 30 s, refreshes FX rates and market prices every hour and snapshots holdings-based accounts. `--once` runs one scheduler tick (for cron), `--test` sends a test message. |
| MCP (stdio) | `node bin/wallet-mcp.mjs` | Started on demand by an MCP client, or by the `claude-code` / `codex` providers for each assistant turn. Acts as `WALLET_USER_ID` or the owner. |

All three open the same SQLite file. WAL mode and a 5 s busy timeout let them read and write concurrently; writes are short transactions.

## Request flow

**A page (`/`, the net worth dashboard).** `src/proxy.ts` checks that a `wallet_session` cookie exists, otherwise it redirects to `/login`. The server component calls `requireUser()`, which hashes the cookie and looks the session up in the database, then calls `getOverview(uid)`. That builds a `valuationContext(uid)` once (base currency, FX converter, price reader, holdings) and values every account on every month-end from the stored snapshots, prices and rates. Nothing in the render path calls an external API.

**A form (record a balance).** The server action calls `requireUid()`, then `recordBalance(uid, …)`, which upserts the day's snapshot, and finally `revalidatePath()`.

**An API call (`POST /api/tools/record_balance`).** The proxy lets it through with a session cookie, a valid bearer token, or, when no token is configured, only if it targets a local host and isn't cross-site ([Auth & security](security.html#the-proxy-gate)). The route resolves the user with `apiUser(request)` and runs `callTool({ userId }, name, input)`.

**A Telegram message.** The worker receives it through `getUpdates`, maps the chat to a user (`users.telegram_chat_id`), and either runs a command against the services or hands the text and any attached file to the agent runner.

**An assistant turn.** `runAgent()` picks the provider, appends the user message to the conversation, and loops model ↔ tools until the model stops. Tools run with the conversation owner's id ([Agent internals](agent.html)).

## Design rules

- **Per-user isolation lives in the services.** Every user-owned row has `user_id`, every service takes `uid` first, and lookups by id also check the owner (`getAccountRow(uid, id)` throws "not found" for another user's account). Agent SQL runs on a copy of one user's rows ([SQL sandbox](security.html#the-sql-sandbox)).
- **Money is integer cents with a currency.** Conversion to the base currency happens when reading, with the rate of the relevant day ([Multi-currency internals](multi-currency.html)).
- **External APIs degrade.** FX and price sources are keyless and may be down. Fetches never throw into pages: valuations read stored data, and what's missing is listed (`missingFx`, `missingPrices`) and shown in *Needs attention*.
- **One tool registry.** A tool added to [tools.ts](gh:src/server/agent/tools.ts) appears in the chat, on Telegram, over MCP and on `/api/tools` ([Agent tools](tools.html)).
- **Agent transcripts are append-only**, so thinking blocks replay unchanged.

## Source map

```text
src/
  app/            pages, server actions, API routes (/api/auth, agent, uploads, tools, mcp, export, health)
  components/     UI primitives (ui.tsx), charts (charts.tsx), brand, feature components
  lib/            pure: money, dates, csv-import, schedule, uploads, domain, finance/
  server/
    db/           drizzle schema + SQLite client (auto-migrates)
    services/     domain logic: users, passkeys, accounts, holdings, prices, fx, valuation,
                  networth, overview, budgets, categories, transactions, reminders,
                  simulations, uploads, settings, export, magic-link, telegram-link
    agent/        tools, prompt, runner, providers/, mcp, attachments, sql-sandbox, conversations
    telegram/     api, bot, messages, walkthrough, scheduler
  bin/            worker, mcp (stdio), seed-demo, login-link, migrate
  proxy.ts        request gate (Next.js 16's replacement for middleware.ts)
bin/wallet-mcp.mjs  stdio MCP launcher that works from any directory
drizzle/            generated SQL migrations
```
