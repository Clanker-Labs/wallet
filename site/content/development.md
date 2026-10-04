---
title: Development
description: Scripts, tests, schema migrations, the conventions the code follows, adding an agent tool, this documentation site, and recording the demo videos.
section: technical
order: 8
---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Next.js dev server on <http://localhost:3000> |
| `npm run build` / `npm start` | Production build (standalone output) and server |
| `npm run worker` | Telegram bot, reminder scheduler, hourly FX and prices (`-- --once`, `-- --test`) |
| `npm run mcp` | The stdio MCP server (same as `node bin/wallet-mcp.mjs`) |
| `npm test` / `npm run test:watch` | Vitest, once or in watch mode |
| `npm run typecheck` | `tsc --noEmit` over the app, tests and scripts |
| `npm run db:generate` | Generate a migration after editing the schema (drizzle-kit) |
| `npm run db:migrate` | Apply migrations explicitly (they also run on first use) |
| `npm run db:seed-demo` | Load the "Alex" demo data (`-- --force` to add it to a non-empty owner) |
| `npm run auth:link` | Print a one-time sign-in link (`-- --list`, `-- --user <id>`) |
| `npm run site:build` / `npm run site:preview` | Build this site into `site-dist/` and serve it on <http://localhost:4321> |

## Tests

`npm test` runs Vitest on `tests/**/*.test.ts` with `WALLET_DB_PATH=:memory:` and `TZ=UTC`. Each test gets a fresh, migrated in-memory database (`freshDb()` / `freshUser()` in [tests/helpers.ts](gh:tests/helpers.ts)). External APIs are never called: tests stub `fetch`, and the Telegram bot and the agent loop run against fakes.

| File | Covers |
|---|---|
| `finance.test.ts` | Loan math, property purchase, buy vs rent, projection |
| `money-dates.test.ts` | Amount parsing and formatting, dates |
| `schedule.test.ts` | Reminder recurrence (`nextOccurrence`) |
| `services.test.ts` | Net worth, transactions and budgets, reminders |
| `multiuser.test.ts` | Isolation between users (also through agent tools), exchange rates and fallbacks, Yahoo parsing and holdings, uploads and agent imports, one-time codes, token-less API access, the sign-up policy |
| `passkeys.test.ts` | Registration and sign-in with a software authenticator |
| `telegram.test.ts` | Command parsing, `/balance`, `/spent`, reminder replies and buttons, the scheduler, the walkthrough, linking, files |
| `agent.test.ts` | The tool layer (schemas, validation, read-only SQL and mode) and the Claude API loop (history, events, dangling tool calls, refusals) |

CI ([.github/workflows/ci.yml](gh:.github/workflows/ci.yml)) runs `npm ci`, the typecheck, the tests and a production build on every push and pull request.

## Schema changes

1. Edit [src/server/db/schema.ts](gh:src/server/db/schema.ts). Every user-owned table needs a `user_id` referencing `users.id` with `onDelete: "cascade"`.
2. `npm run db:generate` writes a SQL migration and snapshot into `drizzle/`. **Commit them.**
3. Every process applies pending migrations when it opens the database; nothing else to run in production.

The [data model reference](data-model.html) regenerates from the schema when the site is built.

## Conventions

These come from [AGENTS.md](gh:AGENTS.md) and hold across the codebase:

- **Layers:** `src/lib` is pure and safe in the browser; `src/server/services` holds all domain logic and is the only place that touches the database; pages, API routes, agent tools and the Telegram bot all call services.
- **Multi-user:** every service takes `uid` first. Pages use `(await requireUser()).id`, server actions `await requireUid()`, API routes `await apiUser(request)`. Never query a user table without the uid filter.
- **Money** is integer cents (`…Cents`) with a `currency`; convert with `fxConverter()` / `valuationContext(uid)`. Dates are ISO strings.
- **External APIs** (FX, prices) may be unreachable: degrade to stored data and `missing…` lists, never throw into a page.
- **UI:** server components by default; mutations through colocated `actions.ts` server actions plus `revalidatePath`. Use the primitives in `src/components/ui.tsx`, charts in `charts.tsx`, colors from the CSS variables in `globals.css` (validated chart palette `--series-1…7`, never used for text).
- **Agent transcripts are append-only.**
- This is **Next.js 16**: `src/proxy.ts` replaces `middleware.ts`, and the bundled docs in `node_modules/next/dist/docs/` are the reference.

