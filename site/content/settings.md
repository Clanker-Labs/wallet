---
title: Settings & passkeys
nav: Settings
description: Base currency, locale and time zone, exchange rates, passkeys, Telegram, categories and rules, integration status, members, and your data.
blurb: Currency, passkeys, Telegram, rules, integrations, export.
section: features
order: 10
video: settings
---

`/settings` is one page with a section per topic and a jump bar at the top. Everything here is per user, except what's marked owner-only.

## Preferences

- **Base currency**: what every total is converted to. Any code with a known rate; USD by default (`WALLET_CURRENCY` sets the default for new users).
- **Locale**: number and date formats (`en-US`, `fr-FR`, `de-CH`…).
- **Time zone**: decides what "today" is for balances and budgets, and when reminders fire.

## Exchange rates

The date of the latest rates, how many currencies they cover, the source, a **Refresh** button, and each currency you use with its rate against your base currency, both ways ("1 EUR = 1.0869 USD"). A currency without a rate is flagged as counted as 0. See [Currencies](currencies.html).

## Security

Your passkeys, with their device type, whether they're synced (iCloud Keychain, Google Password Manager…) and when they were last used. **Add a passkey** for this device, or **Add an iPhone (QR)** to scan from your phone. Passkeys can be renamed, and removed except the last one. See [Auth & security](security.html#passkeys).

## Telegram

**Generate link code** gives a one-time `/start CODE` (30 minutes) and, when the bot's username is known, a one-tap *Open in Telegram* link. Once linked, the section shows the chat and lets you unlink it. See [Reminders & Telegram](telegram.html).

## Categories and rules

Add, rename (with an emoji icon) or delete transaction categories, each of kind income, expense or transfer. Below, the **categorization rules** ("description contains … → category"; the longest match wins), with a button that applies all rules to uncategorized transactions now. See [Transactions](transactions.html#rules-categorize-once).

## Integrations

A read-only status board; secrets stay in `.env` and are never shown:

| Item | Shows |
|---|---|
| Assistant | The provider and model, and whether it's ready (or why not) |
| Agent tools | How many tools are enabled, and whether read-only mode is on |
| API & MCP access | "Bearer token required", or "No token needed on localhost" |
| Web sign-in | How many passkeys you have |

Under it, ready-to-copy snippets with this server's real paths and URL: Claude Code over stdio, Codex's `config.toml`, MCP over HTTP, the REST tools and the chat endpoint. For a member (not the owner), the stdio snippets include `WALLET_USER_ID` so a local MCP server acts as them. See [MCP & API](mcp.html).

## Members (owner only)

Everyone with an account on this server, with their role, join date, passkey count and whether Telegram is linked, and whether sign-ups are open (they are unless `WALLET_ALLOW_SIGNUP=0`). See [Sign-up](signup.html).

## Your data

**Export all data (JSON)** downloads your accounts, snapshots, holdings, transactions, categories, rules, budgets, reminders, simulations and settings (everything except assistant chat transcripts). The section also shows the database file's path and how many records you have. For a full backup, copy the SQLite file ([Deployment](deployment.html#backups)).
