import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  // Без секрета токены предсказуемы — в проде это дыра.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is required in production');
  }
  console.warn('JWT_SECRET not set — using dev default');
}

/**
 * Без DATABASE_URL база живёт в файле рядом с приложением. На хостингах
 * без постоянного диска (например, Render free) такой файл исчезает при
 * перезапуске — для сохранности результатов задайте libsql://-адрес Turso.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'file:doton.db';
if (!databaseUrl.startsWith('libsql://') && process.env.NODE_ENV === 'production') {
  console.warn(`DATABASE_URL not set — using ${databaseUrl}, data may be lost on restart`);
}

const publicUrl = process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL;

/**
 * Сколько прокси стоит перед сервером. За балансировщиком хостинга без
 * этого числа все игроки выглядят одним адресом — и счётчики запросов
 * считают их вместе. У Render один прокси: TRUST_PROXY=1.
 */
const trustProxy = Number(process.env.TRUST_PROXY ?? 0);

/** Кому из браузеров разрешено ходить в API. Пусто — любому. */
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

// В проде логи — единственный способ увидеть, что пошло не так.
const app = await buildApp({
  logger: process.env.NODE_ENV === 'production',
  databaseUrl,
  jwtSecret: jwtSecret ?? 'dev-jwt-secret',
  ...(process.env.DATABASE_AUTH_TOKEN
    ? { databaseAuthToken: process.env.DATABASE_AUTH_TOKEN }
    : {}),
  ...(process.env.TELEGRAM_BOT_TOKEN
    ? { telegramBotToken: process.env.TELEGRAM_BOT_TOKEN }
    : {}),
  ...(process.env.TELEGRAM_APP_NAME ? { telegramAppName: process.env.TELEGRAM_APP_NAME } : {}),
  // Свой публичный адрес Render подставляет сам — по нему регистрируем
  // вебхук бота. Локально переменной нет, и чужой вебхук не перебиваем.
  ...(publicUrl ? { publicUrl } : {}),
  ...(trustProxy > 0 ? { trustProxy } : {}),
  ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
});

try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`dotoscope server on :${port}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}

/**
 * Мягкая остановка. При выкладке хостинг шлёт SIGTERM и через несколько
 * десятков секунд добивает процесс. Без обработчика идущие матчи просто
 * исчезали вместе с ним: ни результата, ни рейтинга, ни строки в истории.
 * Теперь сервер досчитывает их по набранному, дожидается записи в базу и
 * только потом выходит.
 */
const GRACE_MS = 15_000;
let stopping = false;

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: останавливаемся`);
  // Страховка от зависшего закрытия: лучше выйти самому, чем быть убитым
  // на середине записи. Таймер не держит цикл событий.
  const hard = setTimeout(() => {
    console.error('остановка затянулась — выходим принудительно');
    process.exit(1);
  }, GRACE_MS);
  hard.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void stop(signal));
}
