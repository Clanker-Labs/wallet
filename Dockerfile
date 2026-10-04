# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    WALLET_DB_PATH=/data/wallet.db \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Web app (standalone build) …
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# … plus what the worker and the MCP server need (they run from source via tsx).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/tsconfig.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/bin ./bin
COPY --from=build /app/drizzle ./drizzle

# Runs as the image's unprivileged `node` user (uid 1000), not root.
#
# Two reasons, and the second is the one that bites. Obviously an app holding
# every account you own should not be root in its own container. Less
# obviously: when /data is a bind mount, whoever the container runs as owns the
# files that appear in your directory. As root that is a database, a -wal and a
# -shm you cannot write — and opening a WAL database read-only still needs to
# write the -shm, so a backup running as you fails on its own data. The
# directory is created here so the ownership is right even on first start.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
