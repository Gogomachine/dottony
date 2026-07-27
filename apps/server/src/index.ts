import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);

const jwtSecret = process.env.JWT_SECRET;
const dailySecret = process.env.DAILY_SECRET;
if (!jwtSecret || !dailySecret) {
  // Без секретов токены и сид дня предсказуемы — в проде это дыра.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET and DAILY_SECRET are required in production');
  }
  console.warn('JWT_SECRET/DAILY_SECRET not set — using dev defaults');
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

const app = await buildApp({
  databaseUrl,
  jwtSecret: jwtSecret ?? 'dev-jwt-secret',
  dailySecret: dailySecret ?? 'dev-daily-secret',
  ...(process.env.DATABASE_AUTH_TOKEN
    ? { databaseAuthToken: process.env.DATABASE_AUTH_TOKEN }
    : {}),
  ...(process.env.TELEGRAM_BOT_TOKEN
    ? { telegramBotToken: process.env.TELEGRAM_BOT_TOKEN }
    : {}),
});

try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`zaapo server on :${port}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
