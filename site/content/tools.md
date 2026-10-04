---
title: Agent tools
description: Every tool in the registry the assistant, the MCP server and the REST API share, with its parameters. Generated from the code at build time.
section: reference
order: 1
generate: tools
---

All agent surfaces expose one registry, `TOOLS` in [src/server/agent/tools.ts](gh:src/server/agent/tools.ts):

| Surface | How it gets the tools |
|---|---|
| Built-in assistant, `anthropic` provider | Tool definitions in every Messages API request ([Agent internals](agent.html)) |
| Built-in assistant, `claude-code` / `codex` providers | The wallet MCP server is the CLI's only tool |
| MCP over stdio | `bin/wallet-mcp.mjs` ([MCP & API](mcp.html)) |
| MCP over Streamable HTTP | `POST /api/mcp` |
| Plain HTTP | `GET /api/tools`, `POST /api/tools/<name>` ([HTTP API](api.html)) |

## How a call runs

`callTool(ctx, name, input)` is the single entry point:

1. **Lookup.** Only *enabled* tools are callable. With `WALLET_AGENT_READONLY=1`, write tools are removed from every surface, so a call to one fails with `Unknown or disabled tool`.
2. **Validation.** The input is parsed with the tool's zod schema. Defaults below are applied and failures come back as `Invalid input: …` (HTTP 400 on `/api/tools`).
3. **Run.** The tool calls services with `ctx.userId`. Every tool acts for exactly one user: the signed-in user, the bearer token's or local default user (`WALLET_USER_ID`, else the owner), or the Telegram chat's linked user.
4. **Result.** Results with the user's money are labelled with their currency (`labelCurrency()`): objects without a `currency` get `baseCurrency`, and arrays become `{ baseCurrency, items }`. Calculators, conversions, SQL and file reads are left as they are. The value then goes through `present()`: fields ending in `Cents` become currency units without the suffix (`balanceCents: 123456` → `balance: 1234.56`), dates become ISO strings, and `userId` and binary buffers are dropped. Errors thrown by services are returned as the message text, flagged as an error.
5. **Cache.** After any write tool, the user's [SQL sandbox](security.html#the-sql-sandbox) is dropped so the next `query_sql` sees the change.

MCP clients also see each tool's `title` and a `readOnlyHint` annotation that matches the access column below.

```bash
# List every enabled tool with its JSON Schema, then call one directly (no LLM involved)
curl localhost:3000/api/tools
curl -X POST localhost:3000/api/tools/get_budget_status \
  -H 'Content-Type: application/json' -d '{"month":"2026-09"}'
```

> [!NOTE]
> Descriptions are prompts: the model reads them to decide which tool to call. Keep them precise when you add a tool, and add it to the registry once; every surface picks it up.
