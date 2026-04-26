# syntax=docker/dockerfile:1.7
# Universal Dockerfile for the Telegram bot.
# Works on Render, Railway, Fly.io, Koyeb, Northflank, DigitalOcean App
# Platform, Google Cloud Run, AWS App Runner, Heroku (with heroku.yml),
# and any plain VPS that has Docker.

############################
# Base
############################
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable \
 && corepack prepare pnpm@10.26.1 --activate \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

############################
# Install + build
############################
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build

############################
# Runtime (slimmed)
############################
FROM base AS runtime
ENV NODE_ENV=production

# Copy workspace metadata + the built api-server
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/.npmrc ./
COPY --from=build /app/tsconfig.base.json /app/tsconfig.json ./
COPY --from=build /app/lib ./lib
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/artifacts/api-server/package.json ./artifacts/api-server/package.json
COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=build /app/artifacts/api-server/assets ./artifacts/api-server/assets
COPY --from=build /app/artifacts/mockup-sandbox/package.json ./artifacts/mockup-sandbox/package.json

# Install only production dependencies for the bot service
RUN pnpm install --prod --frozen-lockfile --filter @workspace/api-server... \
 && pnpm store prune

# Persistent SQLite data lives here. Mount a volume on this path on whatever
# host you deploy to (Fly volume, Render disk, Railway volume, etc.).
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=8080
EXPOSE 8080

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
