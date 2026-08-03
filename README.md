# delivery-platform-server

Unified delivery platform data aggregator — fetch, normalize, store, and report orders from Grab, Foodpanda, ShopeeFood, and more.

## Architecture

```
src/
├── core/            # Types, PlatformConnector interface, connector registry
├── platforms/       # Platform adapters (grab/, foodpanda/, ...)
│   └── grab/        # Playwright auth + API client + normalizer
├── mappers/         # UnifiedOrder → @posx/core Invoice (docs/xpos-invoice-mapping.md)
├── db/              # Drizzle schema, repo layer
├── scheduler/       # node-cron nightly fetch (trailing window + retry)
├── api/             # Fastify REST API + dashboard route
├── notify/          # Telegram (grammY) alerting
├── config/          # Zod-validated config loader
├── dashboard.html   # Single-file dashboard served at /
├── index.ts         # Server entry point (API + scheduler)
└── cli.ts           # CLI entry point (one-off fetches, session import)
```

## Quick Start

```bash
pnpm install
cp .env.example .env      # fill credentials
pnpm run db:migrate
npx tsx scripts/seed-merchants.ts

# one-off fetch (note: `pnpm run fetch`, not `pnpm fetch` — pnpm has its own
# built-in `fetch` command that would shadow the script and do nothing)
pnpm run fetch grab grab-dong-day 2026-07-26

# or run the long-running server: REST API + dashboard + nightly scheduler
pnpm start
```

If a fetch fails with `needs_human` (login broken — CAPTCHA/OTP/bad password), the scheduler
skips that account until you import a session captured from browser devtools:

```bash
pnpm cli import-session grab-dong-day session.json
```

## Run as a service (macOS)

Optional: a LaunchAgent keeps the server (scheduler + dashboard) running across
crashes and reboots, logging to `~/Library/Logs/delivery-platform.log`. The node
path inside the plist is nvm-versioned; update it after a node upgrade.

```bash
cp scripts/com.dongday.delivery-platform.plist ~/Library/LaunchAgents/                        # install
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dongday.delivery-platform.plist   # start
launchctl kickstart -k gui/$(id -u)/com.dongday.delivery-platform                             # restart (e.g. after git pull)
launchctl bootout gui/$(id -u)/com.dongday.delivery-platform                                  # stop
rm ~/Library/LaunchAgents/com.dongday.delivery-platform.plist                                 # remove auto-start
```

### Docker

```bash
docker build -t delivery-platform-server .
docker run -d --restart=unless-stopped --name delivery-platform-server \
  --env-file .env -p 3000:3000 -v "$PWD/data:/app/data" delivery-platform-server

# one-off CLI run against the same image
docker run --rm --env-file .env -v "$PWD/data:/app/data" \
  delivery-platform-server fetch grab grab-dong-day 2026-07-26
```

## API

| Route | Purpose |
|-------|---------|
| `GET /` | Dashboard: KPI tiles + orders table (light/dark) |
| `GET /health` | Liveness probe |
| `GET /accounts` | Configured accounts + current session state |
| `GET /summary?from=&to=&merchantId=` | Per-day and per-platform totals (revenue = completed only) |
| `GET /orders?from=&to=&platform=&limit=` | Order rows |
| `GET /orders/:id` | Full order incl. raw platform payload |
| `GET /runs` | Recent fetch runs |
| `POST /fetch` | Manual backfill: `{accountId, from, to}` |

### Which date do totals use?

`/summary` and `/orders` filter on **`report_date`** — the platform's own business
day — not on `ordered_at`. Grab assigns a statement's business day server-side,
and it matches neither `createdAt` nor `updatedAt`: an order placed 23:33:58 and
settled 00:00:38 the next day still lands in the earlier day's report. Only
`report_date` reconciles with the merchant portal. Use `ordered_at` when the
question is genuinely "when did customers order", not "what did the platform pay
out for that day".

## Language

**TypeScript** — fable recommendation. Playwright is TypeScript-first, all platform adapters involve browser automation + JSON wrangling, and types can be shared with a future web dashboard.

## Plan

See [.hermes/plans/](.hermes/plans/) for the full 6-phase implementation plan.
