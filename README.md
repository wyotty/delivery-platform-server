# delivery-platform-server

Unified delivery platform data aggregator — fetch, normalize, store, and report orders from Grab, Foodpanda, ShopeeFood, and more.

## Architecture

```
src/
├── core/            # Types, PlatformConnector interface, connector registry
├── platforms/       # Platform adapters (grab/, foodpanda/, ...)
│   └── grab/        # Playwright auth + API client + normalizer
├── db/              # Drizzle schema, repo layer
├── scheduler/       # node-cron schedules
├── api/             # Fastify REST API
├── notify/          # Telegram (grammY), email, etc.
├── config/          # Zod-validated config loader
└── cli.ts           # CLI entry point
```

## Quick Start

```bash
pnpm install
cp .env.example .env   # fill credentials
pnpm fetch grab 2026-07-14
```

## Language

**TypeScript** — fable recommendation. Playwright is TypeScript-first, all platform adapters involve browser automation + JSON wrangling, and types can be shared with a future web dashboard.

## Plan

See [.hermes/plans/](.hermes/plans/) for the full 6-phase implementation plan.
