---
title: Getting started
description: Install wallet, explore it with demo data, create your account with a passkey, and run it with Docker.
section: overview
order: 1
---

## Requirements

- **Node.js 22 or newer** (`engines.node` is `>=22`). `better-sqlite3` ships prebuilt binaries for common platforms; elsewhere `npm install` compiles it, which needs Python, `make` and a C++ compiler.
- A browser with **passkeys**: Safari, Chrome, Edge or Firefox, with Touch ID, Face ID, Windows Hello, a password manager or a phone.
- Optional: an Anthropic API key (or a logged-in `claude` / `codex` CLI) for the assistant, and a Telegram bot token for reminders.

## Install and run

```bash
git clone https://github.com/Clanker-Labs/wallet.git
cd wallet
npm install
npm run dev            # http://localhost:3000
```

The database is created and migrated on first use at `./data/wallet.db` (set `WALLET_DB_PATH` to move it). Open <http://localhost:3000>: with no users yet you land on **Set up your wallet**.

## Try it with demo data

The fastest way to see every feature is the demo profile, "Alex": two years of history, USD and EUR accounts, a US brokerage and 401(k), a French PEA, crypto, gold coins, a flat with a mortgage, budgets, reminders and saved simulations. It also stores synthetic exchange rates and prices, so it works offline.

```bash
npm run db:seed-demo   # adds the demo data to the owner (creates "Alex" if there is no user yet)
npm run auth:link      # prints a one-time sign-in link, valid 15 minutes
```

Open the printed link (`http://localhost:3000/api/auth/magic?code=…`). It signs you in and takes you to **Settings → Security**, where you add a passkey so you can sign in normally next time.

`db:seed-demo` refuses to touch an owner who already has accounts; pass `-- --force` to add the demo data anyway. `npm run auth:link -- --list` lists users and `-- --user <id>` mints a link for someone else.

## Create your own account

On a fresh database, `/signup` asks for your name and creates a passkey:

- **Create my passkey** uses this device: Touch ID, Face ID, Windows Hello or your password manager.
- **Save it on my iPhone (QR code)** shows a QR code on the computer. Scan it with the iPhone camera, confirm with Face ID, and the passkey is stored in iCloud Keychain. Next time, sign in the same way: one tap, or one scan.

The first account is the **owner**. Afterwards sign-ups are closed unless `WALLET_ALLOW_SIGNUP=1` (see [Sign-up](signup.html)). Add more passkeys (a laptop, a security key) in **Settings → Security**.

> [!IMPORTANT]
> Passkeys only work on **https** or on **http://localhost**, not on a raw IP such as `http://192.168.1.10:3000`. To use wallet from your phone on the LAN, put it behind HTTPS (see [Deployment](deployment.html)). Lost every passkey? `npm run auth:link` on the server prints a recovery link.

Then, in order:

1. **Settings → Preferences**: pick your base currency (USD by default), locale and time zone.
2. **Accounts**: add each bank account, savings account, brokerage, property and loan in its own currency ([Accounts](accounts.html)).
3. **Investments**: add positions by symbol; prices are fetched for you ([Investments](investments.html)).
4. **Transactions**: import a CSV export, or drop a statement on the assistant ([Transactions](transactions.html)).
5. **Budgets** and **Reminders** when you're ready.

## Configure the assistant and Telegram

```bash
cp .env.example .env
```

- **Assistant:** set `ANTHROPIC_API_KEY` (or run `ant auth login`), or use a local CLI login with `WALLET_AGENT_PROVIDER=claude-code` or `codex`. See [Assistant](assistant.html).
- **Telegram:** create a bot with [@BotFather](https://t.me/BotFather), set `TELEGRAM_BOT_TOKEN`, run `npm run worker`, then link your chat in **Settings → Telegram**. See [Reminders & Telegram](telegram.html).

Every variable is listed in [Configuration](configuration.html).

## Run it for real

**With Docker:**

```bash
cp .env.example .env                       # set WALLET_PUBLIC_URL, and WALLET_API_TOKEN if the port is reachable from a network
docker compose up -d                       # web on 127.0.0.1:3000 (loopback only)
docker compose --profile telegram up -d    # add the Telegram / prices / FX worker
```

`WALLET_PORT` changes the host port and `WALLET_DATA` binds the database to a host directory; see [Deployment](deployment.html#docker-compose).

**Without Docker:**

```bash
npm run build && npm start   # the web app
npm run worker               # Telegram bot, reminders, hourly FX rates and prices
```

Keep both running (systemd, pm2, launchd…). Without the worker, reminders don't go out, exchange rates only update when you click refresh in **Settings → Exchange rates**, prices only when you open **Investments**, and investment accounts get no daily value snapshot. Put it behind HTTPS before using it from other devices; [Deployment](deployment.html) covers reverse proxies, `WALLET_PUBLIC_URL` and backups.
