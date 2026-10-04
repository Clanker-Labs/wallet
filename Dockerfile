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
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
