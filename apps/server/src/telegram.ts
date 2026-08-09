import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: string;
  name: string;
}

/**
 * Проверка initData из Telegram Mini App:
 * hash = HMAC_SHA256(data_check_string, HMAC_SHA256(bot_token, "WebAppData")).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 3600,
  now = Date.now(),
): TelegramUser | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  // Сравнение без утечки времени — то же правило, что и для секрета вебхука.
  const given = Buffer.from(hash);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSeconds) return null;

  const rawUser = params.get('user');
  if (!rawUser) return null;
  try {
    const user = JSON.parse(rawUser) as { id?: number; first_name?: string; username?: string };
    if (typeof user.id !== 'number') return null;
    return {
      id: String(user.id),
      name: user.username || user.first_name || `tg${user.id}`,
    };
  } catch {
    return null;
  }
}
