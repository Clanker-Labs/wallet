---
title: Configuration
description: Every environment variable wallet reads, generated from .env.example at build time, plus the few the code reads that aren't listed there.
section: reference
order: 4
generate: configuration
---

Copy `.env.example` to `.env` and uncomment what you need. Every process loads the same files: Next.js (`npm run dev` / `start`), the worker (`npm run worker`) and the stdio MCP launcher (`bin/wallet-mcp.mjs`) read `.env.local` first, then `.env`, and real environment variables win over both. In Docker, `docker-compose.yml` passes `.env` to both containers and pins `WALLET_DB_PATH=/data/wallet.db`. Compose itself also reads `WALLET_PORT` (host port, default 3000) and `WALLET_DATA` (host directory for the database instead of the named volume); see [Deployment](deployment.html#docker-compose).

Restart the processes after a change: nothing is reloaded at runtime. Per-user preferences (base currency, locale, time zone) live in the database and are edited in **Settings**; the `WALLET_CURRENCY`, `WALLET_LOCALE` and `WALLET_TIMEZONE` variables are only the defaults for users who haven't picked one.
