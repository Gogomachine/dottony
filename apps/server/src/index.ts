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

const app = buildApp({
  dbPath: process.env.DATABASE_PATH ?? 'doton.sqlite',
  jwtSecret: jwtSecret ?? 'dev-jwt-secret',
  dailySecret: dailySecret ?? 'dev-daily-secret',
  ...(process.env.TELEGRAM_BOT_TOKEN
    ? { telegramBotToken: process.env.TELEGRAM_BOT_TOKEN }
    : {}),
});

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`doton server on :${port}`))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
