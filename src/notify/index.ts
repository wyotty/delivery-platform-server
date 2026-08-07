import { Bot } from 'grammy';
import type { Logger } from 'pino';
import { Config } from '../config/index.js';

export interface Notifier {
  /**
   * Best-effort alert. Never throws — a broken notifier must not fail a fetch.
   *
   * `key` names the CONDITION, not this occurrence of it: two alerts with the same
   * key are the same problem said twice, and only the first gets through the throttle
   * (see ThrottledNotifier). Build it from what would make an operator want to look
   * again — the account, and the identity of what failed — and never from anything
   * that changes on its own, like the date range or a timestamp. Defaults to the whole
   * message, which is the safe reading of "the caller did not say".
   */
  alert(message: string, key?: string): Promise<void>;
  readonly enabled: boolean;
}

class NoopNotifier implements Notifier {
  readonly enabled = false;
  async alert(): Promise<void> {}
}

class TelegramNotifier implements Notifier {
  readonly enabled = true;
  private bot: Bot;

  constructor(token: string, private chatId: string, private logger: Logger) {
    this.bot = new Bot(token);
  }

  async alert(message: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(this.chatId, message);
    } catch (err) {
      // Swallow: alerting is best-effort. Losing an alert is bad, but failing the
      // fetch because Telegram is unreachable is worse.
      this.logger.error({ err }, 'Telegram alert failed');
    }
  }
}

/** Default gap before the same condition is allowed to speak again. */
export const ALERT_REPEAT_AFTER_MS = 6 * 3_600_000;

/**
 * One message per CONDITION per window, not per run.
 *
 * Every alert this server raises describes a state, not an event: an order the writer
 * cannot store, line items it refuses to overwrite, a session it cannot renew. The
 * fetch that discovers them runs 480 times a day, and each of those conditions is
 * discovered again on every single one — so one unstorable order sent 480 Telegram
 * messages a day, measured, all of them the same sentence. An alert that arrives 480
 * times is not an alert; it is what makes the next real one invisible.
 *
 * The rules, in the order they matter:
 *   - A REPEAT of a condition already reported inside the window is dropped, counted,
 *     and logged at debug. Nothing is lost quietly: fetch_runs still records every run
 *     and its error_message.
 *   - A NEW condition — a different order, a different failure, a different auth state
 *     — has a different key and goes out immediately. Throttling must never delay the
 *     first sighting of something.
 *   - When the window expires and the condition is STILL there, the next message
 *     carries how many times it repeated while muted. That is the heartbeat: a problem
 *     that outlives its own alert is reported roughly four times a day, with evidence
 *     that it never stopped, rather than being forgotten after the first message.
 *
 * Memory is bounded by pruning entries whose window has expired: an expired entry
 * would be allowed through anyway, so dropping it changes nothing.
 */
export class ThrottledNotifier implements Notifier {
  private readonly sent = new Map<string, { at: number; suppressed: number }>();

  constructor(
    private readonly inner: Notifier,
    private readonly logger?: Logger,
    private readonly repeatAfterMs: number = ALERT_REPEAT_AFTER_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean { return this.inner.enabled; }

  async alert(message: string, key: string = message): Promise<void> {
    const now = this.now();
    // Two windows, not one: an entry that has merely expired is the one whose repeat
    // count the next message is about to report. Anything twice that old belongs to a
    // condition that stopped happening, and nothing is waiting to be said about it.
    for (const [k, seen] of this.sent) {
      if (now - seen.at >= 2 * this.repeatAfterMs) this.sent.delete(k);
    }

    const seen = this.sent.get(key);
    if (seen && now - seen.at < this.repeatAfterMs) {
      seen.suppressed++;
      this.logger?.debug({ key, suppressed: seen.suppressed }, 'Alert suppressed — same condition already reported');
      return;
    }

    const repeats = seen?.suppressed ?? 0;
    this.sent.set(key, { at: now, suppressed: 0 });
    await this.inner.alert(
      repeats > 0
        ? `${message}\n\n(still failing: ${repeats} more occurrence(s) since the last alert)`
        : message,
    );
  }
}

export function createNotifier(config: Config, logger: Logger): Notifier {
  if (!config.telegramBotToken || !config.telegramChatId) {
    logger.warn(
      'Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — auth failures will only be logged',
    );
    return new NoopNotifier();
  }
  // Wrapped here rather than inside TelegramNotifier so the throttle is a property of
  // the server's alerting policy, not of one transport.
  return new ThrottledNotifier(new TelegramNotifier(config.telegramBotToken, config.telegramChatId, logger), logger);
}
