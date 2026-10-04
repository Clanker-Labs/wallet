---
title: Auth & security model
nav: Auth & security
description: Passkeys and the iPhone QR flow, sessions, the request gate, token-less local API access, per-user isolation, the agent's SQL sandbox and the sign-up policy.
section: technical
order: 2
---

wallet has no passwords and no OAuth. People sign in with **passkeys** (WebAuthn); programs use either a local, token-less mode or a bearer token. Everything a person owns is scoped to their user id, down to the SQL the assistant can run.

## Passkeys

Ceremonies live in [src/server/services/passkeys.ts](gh:src/server/services/passkeys.ts) on top of `@simplewebauthn/server`; the browser side uses `@simplewebauthn/browser`.

| | Registration (sign-up, or *Add a passkey*) | Sign-in |
|---|---|---|
| Endpoint | `POST /api/auth/register/options` → `…/verify` | `POST /api/auth/login/options` → `…/verify` |
| Credential | Discoverable (`residentKey: "required"`), user verification preferred, attestation `none`. Existing passkeys of a signed-in user are excluded. | Discoverable: no allow-list, the authenticator offers the account. |
| Stored | `passkeys` row: credential id, public key, signature counter, transports, device type, backed-up flag, a label | The counter and `last_used_at` are updated |

**Challenges** are random, stored in `auth_challenges` with a 5-minute expiry and deleted the moment they are used, so each one works once. The browser only holds the challenge's id in a `wallet_challenge` cookie (`HttpOnly`, `SameSite=Strict`, path `/api/auth`, 5 minutes).

**Relying party.** The origin is `WALLET_PUBLIC_URL` when set, otherwise it's rebuilt from the request (`X-Forwarded-Proto` / `X-Forwarded-Host`, then `Host`). The RP id is `WALLET_RP_ID` or that origin's hostname. A passkey is bound to its RP id, so pick the final hostname before people register.

> [!IMPORTANT]
> Browsers only allow WebAuthn in a secure context: `https://…`, or `http://localhost`. A raw IP or a LAN name over plain http won't work. Put the app behind HTTPS and set `WALLET_PUBLIC_URL` when you reach it through a reverse proxy.

### The iPhone QR flow (hybrid transport)

The sign-in and sign-up screens offer two buttons. *This device* runs a normal ceremony (Touch ID, Windows Hello, a password manager). *Use my iPhone (QR code)* runs the same ceremony in **phone mode**:

- registration options get `preferredAuthenticatorType: "remoteDevice"`, which sets the WebAuthn hint `hybrid` and `authenticatorAttachment: "cross-platform"`;
- sign-in options get `hints: ["hybrid"]`.

With that hint, Chrome, Edge and Safari skip their chooser and show a **QR code** right away. The iPhone camera scans it, the phone and the computer confirm they are close to each other over Bluetooth, Face ID approves, and the passkey is created in, or read from, **iCloud Keychain**. The server sees an ordinary WebAuthn response. Passkeys made this way are labelled "iPhone"; others are named from their transports ("This device", "Security key", "Phone").

### Managing passkeys

**Settings → Security** lists your passkeys with their device type, sync status and last use, and lets you add, rename or remove them. Deleting the **last** passkey is refused, so you can't lock yourself out.

### Recovery and first login: sign-in links

`npm run auth:link` (shell access to the server required) prints a one-time link: 24 random bytes, valid **15 minutes**, single use. `GET /api/auth/magic?code=…` redeems it, starts a session and opens *Settings → Security* so you can add a passkey. Use it for a seeded demo account or after losing every passkey; `-- --user <id>` targets someone other than the owner.

## Sessions

- A sign-in creates 32 random bytes, sent as the `wallet_session` cookie (`HttpOnly`, `SameSite=Lax`, path `/`, `Secure` when the request came over https per `X-Forwarded-Proto`, or `WALLET_PUBLIC_URL` starts with `https://`).
- The database stores only the **SHA-256** of the token (`sessions.id`), with the user agent and an expiry **90 days** out. A database leak doesn't hand out live cookies.
- Every page and route re-checks the cookie against the database (`requireUser()` for pages, `requireUid()` for server actions, `apiUser()` for API routes). Signing out deletes the row.

## The proxy gate

