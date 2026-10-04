---
title: Deployment
description: Run wallet with Docker or as two Node processes, put it behind HTTPS with a reverse proxy, set WALLET_PUBLIC_URL and a token, and back up the one SQLite file.
section: technical
order: 7
---

wallet is two processes over one SQLite file: the **web app** (Next.js) and the **worker** (Telegram, reminders, hourly FX rates and prices). Run both, keep the file safe, and put HTTPS in front.

## Docker Compose

```bash
cp .env.example .env    # see the checklist below
docker compose up -d    # builds the image, starts web on :3000 and the worker
docker compose logs -f worker
```

[docker-compose.yml](gh:docker-compose.yml) defines two services from the same image, both reading `.env` and sharing the `wallet-data` volume at `/data` (`WALLET_DB_PATH=/data/wallet.db`):

| Service | Runs | Notes |
|---|---|---|
| `web` | `node server.js` (Next.js standalone output) on port 3000 | Healthcheck: `GET /api/health` every 30 s |
| `worker` | `tsx src/bin/worker.ts` | Needs `TELEGRAM_BOT_TOKEN`; without it the worker exits with setup instructions. Remove the service if you don't use Telegram (you then lose the hourly rate and price refresh too). |

The [Dockerfile](gh:Dockerfile) is multi-stage on `node:22-bookworm-slim`: dependencies are installed with build tools for `better-sqlite3`, the app is built in standalone mode, and the runtime image keeps the standalone server plus `node_modules`, `src`, `bin` and `drizzle`, because the worker and the stdio MCP server run from TypeScript sources through `tsx`.

**Updating:** `git pull && docker compose up -d --build`. Migrations run automatically when each process opens the database.

## Without Docker

```bash
npm ci
npm run build
npm start               # web on $PORT (3000)
npm run worker          # in a second process
```

Supervise both with systemd, pm2 or launchd. A minimal systemd unit for the worker:

```ini
[Unit]
Description=wallet worker
After=network-online.target

[Service]
WorkingDirectory=/opt/wallet
ExecStart=/usr/bin/npm run worker
Restart=always
User=wallet

[Install]
WantedBy=multi-user.target
```

Prefer cron over a resident worker? `npm run worker -- --once` delivers due reminders and exits; but then the bot doesn't answer messages.

## HTTPS and a reverse proxy

Passkeys only work in a secure context, so anything beyond `http://localhost` needs HTTPS. Any reverse proxy works; it must pass `Host` (or `X-Forwarded-Host`) and `X-Forwarded-Proto`, and must not buffer the assistant's event stream.

**Caddy** (automatic certificates):

```text
wallet.example.com {
  reverse_proxy localhost:3000
}
```

**nginx**:

```nginx
server {
  server_name wallet.example.com;
  listen 443 ssl;
  # ssl_certificate …; ssl_certificate_key …;
  client_max_body_size 20m;              # statement uploads: up to 15 MB each

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;                 # server-sent events from /api/agent
    proxy_read_timeout 300s;             # an assistant turn may take a few minutes
  }
}
```

Then set in `.env`:

| Variable | Why |
|---|---|
| `WALLET_PUBLIC_URL=https://wallet.example.com` | The passkey origin and RP id (instead of trusting forwarded headers), the link printed by `npm run auth:link`, links in Telegram messages, and `Secure` session cookies. |
| `WALLET_API_TOKEN=<openssl rand -hex 32>` | **Required once the port is reachable from a network.** Token-less access already refuses forwarded public hostnames, but a token is what protects `/api/*` and `/api/mcp` from anyone who can reach the port. |
| `WALLET_RP_ID` | Only if passkeys should be scoped to a parent domain (e.g. `example.com`). Decide before people register: passkeys are bound to it. |
| `WALLET_ALLOW_SIGNUP=1` | Only while family members create their accounts. |

Bind the app to localhost (`127.0.0.1:3000:3000` in Compose) when the proxy runs on the same host, so the plain-http port isn't exposed. Sub-path hosting (`example.com/wallet`) isn't supported; use a subdomain.

## Backups

Everything (accounts, transactions, uploaded statements, sessions, rates) is in **one SQLite file** (`./data/wallet.db`, or `/data/wallet.db` in Docker). It runs in WAL mode, so copying the file while the app writes can miss recent changes. Two safe ways:

```bash
# Online, consistent copy with SQLite's backup API (works while the app runs)
docker compose exec web node -e "require('better-sqlite3')('/data/wallet.db').backup('/data/backup.db').then(() => console.log('ok'))"
docker compose cp web:/data/backup.db ./wallet-$(date +%F).db

# Or offline: stop both processes, copy wallet.db (and wallet.db-wal / -shm if present), start again
```

Without Docker, the same one-liner works from the repo directory with `./data/wallet.db`, as does `sqlite3 data/wallet.db ".backup wallet-backup.db"`.

**Restore:** stop both processes, replace `wallet.db`, delete any `wallet.db-wal` and `wallet.db-shm` next to it, start again.

Each user can also download their own data as JSON from **Settings → Your data** (`GET /api/export`). It's handy for a spreadsheet but isn't a full backup: no uploads, chat history or passkeys.

## Checklist

- [ ] HTTPS in front, `WALLET_PUBLIC_URL` set to the public origin
- [ ] `WALLET_API_TOKEN` set if the port is reachable from anywhere but this machine
- [ ] Web and worker both running (or cron with `--once`)
- [ ] `ANTHROPIC_API_KEY` (or a CLI provider) for the assistant, `TELEGRAM_BOT_TOKEN` for reminders
- [ ] Scheduled backups of the database file, stored off the machine
