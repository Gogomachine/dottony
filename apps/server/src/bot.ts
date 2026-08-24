import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Клиент Bot API.
 *
 * Библиотеку не берём: нам нужны три метода, а любая из них тянет
 * маршрутизатор команд и сессии, которых у нас нет — команды приходят
 * в игру, а не в чат.
 *
 * Сеть ненадёжна, и ни одно уведомление не стоит упавшего запроса:
 * методы возвращают false вместо исключения, а причину отдают наружу.
 */

const API = 'https://api.telegram.org';

/** Кнопка под сообщением, ведущая в мини-приложение. */
export interface BotButton {
  text: string;
  url: string;
}

export interface BotUpdate {
  message?: {
    chat?: { id?: number };
    from?: { id?: number; username?: string; first_name?: string };
    text?: string;
  };
}

export class Bot {
  /** Секрет вебхука: Telegram присылает его обратно заголовком. */
  readonly secret: string;
  private username: string | null = null;
  /** Короткое имя мини-приложения из BotFather, если оно задано. */
  private readonly appName: string | undefined;

  constructor(
    private readonly token: string,
    secretSeed: string,
    options: { appName?: string; onError?: (error: unknown) => void } = {},
  ) {
    // Отдельная переменная под секрет вебхука была бы ещё одной ручкой,
    // которую легко забыть выставить; выводим его из уже имеющегося.
    this.secret = createHash('sha256')
      .update(`${secretSeed}:telegram-webhook`)
      .digest('hex')
      .slice(0, 32);
    this.appName = options.appName;
    this.onError = options.onError;
  }

  private readonly onError: ((error: unknown) => void) | undefined;

  /** Сравнение секрета вебхука без утечки времени. */
  matchesSecret(candidate: string | undefined): boolean {
    if (candidate === undefined) return false;
    const expected = Buffer.from(this.secret);
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private async call<T>(method: string, payload: object): Promise<T | null> {
    try {
      const response = await fetch(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json()) as { ok: boolean; result?: T; description?: string };
      if (!body.ok) {
        // Заблокировавший бота пользователь — обычное дело, а не поломка,
        // но знать причину всё равно нужно.
        this.onError?.(new Error(`telegram ${method}: ${body.description ?? 'failed'}`));
        return null;
      }
      return body.result ?? null;
    } catch (error) {
      this.onError?.(error);
      return null;
    }
  }

  /**
   * Имя бота — из него строятся все ссылки вида t.me/…
   *
   * Спрашиваем один раз и держим ответ: имя не меняется. Пока ответ в пути,
   * все, кто пришёл следом, ждут тот же запрос, а не шлют свой, — иначе
   * первый же наплыв после пробуждения сервера превратился бы в десяток
   * одинаковых обращений к Telegram.
   *
   * Неудачу не запоминаем: имя останется null, и следующий спрашивающий
   * попробует снова. Раньше одна осечка при старте гасила ссылки в Telegram
   * до самого перезапуска сервера.
   */
  async resolveUsername(): Promise<string | null> {
    if (this.username) return this.username;
    this.asking ??= this.call<{ username?: string }>('getMe', {})
      .then((me) => {
        this.username = me?.username ?? null;
        return this.username;
      })
      .finally(() => {
        this.asking = null;
      });
    return this.asking;
  }

  /** Запрос имени, который сейчас в пути; null — никто не спрашивает. */
  private asking: Promise<string | null> | null = null;

  get knownUsername(): string | null {
    return this.username;
  }

  /**
   * Ссылка, открывающая игру внутри Telegram с параметром.
   * Без короткого имени приложения работает главное мини-приложение бота.
   */
  miniAppLink(param: string): string | null {
    if (!this.username) return null;
    const path = this.appName ? `${this.username}/${this.appName}` : this.username;
    return `https://t.me/${path}?startapp=${encodeURIComponent(param)}`;
  }

  /** Ссылка в чат с ботом: по ней приходит /start с полезной нагрузкой. */
  startLink(payload: string): string | null {
    if (!this.username) return null;
    return `https://t.me/${this.username}?start=${encodeURIComponent(payload)}`;
  }

  async sendMessage(chatId: string, text: string, button?: BotButton): Promise<boolean> {
    const result = await this.call('sendMessage', {
      chat_id: chatId,
      text,
      ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}),
    });
    return result !== null;
  }

  async setWebhook(url: string): Promise<boolean> {
    const result = await this.call('setWebhook', {
      url,
      secret_token: this.secret,
      // Ничего, кроме сообщений, нам не нужно — меньше лишнего трафика.
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
    return result !== null;
  }
}

/** Одноразовый код привязки: короткий, но неугадываемый. */
export function makeLinkToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Разбирает `/start <payload>`. Возвращает полезную нагрузку или пустую
 * строку, если её не было; null — если это вообще не команда старта.
 */
export function parseStart(text: string | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed !== '/start' && !trimmed.startsWith('/start ')) return null;
  return trimmed.slice('/start'.length).trim();
}
