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
├── scheduler/       # node-cron fetch every 3 min (trailing window + retry)
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

# or run the long-running server: REST API + dashboard + scheduler (every 3 min)
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
| `POST /fetch` | Manual backfill: `{accountId, from, to, force?}` |

### What a fetch actually re-fetches

Order-level data (status, totals, revenue) is **always** re-read for every order in
the range: that is one daily-report request per day, and it is what keeps the
dashboard's numbers live.

Line items are a separate request **per order** at ~1 req/sec, and on a settled order
they return the same bytes every time. So they are fetched only when they need to be:
the order is new, the platform's `updatedAt` has moved since we last stored it, or the
lines we hold are missing/stale/doubtful. Anything else is left untouched — no request,
and not a row changed, including `items_fetched_at`, which goes on meaning "when these
lines were last confirmed against the platform".

Each run re-reads a trailing window of days (`FETCH_TRAILING_DAYS`, default 2), and
that width is not decoration: Grab keeps correcting an order after its business day
closes and serves the correction under the ORIGINAL day's report. Over 315 captured
statements, 11 orders were updated on a later ICT day and 2 a full two days later —
one of them a cancellation that takes earnings to 0. A window of 1 never re-reads the
day those land on, and the pre-correction figure stays in the database forever.

That makes re-running a range nearly free, and a scheduled fetch cheap enough to run
every 3 minutes (`FETCH_CRON='*/3 * * * *'`, 480 runs a day). When the stored lines are
*wrong* rather than merely old — after a parser
fix, say — pass `--force` (CLI) or `"force": true` (`POST /fetch`) to re-fetch every
order regardless:

```bash
pnpm cli backfill grab grab-dong-day 2026-06-01 2026-06-30 --force
```

### What 480 runs a day must not turn into

Every failure this server can see is a *condition*, not an event: the same broken
order, the same dead session, is rediscovered on every single tick. Three bounds keep
a persistent problem from becoming a storm, and all three recover on their own — none
of them needs a human to clear anything.

| Bound | Where | What it stops |
| --- | --- | --- |
| Login gate — at most 4 login attempts an account-hour, plus 5/15/60-minute backoff on consecutive failures | `core/login-gate.ts` | Broken cookies cost 1 headless Chromium login per tick (480/day), and a login failing with a plain Playwright error cost 3 per tick (1,440/day). Now ~26/day, and the account recovers by itself when the platform does. |
| Rowless retry clock — 15 minutes, keyed by account + order id, in process | `core/detail-refresh.ts` (`NoRowRetryLog`) | An order the writer refuses gets no row, so the DB clock that governs every other retry cannot exist for it: its detail was fetched on 480 of 480 ticks with 0 rows ever written. |
| Alert throttle — one message per condition per 6 hours, with the repeat count on the next one | `notify/index.ts` (`ThrottledNotifier`) | One unstorable order sent 480 identical Telegram messages a day. A *new* condition still alerts immediately; it is the identical one that waits. |

The detail phase also has a hard deadline (`itemDetail.deadlineMs`, 120 s) for the
whole run rather than for each day of it, so one account cannot hold the scheduler's
overlap guard past its own tick. A run that does hit it marks the orders it could not
reach and drains them over the following ticks.

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
