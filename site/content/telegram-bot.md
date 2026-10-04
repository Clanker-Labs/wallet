---
title: Telegram bot internals
nav: Telegram internals
description: The worker loop, how chats are linked to users, command parsing, reminder delivery with nags and snoozes, file intake, and the scheduler's guarantees.
section: technical
order: 6
---

Code: [src/server/telegram](gh:src/server/telegram) and [src/bin/worker.ts](gh:src/bin/worker.ts). Product view: [Reminders & Telegram](telegram.html).

## The worker

`npm run worker` (the `worker` service in Docker, started with `--profile telegram`) is one long-running process:

| Loop | Every | Does |
|---|---|---|
| Updates | continuous | `getUpdates` long poll (25 s, only `message` and `callback_query`). Each update is handled **without awaiting** it, so a slow assistant answer never blocks buttons or other chats. Errors back off from 1 s to 60 s; a 409 means another worker is polling (or a webhook is set). |
| Scheduler | 30 s | `tick()`: due reminders, then due nags. Never two ticks at once. |
| Market data | 1 h | `ensureFreshRates()`, `refreshPrices()`, then `snapshotHoldingAccounts()` for every user ([valuation](valuation.html#why-accounts-are-snapshotted)). |

On start it opens and migrates the database, calls `getMe` and registers the command menu (`setMyCommands`). On SIGINT/SIGTERM it stops polling, gives in-flight handlers up to 5 s, and confirms the last update offset so nothing is replayed; a second Ctrl-C exits at once.

Flags: `--test` sends "✅ wallet bot connected" to every linked and `TELEGRAM_CHAT_ID` chat; `--once` runs a single scheduler tick and exits non-zero if a delivery failed, for running reminders from cron instead of a resident worker. `TELEGRAM_API_URL` points it at a self-hosted Bot API server.

The API client ([api.ts](gh:src/server/telegram/api.ts)) is a thin `fetch` wrapper: messages go out in HTML parse mode with link previews off, 429 responses are retried after `retry_after` (up to 3 times), and the bot token never appears in error messages. If Telegram rejects the HTML (400), the message is re-sent as plain text. Long answers are split under Telegram's 4096-character limit.

## Linking a chat

A chat acts for exactly one wallet user (`users.telegram_chat_id`, unique):

1. **Settings → Telegram → Generate link code** creates an 8-character code from an alphabet without look-alikes (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`), valid **30 minutes**, stored in `auth_challenges`. Generating a new one replaces the user's previous code.
2. The user sends `/start CODE` (or `/link CODE`), or follows `https://t.me/<bot>?start=CODE`. The code is normalized (case, spaces), checked, deleted (single use), and the chat is linked, unlinking it from anyone else first.
3. A chat that isn't linked gets nothing but instructions and its own chat id; its other messages are ignored.

`TELEGRAM_CHAT_ID` (comma-separated) is a legacy allowlist: those chats act as the **owner** unless they're linked to someone, and also receive the owner's reminders.

## Messages

[bot.ts](gh:src/server/telegram/bot.ts) `handleUpdate()` is the single entry point (and never throws: failures are logged and answered with "⚠️ …"). In order:

1. **A document or photo** → [file intake](#file-intake).
2. **A command** (`/name args`, with `@BotName` suffixes for other bots ignored in groups) → the handler. Any command ends a running `/update` walkthrough.
3. **A reply to a reminder**, matched through the reminder's `last_message_id` for this user: a number on a balance reminder records the balance and acknowledges it; "done", "ok", "fait", ✅ or 👍 acknowledges.
4. **An answer during `/update`**.
5. **Anything else** → the assistant.

### Parsing amounts and categories

- `/balance <account> <amount>` takes the amount from the **end** and joins space-separated thousand groups (`livret a 1 234,56` → account "livret a", 1234.56), always leaving at least one word for the name. A trailing currency word or symbol is ignored. The account is found by name; several matches ask you to be more specific.
- `/spent` and `/earned` take the amount from the **start** (`12.5k`, `1 234,56`, `€40`), then the **longest run of leading words that starts a category name** (`groceries lunch with Bob` → *Groceries*, note "lunch with Bob"; "the" won't match "Other expenses"). `—` or `--` separates an explicit note. The amount is stored negative for `/spent`, positive for `/earned`, in the user's base currency.

### The `/update` walkthrough

[walkthrough.ts](gh:src/server/telegram/walkthrough.ts) queues every account that's included in net worth and not valued from holdings or a loan schedule, **stalest first**, and asks for one balance per message: `3/7 · Livret A`, the last balance and its date. Answers: a number (recorded, with the change), `skip`/`next`/`s`/`-`, or `stop`/`cancel`/`done`. It ends with "N updated, M skipped" and the new net worth with its change since the start. State is in memory per chat and expires after an hour of silence. The **Update balances now** button on a general balance reminder starts it (`walk:start`).

### Buttons

Reminder messages carry inline buttons whose `callback_data` is `done:<id>`, `snooze:<id>:3` or `snooze:<id>:24`. The bot checks that the reminder belongs to the chat's user, applies it, answers with a toast ("⏰ Snoozed 3h", "💤 I'll remind you tomorrow") and removes the keyboard. Snoozes are limited to 1–168 hours.

## File intake

A document or photo (the largest size) is downloaded through `getFile` (Bot API limit: 20 MB), checked against the accepted types (CSV, TXT/OFX/QIF, PDF, images), and stored as an upload for the chat's user, also subject to the 15 MB upload limit. The bot answers "📥 Got *file* — reading it…" and runs an assistant turn with the upload attached; the caption, if any, is the message. See [attachments](agent.html#attachments).

## The assistant in a chat

Plain text and `/ask` go to `runAgent()` with `channel: "telegram"` (short plain-text answers). Each chat keeps one conversation id in memory, so follow-ups have context until `/new` or a worker restart. Turns in a chat run one at a time, and "typing…" is refreshed every 4.5 s while the assistant works. Markdown in the answer is converted to Telegram HTML. If the assistant isn't configured, the bot says why (and shows the help for plain text).

## Reminder delivery

All scheduling state lives in the `reminders` row, so ticks are idempotent and survive restarts:

| Column | Meaning |
|---|---|
| `next_run_at` | Next scheduled occurrence, computed in the **user's time zone** (`nextOccurrence()` in [schedule.ts](gh:src/lib/schedule.ts)); a day 31 becomes the month's last day; quarterly and yearly align to `month_of_year`. |
| `next_nag_at` | When to re-send an unacknowledged reminder; null when there's nothing pending. |
| `last_message_id` | The message replies are matched against. |
| `acknowledged_at` | When it was marked done. |

A **tick**:

1. For each enabled reminder with `next_run_at ≤ now`: render it (falling back to its bare title if building the body fails) and send it to the user's linked chat, plus the `TELEGRAM_CHAT_ID` chats for the owner. Then `last_sent_at` = now, `last_message_id` = the first chat's message, `next_nag_at` = now + `nag_every_hours` (if set), `next_run_at` = the following occurrence, and a one-off reminder without nagging is disabled.
2. For each enabled reminder with `next_nag_at ≤ now` (not just sent): send it again as "🔁 Still pending" and push `next_nag_at` forward.

If a user hasn't linked a chat, their reminder simply stays due and goes out once they link one. If every send fails, nothing is updated and the next tick retries. **Done** clears `next_nag_at` (and disables a one-off reminder); **Snooze** sets `next_nag_at` to now + 3 or 24 hours.