[src/proxy.ts](gh:src/proxy.ts) runs before every request (Next.js 16's `proxy`, formerly middleware). It is an optimistic first filter: it only checks that a cookie *exists*; the routes verify it.

| Request | Rule |
|---|---|
| Pages | Need a `wallet_session` cookie, except `/login` and `/signup`. Otherwise redirect to `/login?next=…`. |
| `/api/auth/*`, `/api/health` | Always open (the auth ceremonies must work signed out). |
| Other `/api/*` with a session cookie | Passed through; the route checks the session. |
| Other `/api/*`, `WALLET_API_TOKEN` set | Need `Authorization: Bearer <token>` (constant-time comparison), else **401**. |
| Other `/api/*`, no token configured | Allowed only if `tokenlessAccess()` accepts the request, else **403**. |

Static assets (`/_next/static`, icons, the web manifest) bypass the proxy.

### Token-less local access

wallet is meant to run on your own machine, so out of the box `/api/*` and `/api/mcp` need no token **from this machine**. Such requests act as the default user: `WALLET_USER_ID` if set, otherwise the owner. `tokenlessAccess()` in [src/server/auth.ts](gh:src/server/auth.ts) accepts a request only when:

1. **Every host is local.** `Host` and each `X-Forwarded-Host` entry must be `localhost`, `127.0.0.1`, `::1`, a `*.localhost` name, or a name listed in `WALLET_ALLOWED_HOSTS`. This defeats **DNS rebinding**: a malicious site that points its own domain at 127.0.0.1 still sends its domain as `Host`. It also means a reverse proxy that forwards your public hostname turns token-less access off.
2. **It isn't cross-site.** An `Origin` header, when present, must be local too (`Origin: null` is rejected), and `Sec-Fetch-Site: cross-site` is rejected. A web page you visit can't drive your wallet's API.

This protects against browsers, not against someone who can reach the port. **Set `WALLET_API_TOKEN` (for example `openssl rand -hex 32`) as soon as the app is reachable from a network.** With a token, bearer calls act as the default user too.

## Per-user isolation

One install can host several people, each with a private wallet:

- Every user-owned table has `user_id` (`ON DELETE CASCADE`); balance snapshots and agent messages are reached through their account or conversation.
- Every service function takes `uid` first and filters on it. Lookups by id check the owner as well: asking for another user's account, holding, reminder or upload returns *not found*.
- Agent tools receive `ctx.userId` from the caller (session, token/default user, or the Telegram chat's linked user), never from the model's input.
- Telegram chats are linked one-to-one to a user ([Telegram bot internals](telegram-bot.html#linking-a-chat)); a chat that isn't linked gets nothing but its chat id.
- `prices` and `fx_rates` are shared market data with no personal information.

## The SQL sandbox

`query_sql` lets the assistant run arbitrary `SELECT`s for analysis the other tools don't cover. It never touches the real database ([src/server/agent/sql-sandbox.ts](gh:src/server/agent/sql-sandbox.ts)):

- A private **in-memory** SQLite database is built per user with the same DDL, holding only that user's rows of `accounts`, `holdings`, `categories`, `category_rules`, `budgets`, `transactions`, `reminders`, `simulations` and `settings`; their `balance_snapshots` (joined through accounts); `prices` for the symbols they hold; and `fx_rates` for the currencies they use (plus USD and their base currency).
- `users`, `sessions`, `passkeys`, `auth_challenges`, `uploads` and the agent tables don't exist there.
- Only one statement is accepted, and better-sqlite3 must report it as a read-only reader (`stmt.reader && stmt.readonly`), so `INSERT`, `UPDATE`, `ATTACH`, `PRAGMA` writes and the like are refused. At most 500 rows come back.
- The copy is cached for 15 seconds to serve a burst of queries, and dropped after any write tool.

## The assistant's reach

- `WALLET_AGENT_READONLY=1` removes every write tool from the chat, Telegram, MCP and `/api/tools`.
- The `claude-code` and `codex` providers run the CLI with the wallet MCP server as its **only** tool: Claude Code gets `--strict-mcp-config`, `--tools ""` and `--allowedTools mcp__wallet`; Codex runs with `sandbox_mode="read-only"` and `approval_policy="never"`. Both start in a neutral temporary directory, so they pick up no project files or instructions.

## Sign-up policy

- The **first** account can always be created; it becomes the **owner**.
- After that, `/signup` is closed unless `WALLET_ALLOW_SIGNUP` is `1`, `true`, `yes` or `on`. The registration endpoint enforces the same rule (403 *Sign-ups are closed*), not just the page.
- Members get the same features and fully separate data. The owner also sees the member list in **Settings → Members**, and is the user that token-less API calls, the stdio MCP server and `TELEGRAM_CHAT_ID` chats act as unless `WALLET_USER_ID` says otherwise.

## Data at rest

Everything, including uploaded statements, lives in the SQLite file (uploads as blobs, 15 MB max each, CSV/TXT/OFX/QIF/PDF/PNG/JPG/WebP/GIF only). Protect and back up that file like any financial record. Secrets (API keys, bot token, API token) live only in the environment; **Settings → Integrations** shows whether they are set, never their values. `GET /api/export` downloads your own data as JSON (everything except chat transcripts and uploads).
