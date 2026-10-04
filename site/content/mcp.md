---
title: MCP & API
description: Use your wallet from Claude Code, Codex, Claude Desktop or any MCP client, or call the same tools over plain HTTP.
blurb: Your wallet as an MCP server and a REST API.
section: features
order: 11
video: mcp
---

Every [agent tool](tools.html) is also available outside the app: as an **MCP server** (stdio or Streamable HTTP) and as a small **REST API**. Ask Claude Code "what did I spend on restaurants this quarter?" from your terminal, or script a monthly import with `curl`.

## MCP over stdio (local)

`bin/wallet-mcp.mjs` starts the server from any working directory: it switches to the repo, loads `.env.local` / `.env`, and runs the TypeScript entry point with `tsx`. It opens the database directly, so the web app doesn't even need to be running.

```bash
# Claude Code
claude mcp add wallet -- node /path/to/wallet/bin/wallet-mcp.mjs
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.wallet]
command = "node"
args = ["/path/to/wallet/bin/wallet-mcp.mjs"]
```

```json
{
  "mcpServers": {
    "wallet": { "command": "node", "args": ["/path/to/wallet/bin/wallet-mcp.mjs"] }
  }
}
```

The last one is the shape of Claude Desktop's `claude_desktop_config.json`. Opening Claude Code inside the repository picks up the project's [.mcp.json](gh:.mcp.json) automatically.

The stdio server acts as **`WALLET_USER_ID`** when set, otherwise the **owner**. A member adds `-e WALLET_USER_ID=<their id>` (Claude Code) or an `env` table (Codex); **Settings → Integrations** prints these snippets with the right paths and ids filled in.

## MCP over HTTP

The web app serves the same tools at `/api/mcp` (stateless Streamable HTTP, JSON responses):

```bash
# Local, no token configured
claude mcp add --transport http wallet http://localhost:3000/api/mcp

# Once WALLET_API_TOKEN is set (required to reach it from another machine)
claude mcp add --transport http wallet https://wallet.example.com/api/mcp \
  --header "Authorization: Bearer $WALLET_API_TOKEN"
```

Without a token, only requests to a local hostname that don't come from another website are accepted ([token-less access](security.html#token-less-local-access)).

## What clients see

- All enabled tools, with their titles, descriptions, JSON Schemas and a `readOnlyHint` annotation. With `WALLET_AGENT_READONLY=1`, write tools don't exist.
- Server instructions: start with `get_overview`; amounts in results are in currency units and totals in your base currency, which the instructions name (e.g. `USD`).
- Every result says its currency: `currency` on results that already carry one, otherwise a `baseCurrency` field (lists come back as `{ baseCurrency, items }`). Rows with their own `currency` (accounts, holdings, transactions) are in that currency.
- A `wallet_assistant` prompt with the same persona and house rules as the built-in assistant.

## REST

```bash
curl localhost:3000/api/tools                                  # every tool + JSON Schema
curl -X POST localhost:3000/api/tools/get_budget_status \
  -H 'Content-Type: application/json' -d '{"month":"2026-09"}'

# Upload a statement, then have the assistant import it
curl -F file=@october.csv localhost:3000/api/uploads           # → [{"id":"…","kind":"csv",…}]
curl -X POST localhost:3000/api/agent -H 'Content-Type: application/json' \
  -d '{"message":"Import this into Chase checking","attachments":["<upload id>"]}'
```

Add `-H "Authorization: Bearer $WALLET_API_TOKEN"` once a token is set. Every route, body and response: [HTTP API](api.html).
