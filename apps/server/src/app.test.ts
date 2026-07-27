import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  applyMove,
  cellAt,
  createBoard,
  phaseColorAt,
  seedRng,
  DEFAULT_CONFIG,
  type Board,
  type Cell,
} from '@doton/core';
import type { MoveLog } from '@doton/protocol';
import { buildApp } from './app.js';
import { dailySeed, replayDaily, todayUtc } from './daily.js';
import { verifyTelegramInitData } from './telegram.js';

const DAILY_SECRET = 'test-daily';
const BOT_TOKEN = '12345:test-bot-token';

/** Любая цепочка из трёх по правилам игры (8 направлений). */
function findAnyChain(board: Board): Cell[] {
  const cfg = DEFAULT_CONFIG;
  const dirs = [-1, 0, 1];
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      const start = cellAt(board.grid, { r, c })!;
      for (const dr1 of dirs) {
        for (const dc1 of dirs) {
          if (dr1 === 0 && dc1 === 0) continue;
          const second: Cell = { r: r + dr1, c: c + dc1 };
          if (cellAt(board.grid, second)?.color !== start.color) continue;
          for (const dr2 of dirs) {
            for (const dc2 of dirs) {
              if (dr2 === 0 && dc2 === 0) continue;
              const third: Cell = { r: second.r + dr2, c: second.c + dc2 };
              if (third.r === r && third.c === c) continue;
              if (cellAt(board.grid, third)?.color !== start.color) continue;
              return [{ r, c }, second, third];
            }
          }
        }
      }
    }
  }
  throw new Error('no chain found');
}

/** Честный лог: ходы, реально сыгранные ядром на данном сиде. */
function playHonestRun(seed: number, movesCount: number): { moves: MoveLog[]; score: number } {
  let board = createBoard(seedRng(seed), DEFAULT_CONFIG);
  const moves: MoveLog[] = [];
  let score = 0;
  for (let i = 0; i < movesCount; i++) {
    const path = findAnyChain(board);
    const t = (i + 1) * 2;
    const result = applyMove(board, path, DEFAULT_CONFIG, phaseColorAt(seed, t, DEFAULT_CONFIG));
    if (typeof result === 'string') throw new Error(result);
    board = result.board;
    score += result.points;
    moves.push({ path, t });
  }
  return { moves, score };
}

function signedInitData(user: object, authDate = Math.floor(Date.now() / 1000)): string {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAE-test',
    user: JSON.stringify(user),
  });
  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

describe('dailySeed', () => {
  it('детерминирован и зависит от даты и секрета', () => {
    expect(dailySeed('2026-07-24', 'a')).toBe(dailySeed('2026-07-24', 'a'));
    expect(dailySeed('2026-07-24', 'a')).not.toBe(dailySeed('2026-07-25', 'a'));
    expect(dailySeed('2026-07-24', 'a')).not.toBe(dailySeed('2026-07-24', 'b'));
  });
});

describe('replayDaily', () => {
  const seed = dailySeed(todayUtc(), DAILY_SECRET);

  it('насчитывает те же очки, что и честная игра', () => {
    const { moves, score } = playHonestRun(seed, 5);
    expect(replayDaily(seed, moves)).toEqual({ score });
  });

  it('отклоняет невозможный ход', () => {
    const moves: MoveLog[] = [
      { path: [{ r: 0, c: 0 }, { r: 5, c: 5 }, { r: 0, c: 1 }], t: 1 },
    ];
    expect(replayDaily(seed, moves)).toBe('invalid-move');
  });

  it('отклоняет нечеловеческий темп', () => {
    const { moves } = playHonestRun(seed, 2);
    const rushed = moves.map((move) => ({ ...move, t: 1 }));
    expect(replayDaily(seed, rushed)).toBe('bad-timing');
  });

  it('отклоняет ходы после конца партии', () => {
    const { moves } = playHonestRun(seed, 1);
    expect(replayDaily(seed, [{ ...moves[0]!, t: 500 }])).toBe('too-long');
  });
});

describe('verifyTelegramInitData', () => {
  it('принимает корректно подписанные данные', () => {
    const initData = signedInitData({ id: 42, first_name: 'Kira', username: 'kira' });
    expect(verifyTelegramInitData(initData, BOT_TOKEN)).toEqual({ id: '42', name: 'kira' });
  });

  it('отклоняет подделанную подпись', () => {
    const initData = signedInitData({ id: 42, first_name: 'Kira' });
    const tampered = initData.replace('Kira', 'Mallory');
    expect(verifyTelegramInitData(tampered, BOT_TOKEN)).toBeNull();
  });

  it('отклоняет протухшие данные', () => {
    const old = Math.floor(Date.now() / 1000) - 7200;
    const initData = signedInitData({ id: 42, first_name: 'Kira' }, old);
    expect(verifyTelegramInitData(initData, BOT_TOKEN)).toBeNull();
  });
});

