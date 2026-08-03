import { Bot } from 'grammy';
import type { Logger } from 'pino';
import { Config } from '../config/index.js';

export interface Notifier {
  /** Best-effort alert. Never throws — a broken notifier must not fail a fetch. */
  alert(message: string): Promise<void>;
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

export function createNotifier(config: Config, logger: Logger): Notifier {
  if (!config.telegramBotToken || !config.telegramChatId) {
    logger.warn(
      'Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — auth failures will only be logged',
    );
    return new NoopNotifier();
  }
  return new TelegramNotifier(config.telegramBotToken, config.telegramChatId, logger);
}
