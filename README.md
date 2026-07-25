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
├── api/             # Fastify REST API
├── notify/          # Telegram (grammY), email, etc.
├── config/          # Zod-validated config loader
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

## Language

**TypeScript** — fable recommendation. Playwright is TypeScript-first, all platform adapters involve browser automation + JSON wrangling, and types can be shared with a future web dashboard.

## Plan

See [.hermes/plans/](.hermes/plans/) for the full 6-phase implementation plan.
