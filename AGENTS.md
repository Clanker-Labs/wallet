<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Wallet — notes for coding agents

Self-hosted net worth & budget tracker. Next.js 16 (App Router) + React 19 + Tailwind v4 + SQLite (better-sqlite3 + drizzle) + Recharts.

- **Commands:** `npm test` (vitest), `npm run typecheck`, `npm run dev`, `npm run worker` (Telegram + hourly FX/prices), `npm run mcp` (stdio MCP), `npm run db:seed-demo`, `npm run auth:link` (one-time sign-in link), `npm run db:generate` after schema changes (commit the generated `drizzle/` files).
- **Layers:** `src/lib` is pure (safe in the browser); `src/server/services` holds all domain logic and is the only place that touches the DB; pages, API routes, agent tools and the Telegram bot all call services.
- **Multi-user:** every user-owned row has `userId` and every service takes `uid` first. Pages use `(await requireUser()).id`, server actions `await requireUid()`, API routes `await apiUser(request)` (all in `src/server/session.ts`). Never query user tables without the uid filter. Agent tools get `ctx.userId`; `query_sql` runs on a per-user in-memory copy (`src/server/agent/sql-sandbox.ts`).
- **Auth:** passkeys only (`src/server/services/passkeys.ts`, @simplewebauthn), sessions in `sessions` (hashed token, `wallet_session` cookie). `src/proxy.ts` gates pages; `/api/*` is open when `WALLET_API_TOKEN` is empty (local use, acts as the owner / `WALLET_USER_ID`).
- **Money is integer cents** in the DB and services (`…Cents` fields), always paired with a `currency` (accounts, holdings, transactions). The user's base currency (default USD) is `getSettings(uid).currency`; convert with `fxConverter()` / `valuationContext(uid)` (rates per USD per day, fetched by `ensureFreshRates`). Agent tools convert to currency units via `present()`. Dates are ISO strings (`YYYY-MM-DD`, months `YYYY-MM`).
- **Liabilities** store the amount owed as a positive balance; `ownershipPct` scales net-worth contribution; accounts with `loanParams` derive balances from their amortization schedule; accounts with holdings are valued from quantity × price (`prices` table, Yahoo chart API) today and from snapshots in the past.
- **Agent tools** live in one registry (`src/server/agent/tools.ts`) shared by the Claude API loop, the MCP server (stdio + `/api/mcp`), local CLI providers and `/api/tools`. Add a tool there once; keep descriptions precise — they are prompts. Call `invalidateSqlSandbox(userId)` after writes.
- **Uploads** (`/api/uploads`, Telegram files) are stored in `uploads` and attached to agent turns by id (`src/server/agent/attachments.ts`: PDFs/images as native blocks for the Claude API, a note + `read_upload` for CLIs).
- **Agent transcripts are append-only** (`agent_messages`): never edit or delete earlier messages of a conversation (thinking blocks must be replayed unchanged).
- **External APIs** (FX, prices) are keyless and may be unreachable: services must degrade (stored data, `missing…` lists), never throw into pages. Tests stub `fetch`.
- **UI:** server components by default; mutations via colocated `actions.ts` server actions + `revalidatePath`. Use primitives in `src/components/ui.tsx`, charts in `src/components/charts.tsx`, brand in `src/components/brand.tsx`; colors come from CSS variables in `globals.css` (light + dark, validated chart palette `--series-1..7`). Text never uses series colors.
