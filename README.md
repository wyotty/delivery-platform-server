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
├── notify/          # Telegram (grammY), email, etc.
├── api.ts           # Fastify REST API
├── fetch-job.ts     # Shared fetch flow (CLI + scheduler)
├── scheduler.ts     # node-cron daily fetches
├── index.ts         # Server entry (scheduler daemon)
└── cli.ts           # CLI entry point
```

## Quick Start

```bash
pnpm install
cp .env.example .env   # fill credentials
pnpm db:migrate && npx tsx scripts/seed-merchants.ts
pnpm fetch grab grab-dong-day 2026-07-14   # one-off fetch
pnpm start                                 # scheduler daemon (SCHEDULE_CRON, default 06:30 daily)
```

If a fetch fails with `needs_human` (login broken — CAPTCHA/OTP/bad password), the scheduler
skips that account until you import a session captured from browser devtools:

```bash
pnpm cli import-session grab-dong-day session.json
```

## API

`pnpm start` serves a REST API on `PORT` (default 3000). Date params are business
dates — calendar days in each merchant's timezone.

```
GET /                                             # dashboard (KPI tiles + orders table, light/dark)
GET /health
GET /summary?from=2026-07-01&to=2026-07-14        # cross-platform totals (revenue = completed only)
GET /orders?from=&to=&platform=&status=&limit=    # newest first; range optional
GET /fetch-runs?limit=20                          # did last night's fetch work?
```

## Run as a service (macOS)

A LaunchAgent keeps the server (scheduler + dashboard) running across crashes and
reboots — plist at `~/Library/LaunchAgents/com.dongday.delivery-platform.plist`,
logs at `~/Library/Logs/delivery-platform.log`. The node path inside it is
nvm-versioned; update it after a node upgrade.

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dongday.delivery-platform.plist   # start
launchctl kickstart -k gui/$(id -u)/com.dongday.delivery-platform                             # restart (e.g. after git pull)
launchctl bootout gui/$(id -u)/com.dongday.delivery-platform                                  # stop/uninstall
```

## Language

**TypeScript** — fable recommendation. Playwright is TypeScript-first, all platform adapters involve browser automation + JSON wrangling, and types can be shared with a future web dashboard.

## Plan

See [.hermes/plans/](.hermes/plans/) for the full 6-phase implementation plan.
