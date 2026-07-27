import 'dotenv/config';
import { z } from 'zod';

// Empty-string env vars are the norm in .env templates ("KEY=") — treat them as
// absent so defaults apply instead of failing validation on a blank value.
const blankAsUndefined = (v: unknown) => (v === '' ? undefined : v);

const ConfigSchema = z.object({
  dbPath: z.preprocess(blankAsUndefined, z.string().default('data/delivery.db')),
  host: z.preprocess(blankAsUndefined, z.string().default('0.0.0.0')),
  port: z.preprocess(blankAsUndefined, z.coerce.number().int().positive().max(65535).default(3000)),
  /** node-cron expression for the daily fetch. Default: 02:30 every day. */
  fetchCron: z.preprocess(blankAsUndefined, z.string().default('30 2 * * *')),
  /** Timezone the cron expression is evaluated in. */
  cronTimezone: z.preprocess(blankAsUndefined, z.string().default('Asia/Ho_Chi_Minh')),
  /** Run the daily fetch once at startup — useful in sandbox, noisy in production. */
  fetchOnBoot: z.preprocess(blankAsUndefined, z.stringbool().default(false)),
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
