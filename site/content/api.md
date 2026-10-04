---
title: HTTP API
description: Every route under /api with its method, authentication, request body and response.
section: reference
order: 2
generate: api
---

All routes live under `src/app/api` and return JSON unless noted. They accept three kinds of callers:

| Caller | How | Acts as |
|---|---|---|
| Browser | `wallet_session` cookie (set by the passkey routes) | The signed-in user |
| Script with a token | `Authorization: Bearer $WALLET_API_TOKEN` | `WALLET_USER_ID`, or the owner |
| Local script, no token configured | Nothing, if it passes the [local-only rules](security.html#token-less-local-access) | `WALLET_USER_ID`, or the owner |

Below, **app auth** means any of those three. A missing or wrong token gets **401**, a token-less request from a non-local host or another site gets **403**, and an authorized call before anyone has signed up gets **401**.

```bash
# With a token configured, add this to every call:
-H "Authorization: Bearer $WALLET_API_TOKEN"
```

## Health

### `GET /api/health`

Open. Runs `SELECT 1` against the database and returns `{"ok": true}`. The Docker healthcheck polls it.

## Passkeys and sessions

These are open (they must work signed out) and are called by the sign-in pages; you rarely call them by hand. See [Auth & security](security.html#passkeys) for the ceremony.

### `POST /api/auth/register/options`

Body: `{"name"?: string (≤60), "mode"?: "device" | "phone"}`. Signed out, this starts a **sign-up**: `name` is required, and it is refused with 403 when [sign-ups are closed](signup.html). Signed in, it starts **adding a passkey** to your account. Returns WebAuthn creation options and sets the `wallet_challenge` cookie (5 minutes). `phone` adds the `hybrid` hint for the QR code flow.

### `POST /api/auth/register/verify`

Body: `{"response": RegistrationResponseJSON, "label"?: string}`. Verifies the new credential against the challenge, creates the user on sign-up (the first user becomes the owner) and starts a session. Returns `{"ok": true, "user": {"id", "name"}}`, or 400 with `{"error"}`.

### `POST /api/auth/login/options`

Body: `{"mode"?: "device" | "phone"}`. Returns WebAuthn request options for a discoverable credential and sets the challenge cookie.

### `POST /api/auth/login/verify`

Body: `{"response": AuthenticationResponseJSON}`. Verifies the assertion, updates the signature counter and starts a 90-day session. Returns `{"ok": true, "user": {"id", "name"}}`, or 401.

### `POST /api/auth/logout`

Deletes the current session and clears the cookie. Returns `{"ok": true}`.

### `GET /api/auth/magic?code=…`

Redeems a one-time link printed by `npm run auth:link` (15 minutes, single use), starts a session and redirects to `/settings#security`. An invalid or expired code gets a plain-text 401.

## Assistant

### `GET /api/agent`

Which backend is configured and whether it can run: `{"provider": "anthropic" | "claude-code" | "codex" | "none", "ready": boolean, "reason"?: string, "model"?: string}`.

### `POST /api/agent`

App auth. Runs one assistant turn as the caller. Body:

| Field | Type | Notes |
|---|---|---|
| `message` | string, ≤ 20 000 chars | May be empty when `attachments` is set: the assistant is then asked to import the files. |
| `conversationId` | string, optional | Continue a thread. Omit it, or pass one from another backend, to start a new one. |
| `attachments` | string[], ≤ 10 | Upload ids from `POST /api/uploads`. |
| `channel` | `"web"` \| `"telegram"` | Formatting style of the answer. Default `"web"` (Markdown). |
| `stream` | boolean, optional | Stream server-sent events instead of waiting. `Accept: text/event-stream` does the same. |

Without streaming: `{"conversationId", "text"}`, or 500 with `{"error"}`. With streaming, the response is `text/event-stream` with one `data: <JSON>` line per event, until `done` or `error`:

| Event | Fields | Meaning |
|---|---|---|
| `conversation` | `id`, `provider` | The thread this turn belongs to (sent first). |
| `text` | `delta` | Answer text as it's generated. |
| `text_reset` | | Discard the text streamed so far in this step (retry or model fallback). |
| `tool_start` | `id`, `name`, `input` | A tool call started. |
| `tool_end` | `id`, `name`, `ok` | It finished. |
| `step` | | One model step done; more may follow. |
| `error` | `message` | The turn failed. |
| `done` | `text` | The final answer. |

```bash
curl -N -X POST localhost:3000/api/agent -H 'Content-Type: application/json' \
  -d '{"message": "How much did I spend on groceries this month?", "stream": true}'
```

Turns in the same conversation run one at a time. The route allows up to 300 s.

### `GET /api/agent/conversations`

App auth. Your 50 most recently updated threads: `id`, `title`, `channel`, `provider`, `externalSessionId`, `createdAt`, `updatedAt`.

### `GET /api/agent/conversations/:id`

App auth. `{"conversation", "messages"}`, where `messages` is a display transcript: `{role, text, tools: string[], files: string[]}` per bubble (tool results and thinking are left out). 404 for an unknown id or someone else's thread.

### `DELETE /api/agent/conversations/:id`

App auth. Deletes the thread and its messages. 204.

## Uploads

### `POST /api/uploads`

App auth. `multipart/form-data` with one or more `file` fields (up to 10 per request, 15 MB each). Accepted: CSV/TSV, TXT/OFX/QIF/QFX/JSON/MD, PDF, PNG/JPEG/WebP/GIF. Returns one entry per stored file:

```json
[{ "id": "8f0c…", "filename": "october.csv", "size": 18234, "kind": "csv" }]
```

`kind` is `csv`, `text`, `pdf` or `image`. Pass the ids as `attachments` to `/api/agent`, or to tools such as `import_csv_upload` and `read_upload`. Errors: 400 (no file, unsupported type, a file over 15 MB), 413 when the request declares more than 45 MB.

Requests go through `src/proxy.ts`, and Next.js buffers at most 16 MB of a proxied body (`experimental.proxyClientMaxBodySize`), so send large files **one per request**, as the web app does.

### `GET /api/uploads`

App auth. Your 20 most recent uploads: `id`, `filename`, `mimeType`, `size`, `createdAt`.

## Tools

### `GET /api/tools`

Every enabled tool: `{name, title, description, readOnly, inputSchema}`, where `inputSchema` is JSON Schema. Write tools are missing when `WALLET_AGENT_READONLY=1`.

### `POST /api/tools/:name`

App auth. The JSON body is the tool's input (see [Agent tools](tools.html)). Returns the tool's result as JSON, with cents already converted to currency units. Invalid input, an unknown or disabled tool, or an error inside the tool gives 400 with `{"error"}`.

```bash
curl -X POST localhost:3000/api/tools/record_balance -H 'Content-Type: application/json' \
  -d '{"accountId": 3, "balance": 12500, "note": "from the bank app"}'
```

## MCP

### `GET | POST | DELETE /api/mcp`

App auth. The wallet MCP server over **Streamable HTTP**, stateless (no session id) with JSON responses. Each request builds a server bound to the caller's user. It exposes every enabled tool plus a `wallet_assistant` prompt. Returns 401 when no user can be resolved (wrong token, or nobody has signed up yet). Client setup is on [MCP & API](mcp.html).

## Export

### `GET /api/export`

App auth. Downloads `wallet-export-YYYY-MM-DD.json`: your accounts, balance snapshots, holdings, categories, rules, transactions, budgets, reminders, saved simulations, conversation list and settings (`"format": 2`). Chat messages and uploaded files aren't included; back up the database file for a complete copy.
