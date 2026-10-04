---
title: Reminders & Telegram
description: Scheduled reminders that keep nagging until your numbers are up to date, balance updates in one message each, and the assistant in your pocket.
blurb: Reminders that nag until done; update balances in a chat.
section: features
order: 9
video: telegram
---

A net worth tracker is only as good as its last update. wallet's answer is a Telegram bot that asks for the numbers on a schedule, takes them as plain replies, and keeps asking until you're done.

## Setting it up

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`), put its token in `.env` as `TELEGRAM_BOT_TOKEN`, and start the worker: `npm run worker`, or `docker compose --profile telegram up -d` in Docker.
2. In the web app, open **Settings → Telegram → Generate link code** and send `/start CODE` to your bot, or tap the one-tap *Open in Telegram* link. The code is valid 30 minutes.
3. Check it works: `npm run worker -- --test` sends a test message to every linked chat.

Each person links their own chat and only ever sees their own wallet. Details in [Telegram bot internals](telegram-bot.html).

## Reminders

Create them in **Reminders** (or ask the assistant, `create_reminder`). Presets fill the form in two clicks:

| Preset | Schedule | Nag |
|---|---|---|
| Update account balances | Monthly, 1st, 09:00 | every 24 h |
| Import bank statement | Monthly, 3rd, 19:00 | every 24 h |
| Monthly report | Monthly, 1st, 08:30 | no |
| File the tax return | Yearly, May 15, 09:00 | no |

A reminder has a **frequency** (once, weekly, monthly, quarterly, yearly), a day and time in **your time zone**, an optional message, and a **kind** that decides what the message contains:

- **Balance update**: for one account, its last balance and "reply with the new balance". Without an account, the list of stale accounts and an **Update balances now** button that starts the walkthrough below.
- **Bank statement**: asks you to send the CSV or PDF right in the chat, or to drop it in the web assistant.
- **Monthly report**: last month's income, expenses and savings rate, the top budget overruns, and your net worth with its 1-month change.
- **Custom**: just your title and message.

Each message carries **✅ Done**, **⏰ Snooze 3h** and **💤 Tomorrow** buttons. With **re-send every N hours** set, an unacknowledged reminder comes back ("🔁 Still pending") until you tap ✅, reply "done", or answer it. Snoozing pushes the next nag; a one-off reminder switches itself off once done. Pending reminders also show on the dashboard.

## Updating balances from a chat

- **Reply to a balance reminder** with a number (`12 500`, `12,500.50`, `12.5k`): it's recorded for that account and the reminder is marked done.
- **`/update`** walks through every manually-tracked account, stalest first, one question per message. Answer with the new balance, `skip` or `stop`; you get a summary with your new net worth and the change. Accounts valued from holdings or a loan schedule are skipped: they update themselves.
- **`/balance livret a 12 500`** updates one account by name.

## Commands

| Command | Does |
|---|---|
| `/networth` | Net worth snapshot (`/nw` works too) |
| `/budget [YYYY-MM]` | Budget progress for this or another month |
| `/update` | Update all balances, one by one |
| `/balance <account> <amount>` | Update a balance |
| `/spent <amount> <category> [— note]` | Log an expense, e.g. `/spent 12.50 groceries — lunch` |
| `/earned <amount> <category> [— note]` | Log income, e.g. `/earned 2500 salary` |
| `/reminders` | Upcoming and pending reminders |
| `/ask <question>` | Ask the assistant |
| `/new` | Start a fresh assistant conversation |
| `/help` | What the bot can do |

Anything that isn't a command goes to the [assistant](assistant.html), with the conversation kept per chat. **Send a file** (CSV, OFX, PDF, a photo or screenshot) and the assistant imports it; a caption becomes your instructions.