describe('API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({
      databaseUrl: ':memory:',
      jwtSecret: 'test-jwt',
      dailySecret: DAILY_SECRET,
      telegramBotToken: BOT_TOKEN,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function guestToken(name = 'Тестер'): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/guest',
      payload: { name },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { token: string }).token;
  }

  it('гость получает токен, телеграм-вход проверяет подпись', async () => {
    await guestToken();

    const good = await app.inject({
      method: 'POST',
      url: '/api/auth/telegram',
      payload: { initData: signedInitData({ id: 7, first_name: 'Ада' }) },
    });
    expect(good.statusCode).toBe(200);
    expect((good.json() as { user: { name: string } }).user.name).toBe('Ада');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/telegram',
      payload: { initData: 'auth_date=1&hash=deadbeef&user=%7B%7D' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('повторный телеграм-вход возвращает того же пользователя', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/telegram',
      payload: { initData: signedInitData({ id: 7, username: 'ada' }) },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/telegram',
      payload: { initData: signedInitData({ id: 7, username: 'ada' }) },
    });
    const a = (first.json() as { user: { id: string } }).user.id;
    const b = (second.json() as { user: { id: string } }).user.id;
    expect(a).toBe(b);
  });

  it('полный цикл дня: сид → забег → место → таблица', async () => {
    const token = await guestToken('Вольт');

    const daily = await app.inject({ method: 'GET', url: '/api/daily' });
    const { date, seed } = daily.json() as { date: string; seed: number };
    expect(date).toBe(todayUtc());

    const { moves, score } = playHonestRun(seed, 4);
    const submit = await app.inject({
      method: 'POST',
      url: '/api/daily/run',
      headers: { authorization: `Bearer ${token}` },
      payload: { date, moves },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json()).toEqual({ score, rank: 1 });

    // Вторая попытка в тот же день запрещена.
    const again = await app.inject({
      method: 'POST',
      url: '/api/daily/run',
      headers: { authorization: `Bearer ${token}` },
      payload: { date, moves },
    });
    expect(again.statusCode).toBe(409);

    const board = await app.inject({
      method: 'GET',
      url: '/api/daily/leaderboard',
      headers: { authorization: `Bearer ${token}` },
    });
    const leaderboard = board.json() as {
      entries: { rank: number; name: string; score: number }[];
      me: { rank: number; score: number };
    };
    expect(leaderboard.entries).toEqual([{ rank: 1, name: 'Вольт', score }]);
    expect(leaderboard.me).toEqual({ rank: 1, name: 'Вольт', score });
  });

  it('отклоняет забег с накрученным счётом', async () => {
    const token = await guestToken();
    const daily = await app.inject({ method: 'GET', url: '/api/daily' });
    const { date, seed } = daily.json() as { date: string; seed: number };

    // Ходы от другого сида на этом поле почти наверняка невалидны.
    const { moves } = playHonestRun(seed ^ 0xdeadbeef, 5);
    const submit = await app.inject({
      method: 'POST',
      url: '/api/daily/run',
      headers: { authorization: `Bearer ${token}` },
      payload: { date, moves },
    });
    expect(submit.statusCode).toBe(400);
  });

  it('без токена сабмит не принимается', async () => {
    const submit = await app.inject({
      method: 'POST',
      url: '/api/daily/run',
      payload: { date: todayUtc(), moves: [] },
    });
    expect(submit.statusCode).toBe(401);
  });

  it('ранжирует нескольких игроков', async () => {
    const daily = await app.inject({ method: 'GET', url: '/api/daily' });
    const { date, seed } = daily.json() as { date: string; seed: number };

    const strong = playHonestRun(seed, 5);
    const weak = { moves: strong.moves.slice(0, 2) };

    const tokenA = await guestToken('Сильный');
    const tokenB = await guestToken('Слабый');
    await app.inject({
      method: 'POST',
      url: '/api/daily/run',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { date, moves: strong.moves },
    });
    await app.inject({
      method: 'POST',
      url: '/api/daily/run',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { date, moves: weak.moves },
    });

    const board = await app.inject({ method: 'GET', url: '/api/daily/leaderboard' });
    const { entries } = board.json() as { entries: { name: string; rank: number }[] };
    expect(entries.map((entry) => entry.name)).toEqual(['Сильный', 'Слабый']);
  });
});
