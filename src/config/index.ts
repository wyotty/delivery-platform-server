import 'dotenv/config';
import { z } from 'zod';

// Empty-string env vars are the norm in .env templates ("KEY=") — treat them as
// absent so defaults apply instead of failing validation on a blank value.
const blankAsUndefined = (v: unknown) => (v === '' ? undefined : v);

const ConfigSchema = z.object({
  dbPath: z.preprocess(blankAsUndefined, z.string().default('data/delivery.db')),
  host: z.preprocess(blankAsUndefined, z.string().default('0.0.0.0')),
  port: z.preprocess(blankAsUndefined, z.coerce.number().int().positive().max(65535).default(3000)),
  /**
   * node-cron expression for the fetch. Default: every 3 minutes.
   *
   * Not nightly any more, and the whole pipeline is tuned to this number: the detail
   * phase's deadline (120 s) fits inside a tick, the scheduler's in-run retry (5 s)
   * assumes the next tick is three minutes away, and the login gate and alert throttle
   * are sized for 480 runs a day. Changing it means revisiting those.
   */
  fetchCron: z.preprocess(blankAsUndefined, z.string().default('*/3 * * * *')),
  /** Timezone the cron expression is evaluated in. */
  cronTimezone: z.preprocess(blankAsUndefined, z.string().default('Asia/Ho_Chi_Minh')),
  /** Run the daily fetch once at startup — useful in sandbox, noisy in production. */
  fetchOnBoot: z.preprocess(blankAsUndefined, z.stringbool().default(false)),
  /**
   * How many days back each run re-fetches. Late cancellations and refunds land on an
   * already-fetched day — measured up to 2 days later on live data — so a narrower
   * window silently keeps the pre-correction figure; upserts make the overlap
   * idempotent, and incremental line items make the extra day cost one report request.
   * See .env.example for the measurement.
   */
  fetchTrailingDays: z.preprocess(blankAsUndefined, z.coerce.number().int().min(0).max(30).default(2)),
  telegramBotToken: z.preprocess(blankAsUndefined, z.string().optional()),
  telegramChatId: z.preprocess(blankAsUndefined, z.string().optional()),
  logLevel: z.preprocess(blankAsUndefined, z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info')),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    dbPath: env.DB_PATH,
    host: env.HOST,
    port: env.PORT,
    fetchCron: env.FETCH_CRON,
    cronTimezone: env.CRON_TIMEZONE,
    fetchOnBoot: env.FETCH_ON_BOOT,
    fetchTrailingDays: env.FETCH_TRAILING_DAYS,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    logLevel: env.LOG_LEVEL,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
