# Telegram Loan-Offers Bot

## Overview

Telegraf-based Telegram bot for sharing loan-offer links, ported from
https://github.com/A7A7EA7/As701.git into the Replit pnpm workspace. Fully
managed from inside Telegram — no web dashboard required.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Bot framework**: Telegraf (long polling)
- **Database**: SQLite (better-sqlite3) + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **Build**: esbuild (ESM bundle)

## Layout

- `artifacts/api-server` — Express server + Telegraf bot + welcome asset.
  - `src/bot.ts` — entire bot logic (commands, admin menu, broadcasts, moderation).
  - `src/routes/health.ts` — `/api/healthz`.
  - `assets/welcome.png` — image sent on `/start`.

  Inline keyboard buttons link directly to each offer's URL — no Replit-side
  click tracking or redirect proxy.
- `lib/db` — Drizzle ORM schema + better-sqlite3 client. DB file lives at
  `./data/bot.db` at the repo root.

## Required environment

- `TELEGRAM_BOT_TOKEN` — bot token from @BotFather.
- `DATABASE_URL` — optional. Defaults to `./data/bot.db`. On hosts with a
  mounted volume, point this at the volume path (e.g. `/app/data/bot.db`).
- `PORT` — provided by the host.

### Webhook mode (optional)

Default transport is long polling. To run in webhook mode (for
serverless / scale-to-zero hosts), set:

- `WEBHOOK_URL` — public HTTPS base URL of the deployed service.
- `WEBHOOK_PATH` — optional. Defaults to `/api/telegram/webhook`.
- `WEBHOOK_SECRET` — optional. Shared secret Telegram signs updates with.
- `BOT_MODE` — optional. Force `polling` or `webhook`. Auto-detected from
  `WEBHOOK_URL` when unset.

## Portable deployment

The repo ships with config for the major bot hosts. See `DEPLOY.md` for the
full step-by-step. Files included:

- `Dockerfile` + `.dockerignore` — universal container image (any Docker host).
- `render.yaml` — Render Blueprint (with persistent disk).
- `railway.json` — Railway (uses the Dockerfile).
- `fly.toml` — Fly.io (with persistent volume).
- `heroku.yml` + `app.json` — Heroku container deploy.
- `koyeb.yaml` — Koyeb manifest.
- `Procfile` — buildpack-style hosts.

## Bot owner

Admin commands and the in-Telegram admin menu are locked to a single Telegram
user ID hard-coded in `artifacts/api-server/src/bot.ts` as `OWNER_ID`
(currently `7900265965`). To make yourself the owner:

1. Message your bot in Telegram and send `/myid` — it replies with your ID.
2. Edit `OWNER_ID` in `artifacts/api-server/src/bot.ts`.
3. Restart the API server workflow.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/db run push` — apply DB schema changes
- `pnpm --filter @workspace/api-server run dev` — run API server + bot

See the `pnpm-workspace` skill for workspace structure details.
