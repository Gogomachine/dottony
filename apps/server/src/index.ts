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
});

try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`dotoscope server on :${port}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