## Adding an agent tool

Add one entry to `TOOLS` in [src/server/agent/tools.ts](gh:src/server/agent/tools.ts):

```ts
tool({
  name: "get_savings_rate",                 // snake_case, stable
  title: "Savings rate",
  description: "Savings rate (net ÷ income) per month for the last N months, base currency.", // a prompt: be precise
  input: z.object({ months: z.number().int().min(1).max(60).default(12) }),
  readOnly: true,                           // false = hidden by WALLET_AGENT_READONLY
  run: ({ months }, { userId }) => budgetSvc.cashflow(userId, months),
}),
```

It then appears in the chat, on Telegram, over MCP (stdio and HTTP), on `/api/tools` and in the [tools reference](tools.html). Return service data as is: `present()` turns `…Cents` into currency units. Write tools that change what `query_sql` can see should call `invalidateSqlSandbox(userId)` (`callTool` also does it after any write).

## This documentation site

The site is static HTML built by [scripts/site/build.tsx](gh:scripts/site/build.tsx) with React's `renderToStaticMarkup`, `react-markdown` and `remark-gfm`; no extra dependencies.

```bash
npm run site:build      # → site-dist/
npm run site:preview    # http://localhost:4321/ (also mounted under /wallet/)
```

- **Pages** are Markdown files in [site/content](gh:site/content). Front matter: `title`, `description` (the lead paragraph and meta description), `section` (`overview`, `features`, `technical` or `reference`), `order`, and optionally `nav` (a shorter sidebar label), `video` (a clip name in `site/media`), `blurb` (the landing page card) and `generate`.
- **Generated reference** (`generate:`): `tools` renders the tool registry with `z.toJSONSchema(input, { io: "input" })`; `data-model` reads the drizzle tables with `getTableConfig` plus the comments in `schema.ts`; `configuration` parses `.env.example` and lists any `process.env` read in `src/` or `bin/` that it doesn't mention; `api` scans `src/app/api` for routes and warns when `api.md` misses one.
- **Markdown extras:** links like `gh:src/proxy.ts` point at the file on GitHub; `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]` and `> [!IMPORTANT]` make callouts; a fenced block with language `diagram` and a name (`architecture`, `currency`, `agent-loop`) embeds an SVG diagram from [scripts/site/diagrams.tsx](gh:scripts/site/diagrams.tsx).
- **Checks:** the build fails on a broken relative link, a missing `#anchor`, a missing asset or a duplicate id. Videos that aren't recorded yet render as a placeholder.
- **Deploy:** [.github/workflows/pages.yml](gh:.github/workflows/pages.yml) builds the site on pull requests and deploys it to GitHub Pages from `main`. Every link is relative, so the output also works from `file://`.

## Recording the demo videos

The clips on this site are recorded from the real app (production build, seeded demo database, a real Chromium) by the scripts in [scripts/demo](gh:scripts/demo): `lib.mjs` (server, recorder, captions, cursor, zoom), `sections/*.mjs` (one per feature page), `cards.mjs`, `cut.mjs`, `demo.mjs` and `promo.mjs` (the full demo and the promo cut) and `record-all.mjs`. Each section writes `site/media/<name>.mp4` and a `.jpg` poster.

```bash
npm run build                               # recordings use `next start`
node scripts/demo/sections/net-worth.mjs    # one clip
node scripts/demo/record-all.mjs            # everything, then the demo and promo cuts
```

They need ffmpeg with libx264 and Playwright's Chromium; the assistant clips also need a logged-in `claude` CLI. Everything else is in [scripts/demo/README.md](gh:scripts/demo/README.md).
