import { createHash, createHmac, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  type Color,
} from '@doton/core';
import type { ComboMove, DuelServerMessage, MoveLog } from '@doton/protocol';
import { buildApp, loggedUrl } from './app.js';
import { parseStart } from './bot.js';
import { Store } from './db.js';
import { replayCombo } from './combo.js';
import { SIGNUP_LIMIT } from './limits.js';
import { replaySprint } from './sprint.js';
import { verifyTelegramInitData } from './telegram.js';

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

/**
 * Самая длинная цепочка на поле. Нужна челленджу комбо: заряд появляется
 * только под цепочкой в десять точек, а без зарядов серии не бывает.
 */
function findLongestChain(board: Board): Cell[] {
  const cfg = DEFAULT_CONFIG;
  let best: Cell[] = [];
  const walk = (path: Cell[], color: number): void => {
    if (path.length > best.length) best = [...path];
    const last = path[path.length - 1]!;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const next: Cell = { r: last.r + dr, c: last.c + dc };
        if (next.r < 0 || next.r >= cfg.rows || next.c < 0 || next.c >= cfg.cols) continue;
        if (cellAt(board.grid, next)?.color !== color) continue;
        if (path.some((cell) => cell.r === next.r && cell.c === next.c)) continue;
        path.push(next);
        walk(path, color);
        path.pop();
      }
    }
  };
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      walk([{ r, c }], cellAt(board.grid, { r, c })!.color);
    }
  }
  return best;
}

/**
 * Честный заход бесконечного режима: каждый ход берём самую длинную
 * цепочку — так игрок и гонится за дорогим ходом. Возвращает ходы и
 * лучший потенциал за один ход, который при этом получился у ядра.
 */
function playComboRun(
  seed: number,
  movesCount: number,
): { moves: ComboMove[]; combo: number; points: number[] } {
  let board = createBoard(seedRng(seed), DEFAULT_CONFIG);
  const moves: ComboMove[] = [];
  const points: number[] = [];
  let combo = 0;
  for (let i = 0; i < movesCount; i++) {
    const path = findLongestChain(board);
    if (path.length < DEFAULT_CONFIG.minChain) break;
    const t = (i + 1) * 2;
    const result = applyMove(board, path, DEFAULT_CONFIG, phaseColorAt(seed, t, DEFAULT_CONFIG));
    if (typeof result === 'string') throw new Error(result);
    board = result.board;
    combo = Math.max(combo, result.points);
    points.push(result.points);
    moves.push({ path, t });
  }
  return { moves, combo, points };
}

/** Заход с дорогим ходом — на нём и проверяем челлендж. */
function seedWithCombo(minimum: number): { seed: number; moves: ComboMove[]; combo: number } {
  for (let seed = 1; seed < 60; seed++) {
    const run = playComboRun(seed, 12);
    if (run.combo >= minimum) return { seed, ...run };
  }
  throw new Error('no seed with combo found');
}

/** Заход из коротких цепочек: ходы дешёвые, рекорд заведомо ниже. */
function cheapComboRun(seed: number, movesCount: number): { moves: ComboMove[]; combo: number } {
  let board = createBoard(seedRng(seed), DEFAULT_CONFIG);
  const moves: ComboMove[] = [];
  let combo = 0;
  for (let i = 0; i < movesCount; i++) {
    const path = findAnyChain(board);
    const t = (i + 1) * 2;
    const result = applyMove(board, path, DEFAULT_CONFIG, phaseColorAt(seed, t, DEFAULT_CONFIG));
    if (typeof result === 'string') throw new Error(result);
    board = result.board;
    combo = Math.max(combo, result.points);
    moves.push({ path, t });
  }
  return { moves, combo };
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

/**
 * Подменённый Bot API: тесты не ходят в сеть, а мы видим, что именно
 * бот отправил.
 */
interface TelegramCall {
  method: string;
  payload: Record<string, unknown>;
}

function stubTelegram(): TelegramCall[] {
  const calls: TelegramCall[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const method = String(url).split('/').pop() ?? '';
    calls.push({ method, payload: JSON.parse(init.body) as Record<string, unknown> });
    const result = method === 'getMe' ? { username: 'dotoscope_bot' } : {};
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

/** Тот же секрет, что выводит Bot из ключа JWT. */
function webhookSecret(jwtSecret: string): string {
  return createHash('sha256').update(`${jwtSecret}:telegram-webhook`).digest('hex').slice(0, 32);
}

describe('replaySprint', () => {
  const seed = 42;

  it('насчитывает те же очки, что и честная игра', () => {
    const { moves, score } = playHonestRun(seed, 5);
    expect(replaySprint(seed, moves)).toEqual({ score });
  });

  it('отклоняет невозможный ход', () => {
    const moves: MoveLog[] = [
      { path: [{ r: 0, c: 0 }, { r: 5, c: 5 }, { r: 0, c: 1 }], t: 1 },
    ];
    expect(replaySprint(seed, moves)).toBe('invalid-move');
  });

  it('отклоняет нечеловеческий темп', () => {
    const { moves } = playHonestRun(seed, 2);
    const rushed = moves.map((move) => ({ ...move, t: 1 }));
    expect(replaySprint(seed, rushed)).toBe('bad-timing');
  });

  it('отклоняет ходы после конца партии', () => {
    const { moves } = playHonestRun(seed, 1);
    expect(replaySprint(seed, [{ ...moves[0]!, t: 500 }])).toBe('too-long');
  });
});

describe('replayCombo', () => {
  it('насчитывает тот же потенциал за ход, что и честный заход', () => {
    const { seed, moves, combo } = seedWithCombo(200);
    expect(replayCombo(seed, moves)).toEqual({ combo });
  });

  it('берёт лучший ход, а не последний и не сумму', () => {
    const { seed, moves, combo } = seedWithCombo(200);
    const perMove = moves.map((_, index) => {
      const replayed = replayCombo(seed, moves.slice(0, index + 1));
      if (typeof replayed === 'string') throw new Error(replayed);
      return replayed.combo;
    });
    // Рекорд не убывает и равен максимуму по ходам, а не их сумме.
    expect(Math.max(...perMove)).toBe(combo);
    expect(combo).toBeLessThan(perMove.reduce((sum, value) => sum + value, 0));
  });

  it('длинная цепочка складывает свой ход со следующим — ровно один раз', () => {
    // Порог занижаем: цепочку в 25 точек на поле 6×6 не собрать, а
    // механику продления проверить надо.
    const { moves, points } = playComboRun(1, 4);

    // Порог 3 берёт каждый ход: комбо становится суммой соседних пар.
    const pairs = points.slice(1).map((value, index) => points[index]! + value);
    expect(replayCombo(1, moves, 3)).toEqual({ combo: Math.max(...pairs) });

    // Продление одноразовое: три хода подряд в одно комбо не сложатся.
    const allThree = points.reduce((sum, value) => sum + value, 0);
    expect(Math.max(...pairs)).toBeLessThan(allThree);
  });

  it('без длинных цепочек комбо остаётся ходом', () => {
    const { moves, combo } = playComboRun(1, 4);
    // Порог по умолчанию (25) на этих ходах не берётся: суммы нет.
    expect(replayCombo(1, moves)).toEqual({ combo });
    expect(replayCombo(1, moves, 99)).toEqual({ combo });
  });

  it('короткие цепочки дают дешёвый рекорд', () => {
    const cheap = cheapComboRun(1, 4);
    const rich = playComboRun(1, 4);
    expect(replayCombo(1, cheap.moves)).toEqual({ combo: cheap.combo });
    expect(cheap.combo).toBeLessThan(rich.combo);
  });

  it('отклоняет невозможный ход', () => {
    const moves: ComboMove[] = [
      { path: [{ r: 0, c: 0 }, { r: 5, c: 5 }, { r: 0, c: 1 }], t: 1 },
    ];
    expect(replayCombo(1, moves)).toBe('invalid-move');
  });

  it('отклоняет нечеловеческий темп', () => {
    const { moves } = playHonestRun(1, 2);
    expect(replayCombo(1, moves.map((move) => ({ ...move, t: 1 })))).toBe('bad-timing');
  });

  it('часы бесконечного захода не ограничены тремя минутами', () => {
    const { moves, combo } = cheapComboRun(1, 2);
    const late = moves.map((move, index) => ({ ...move, t: 3600 + index * 2 }));
    // Время сдвинуто за пределы спринта, но фазы на этих секундах те же:
    // проверяем сам факт приёма, а не совпадение до отсчёта.
    const replayed = replayCombo(1, late);
    expect(typeof replayed).not.toBe('string');
    expect(combo).toBeGreaterThan(0);
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

describe('миграции', () => {
  it('доливает колонку log в базу, созданную до появления призраков', async () => {
    const url = `file:${join(tmpdir(), `dotoscope-migrate-${randomUUID()}.db`)}`;
    const legacy = createClient({ url });
    // Схема, какой она была до призраков: у duel_players нет колонки log.
    await legacy.batch(
      [
        `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, tg_id TEXT UNIQUE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
        `CREATE TABLE duels (id TEXT PRIMARY KEY, seed INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
        `CREATE TABLE duel_players (duel_id TEXT NOT NULL, user_id TEXT NOT NULL,
          score INTEGER NOT NULL, PRIMARY KEY (duel_id, user_id))`,
      ],
      'write',
    );
    legacy.close();

    const store = new Store({ url });
    await store.migrate();

    // Именно эти вызовы падали на проде: подбор призрака и запись матча.
    await expect(store.pickGhostRun('nobody', 500)).resolves.toBeUndefined();
    await store.createUser('u1', 'Ада', { kind: 'guest', externalId: 'u1' });
    await expect(
      store.saveDuel('d1', 42, [{ id: 'u1', score: 300, log: [{ t: 1, points: 300 }] }]),
    ).resolves.toBeUndefined();
    const ghost = await store.pickGhostRun('other', 300);
    expect(ghost).toMatchObject({ name: 'Ада', seed: 42, score: 300 });
    store.close();
  });

  it('переносит старые аккаунты в таблицу личностей', async () => {
    const url = `file:${join(tmpdir(), `dotoscope-identities-${randomUUID()}.db`)}`;
    const legacy = createClient({ url });
    // Схема до личностей: способ входа хранился колонкой в users.
    await legacy.batch(
      [
        `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, tg_id TEXT UNIQUE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
        `INSERT INTO users (id, name, tg_id) VALUES ('u-tg', 'Ада', '777')`,
        `INSERT INTO users (id, name, tg_id) VALUES ('u-guest', 'Гость', NULL)`,
      ],
      'write',
    );
    legacy.close();

    const store = new Store({ url });
    await store.migrate();

    // Оба входа продолжают вести в те же аккаунты, что и до миграции.
    await expect(store.userByIdentity('telegram', '777')).resolves.toMatchObject({ id: 'u-tg' });
    await expect(store.userByIdentity('guest', 'u-guest')).resolves.toMatchObject({
      id: 'u-guest',
    });
    // Повторный запуск ничего не ломает и не двоит.
    await store.migrate();
    await expect(store.identitiesOf('u-tg')).resolves.toEqual([
      { kind: 'telegram', linkedAt: expect.any(String) },
    ]);
    store.close();
  });
});

describe('бот', () => {
  const JWT = 'test-jwt';
  let app: FastifyInstance;
  let calls: TelegramCall[];

  beforeEach(async () => {
    calls = stubTelegram();
    app = await buildApp({
      databaseUrl: ':memory:',
      jwtSecret: JWT,
      telegramBotToken: BOT_TOKEN,
    });
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  /** Сообщение боту, как его прислал бы Telegram. */
  function update(text: string, from = { id: 777, username: 'ada' }) {
    return {
      method: 'POST' as const,
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': webhookSecret(JWT) },
      payload: { message: { chat: { id: from.id }, from, text } },
    };
  }

  async function guestToken(name: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/guest',
      payload: { name },
    });
    return (response.json() as { token: string }).token;
  }

  /** Последнее отправленное ботом сообщение. */
  function lastMessage(): string {
    const sent = [...calls].reverse().find((call) => call.method === 'sendMessage');
    return String(sent?.payload.text ?? '');
  }

  it('без секрета вебхук не отвечает', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      payload: { message: { from: { id: 1 }, text: '/start' } },
    });
    expect(response.statusCode).toBe(401);

    const wrong = await app.inject({
      ...update('/start'),
      headers: { 'x-telegram-bot-api-secret-token': 'нет' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(calls.some((call) => call.method === 'sendMessage')).toBe(false);
  });

  it('простой /start заводит игрока и разрешает боту писать', async () => {
    const response = await app.inject(update('/start'));
    expect(response.statusCode).toBe(200);
    expect(lastMessage()).toContain('dotoscope');

    // Тот же Telegram теперь входит в игру и находит этот же аккаунт.
    const auth = await app.inject({
      method: 'POST',
      url: '/api/auth/telegram',
      payload: { initData: signedInitData({ id: 777, username: 'ada' }) },
    });
    expect(auth.statusCode).toBe(200);
  });

  it('ссылка с кодом друга добавляет в друзья', async () => {
    const bob = await guestToken('Боб');
    const bobCode = (
      (
        await app.inject({
          method: 'GET',
          url: '/api/me/friends',
          headers: { authorization: `Bearer ${bob}` },
        })
      ).json() as { code: string }
    ).code;

    await app.inject(update(`/start f_${bobCode}`));
    expect(lastMessage()).toContain('Боб');

    const friends = await app.inject({
      method: 'GET',
      url: '/api/me/friends',
      headers: { authorization: `Bearer ${bob}` },
    });
    // Дружба взаимная: Боб видит пришедшего из Telegram.
    expect((friends.json() as { friends: unknown[] }).friends).toHaveLength(1);
  });

  it('код привязки соединяет браузерный аккаунт с Telegram', async () => {
    const token = await guestToken('Ада');
    const link = await app.inject({
      method: 'POST',
      url: '/api/me/link/telegram',
      headers: { authorization: `Bearer ${token}` },
    });
    const { url } = link.json() as { url: string };
    expect(url).toContain('https://t.me/dotoscope_bot?start=l_');
    const payload = url.split('start=')[1]!;

    await app.inject(update(`/start ${payload}`));
    expect(lastMessage()).toContain('Готово');

    // Аккаунт остался прежним, просто открывается теперь и из Telegram.
    const auth = await app.inject({
      method: 'POST',
      url: '/api/auth/telegram',
      payload: { initData: signedInitData({ id: 777, username: 'ada' }) },
    });
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${(auth.json() as { token: string }).token}` },
    });
    // Имя осталось своим: вход через Telegram не затирает выбранное игроком.
    expect(me.json()).toMatchObject({ name: 'Ада' });
    expect((me.json() as { identities: { kind: string }[] }).identities.map((i) => i.kind)).toEqual([
      'guest',
      'telegram',
    ]);
  });

  it('код привязки одноразовый', async () => {
    const token = await guestToken('Ада');
    const first = await app.inject({
      method: 'POST',
      url: '/api/me/link/telegram',
      headers: { authorization: `Bearer ${token}` },
    });
    const payload = (first.json() as { url: string }).url.split('start=')[1]!;

    await app.inject(update(`/start ${payload}`));
    // Второй раз тем же кодом — уже другой Telegram, и он не должен пройти.
    await app.inject(update(`/start ${payload}`, { id: 999, username: 'mallory' }));
    expect(lastMessage()).toContain('не подошёл');
  });

  it('занятый Telegram не привязывается ко второму профилю', async () => {
    // Ада уже вошла через Telegram.
    await app.inject(update('/start'));
    const other = await guestToken('Чужой');
    const link = await app.inject({
      method: 'POST',
      url: '/api/me/link/telegram',
      headers: { authorization: `Bearer ${other}` },
    });
    const payload = (link.json() as { url: string }).url.split('start=')[1]!;

    await app.inject(update(`/start ${payload}`));
    expect(lastMessage()).toContain('уже привязан к другому профилю');
  });

  it('друга зовут в комнату сообщением, но только если он нажимал Start', async () => {
    const ada = await guestToken('Ада');
    // Боб пришёл из Telegram, значит боту писать ему можно.
    await app.inject(update('/start', { id: 777, username: 'bob' }));
    const bobAuth = await app.inject({
      method: 'POST',
      url: '/api/auth/telegram',
      payload: { initData: signedInitData({ id: 777, username: 'bob' }) },
    });
    const bobToken = (bobAuth.json() as { token: string }).token;
    const bobCode = (
      (
        await app.inject({
          method: 'GET',
          url: '/api/me/friends',
          headers: { authorization: `Bearer ${bobToken}` },
        })
      ).json() as { code: string }
    ).code;

    // Пока не друзья — звать нельзя, иначе это рассылка кому угодно.
    const stranger = await app.inject({
      method: 'POST',
      url: `/api/friends/${bobCode}/invite`,
      headers: { authorization: `Bearer ${ada}` },
      payload: { room: 'КОД1234' },
    });
    expect(stranger.statusCode).toBe(403);

    await app.inject({
      method: 'POST',
      url: '/api/friends',
      headers: { authorization: `Bearer ${ada}` },
      payload: { code: bobCode },
    });
    const invite = await app.inject({
      method: 'POST',
      url: `/api/friends/${bobCode}/invite`,
      headers: { authorization: `Bearer ${ada}` },
      payload: { room: 'ROOM1234' },
    });
    expect(invite.statusCode).toBe(200);

    const sent = [...calls].reverse().find((call) => call.method === 'sendMessage')!;
    expect(sent.payload.chat_id).toBe('777');
    expect(String(sent.payload.text)).toContain('Ада');
    // Ссылок-приглашений нет: играют по коду, его и передаём текстом.
    expect(String(sent.payload.text)).toContain('ROOM1234');
    const markup = sent.payload.reply_markup as { inline_keyboard: { url: string }[][] };
    // Кнопка просто открывает игру и никакой комнаты в себе не несёт.
    expect(markup.inline_keyboard[0]![0]!.url).toBe('https://t.me/dotoscope_bot?startapp=');
  });

  it('другу без Telegram сообщение не уходит — клиент предложит ссылку', async () => {
    const ada = await guestToken('Ада');
    const bob = await guestToken('Боб');
    const bobCode = (
      (
        await app.inject({
          method: 'GET',
          url: '/api/me/friends',
          headers: { authorization: `Bearer ${bob}` },
        })
      ).json() as { code: string }
    ).code;
    await app.inject({
      method: 'POST',
      url: '/api/friends',
      headers: { authorization: `Bearer ${ada}` },
      payload: { code: bobCode },
    });

    const invite = await app.inject({
      method: 'POST',
      url: `/api/friends/${bobCode}/invite`,
      headers: { authorization: `Bearer ${ada}` },
      payload: { room: 'ROOM1234' },
    });
    expect(invite.statusCode).toBe(409);
    expect(invite.json()).toEqual({ error: 'no-telegram' });
  });

  it('health показывает, доехал ли токен бота', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.json()).toMatchObject({ telegram: true, bot: 'dotoscope_bot' });

    const without = await buildApp({
      databaseUrl: ':memory:',
      jwtSecret: JWT,
    });
    const off = await without.inject({ method: 'GET', url: '/api/health' });
    expect(off.json()).toMatchObject({ telegram: false, bot: null });
    await without.close();
  });
});

describe('parseStart', () => {
  it('различает команду старта и полезную нагрузку', () => {
    expect(parseStart('/start')).toBe('');
    expect(parseStart('/start f_ABC123')).toBe('f_ABC123');
    expect(parseStart('  /start   l_deadbeef  ')).toBe('l_deadbeef');
    expect(parseStart('/startle')).toBeNull();
    expect(parseStart('привет')).toBeNull();
    expect(parseStart(undefined)).toBeNull();
  });
});

describe('привязка способов входа', () => {
  let store: Store;

  beforeEach(async () => {
    store = new Store({ url: ':memory:' });
    await store.migrate();
  });

  afterEach(() => store.close());

  it('один аккаунт может иметь несколько входов', async () => {
    await store.createUser('u1', 'Ада', { kind: 'guest', externalId: 'u1' });
    await expect(store.linkIdentity('u1', { kind: 'ton', externalId: 'EQwallet' })).resolves.toBe(
      'linked',
    );
    await expect(store.userByIdentity('ton', 'EQwallet')).resolves.toMatchObject({ id: 'u1' });
    expect((await store.identitiesOf('u1')).map((entry) => entry.kind).sort()).toEqual([
      'guest',
      'ton',
    ]);
  });

  it('повторная привязка того же входа безопасна', async () => {
    await store.createUser('u1', 'Ада', { kind: 'guest', externalId: 'u1' });
    await store.linkIdentity('u1', { kind: 'ton', externalId: 'EQwallet' });
    await expect(store.linkIdentity('u1', { kind: 'ton', externalId: 'EQwallet' })).resolves.toBe(
      'already-linked',
    );
    expect(await store.identitiesOf('u1')).toHaveLength(2);
  });

  it('матч с призраком виден в истории и не идёт в подбор призраков', async () => {
    await store.createUser('u1', 'Ада', { kind: 'guest', externalId: 'u1' });
    await store.saveDuel('d1', 42, [
      { id: 'u1', name: 'Ада', score: 300, outcome: 'loss', log: [{ t: 1, points: 300 }] },
      { id: 'ghost:Эталон:1', name: 'Эталон', score: 500, log: [{ t: 1, points: 500 }], ghost: true },
    ]);

    const [entry] = await store.duelHistory('u1', 10);
    expect(entry).toMatchObject({ opponentName: 'Эталон', opponentScore: 500, opponentGhost: true });
    // Запись призрака не должна снова стать призраком: это копия чужого темпа.
    await expect(store.pickGhostRun('u1', 500)).resolves.toBeUndefined();
    // И на сводку дуэлей строка призрака не влияет.
    await expect(store.duelRecord('u1')).resolves.toEqual({ played: 1, won: 0 });
    // В друзья призрака не предлагаем: за записью нет живого человека.
    await expect(store.recentOpponents('u1', 10)).resolves.toEqual([]);
  });

  it('чужой кошелёк не переносится: аккаунты не сливаем', async () => {
    await store.createUser('u1', 'Ада', { kind: 'guest', externalId: 'u1' });
    await store.createUser('u2', 'Боб', { kind: 'guest', externalId: 'u2' });
    await store.linkIdentity('u1', { kind: 'ton', externalId: 'EQwallet' });

    await expect(store.linkIdentity('u2', { kind: 'ton', externalId: 'EQwallet' })).resolves.toBe(
      'taken',
    );
    // Владелец не изменился — иначе кошелёк можно было бы «угнать».
    await expect(store.userByIdentity('ton', 'EQwallet')).resolves.toMatchObject({ id: 'u1' });
  });
});

describe('API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({
      databaseUrl: ':memory:',
      jwtSecret: 'test-jwt',
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

  it('гость, вошедший через Telegram, остаётся тем же игроком', async () => {
    const token = await guestToken('Гость');
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const before = (me.json() as { name: string }).name;

    // Тот же браузер, тот же токен — но теперь игра открыта внутри Telegram.
    const linked = await app.inject({
      method: 'POST',
      url: '/api/auth/telegram',
      headers: { authorization: `Bearer ${token}` },
      payload: { initData: signedInitData({ id: 7, first_name: 'Ада' }) },
    });
    expect(linked.statusCode).toBe(200);
    const upgraded = (linked.json() as { token: string; user: { name: string } }).token;

    const after = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${upgraded}` },
    });
    // Аккаунт тот же — рейтинг и история не остались на брошенной учётке.
    expect((after.json() as { name: string }).name).toBe(before);
    expect((after.json() as { identities: { kind: string }[] }).identities.map((i) => i.kind)).toEqual(
      ['guest', 'telegram'],
    );

    // А следующий вход через Telegram уже ведёт в этот же аккаунт без токена.
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/telegram',
      payload: { initData: signedInitData({ id: 7, first_name: 'Ада' }) },
    });
    const direct = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${(again.json() as { token: string }).token}` },
    });
    expect((direct.json() as { identities: unknown[] }).identities).toHaveLength(2);
  });

  it('занятый Telegram не переносится на другой аккаунт', async () => {
    // Аккаунт с уже привязанным Telegram.
    await app.inject({
      method: 'POST',
      url: '/api/auth/telegram',
      payload: { initData: signedInitData({ id: 7, first_name: 'Ада' }) },
    });
    // Другой гость входит тем же Telegram: он должен попасть в аккаунт Ады,
    // а не увести чужую личность к себе.
    const other = await guestToken('Чужой');
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/telegram',
      headers: { authorization: `Bearer ${other}` },
      payload: { initData: signedInitData({ id: 7, first_name: 'Ада' }) },
    });
    expect((response.json() as { user: { name: string } }).user.name).toBe('Ада');

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${(response.json() as { token: string }).token}` },
    });
    expect((me.json() as { identities: { kind: string }[] }).identities.map((i) => i.kind)).toEqual([
      'telegram',
    ]);
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

  it('смайлик на пропуске сохраняется, а текст вместо него не проходит', async () => {
    const token = await guestToken('Ада');
    const me = async (): Promise<{ avatar: string | null }> => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${token}` },
      });
      return response.json() as { avatar: string | null };
    };
    const put = (avatar: string) =>
      app.inject({
        method: 'POST',
        url: '/api/me/avatar',
        headers: { authorization: `Bearer ${token}` },
        payload: { avatar },
      });

    expect((await me()).avatar).toBeNull();

    expect((await put('🔭')).statusCode).toBe(200);
    expect((await me()).avatar).toBe('🔭');

    // Составной смайлик — тоже смайлик: он из нескольких символов.
    expect((await put('👨‍🚀')).statusCode).toBe(200);
    expect((await me()).avatar).toBe('👨‍🚀');

    // Место под фото рассчитано на знак, а не на слово.
    for (const bad of ['Ада', '42', 'x🔭', '']) {
      expect((await put(bad)).statusCode).toBe(400);
    }
    expect((await me()).avatar).toBe('👨‍🚀');
  });

  it('спринт: заход попадает в таблицу с пересчитанным счётом', async () => {
    const token = await guestToken('Вольт');
    const seed = 12345;
    const { moves, score } = playHonestRun(seed, 4);

    const submit = await app.inject({
      method: 'POST',
      url: '/api/sprint',
      headers: { authorization: `Bearer ${token}` },
      payload: { seed, moves },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json()).toEqual({ score, best: score, record: true, rank: 1 });

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((me.json() as { sprint: unknown }).sprint).toEqual({ best: score, rank: 1 });

    const board = await app.inject({
      method: 'GET',
      url: '/api/sprint/leaderboard',
      headers: { authorization: `Bearer ${token}` },
    });
    const leaderboard = board.json() as {
      entries: { rank: number; name: string; score: number }[];
      me: { rank: number; name: string; score: number } | null;
    };
    expect(leaderboard.entries).toEqual([{ rank: 1, name: 'Вольт', score }]);
    expect(leaderboard.me).toEqual({ rank: 1, name: 'Вольт', score });
  });

  it('спринт: попыток сколько угодно, в таблице остаётся лучшая', async () => {
    const token = await guestToken('Вольт');
    const seed = 12345;
    const strong = playHonestRun(seed, 4);
    const weak = { moves: strong.moves.slice(0, 2) };
    const send = async (moves: MoveLog[]): Promise<unknown> => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sprint',
        headers: { authorization: `Bearer ${token}` },
        payload: { seed, moves },
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    };

    await send(strong.moves);
    const second = (await send(weak.moves)) as { score: number; best: number; record: boolean };
    expect(second.score).toBeLessThan(strong.score);
    expect(second.record).toBe(false);
    expect(second.best).toBe(strong.score);
  });

  it('спринт: отклоняет заход с накрученным счётом', async () => {
    const token = await guestToken();
    const seed = 777;
    // Ходы от другого сида на этом поле почти наверняка невалидны.
    const { moves } = playHonestRun(seed ^ 0xdeadbeef, 5);
    const submit = await app.inject({
      method: 'POST',
      url: '/api/sprint',
      headers: { authorization: `Bearer ${token}` },
      payload: { seed, moves },
    });
    expect(submit.statusCode).toBe(400);

    const board = await app.inject({ method: 'GET', url: '/api/sprint/leaderboard' });
    expect((board.json() as { entries: unknown[] }).entries).toEqual([]);
  });

  it('спринт: без токена заход не принимается', async () => {
    const { moves } = playHonestRun(1, 2);
    const submit = await app.inject({
      method: 'POST',
      url: '/api/sprint',
      payload: { seed: 1, moves },
    });
    expect(submit.statusCode).toBe(401);
  });

  it('спринт: таблица ранжирует игроков по рекорду', async () => {
    const seed = 999;
    const strong = playHonestRun(seed, 5);
    const weak = { moves: strong.moves.slice(0, 2) };

    const tokenA = await guestToken('Сильный');
    const tokenB = await guestToken('Слабый');
    for (const [token, moves] of [
      [tokenA, strong.moves],
      [tokenB, weak.moves],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: '/api/sprint',
        headers: { authorization: `Bearer ${token}` },
        payload: { seed, moves },
      });
    }

    const board = await app.inject({
      method: 'GET',
      url: '/api/sprint/leaderboard',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const { entries, me } = board.json() as {
      entries: { name: string; rank: number }[];
      me: { rank: number } | null;
    };
    expect(entries.map((entry) => entry.name)).toEqual(['Сильный', 'Слабый']);
    expect(me?.rank).toBe(2);
  });

  it('челлендж комбо: заход попадает в таблицу с пересчитанным потенциалом', async () => {
    const { seed, moves, combo } = seedWithCombo(200);
    const token = await guestToken('Ада');

    const sent = await app.inject({
      method: 'POST',
      url: '/api/combo',
      headers: { authorization: `Bearer ${token}` },
      payload: { seed, moves },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({ combo, best: combo, record: true, rank: 1 });

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((me.json() as { combo: unknown }).combo).toEqual({ best: combo, rank: 1 });

    const board = await app.inject({
      method: 'GET',
      url: '/api/combo/leaderboard',
      headers: { authorization: `Bearer ${token}` },
    });
    const { entries, me: mine } = board.json() as {
      entries: { name: string; combo: number; rank: number }[];
      me: { rank: number; combo: number } | null;
    };
    expect(entries).toEqual([{ rank: 1, name: 'Ада', combo }]);
    expect(mine).toEqual({ rank: 1, name: 'Ада', combo });
  });

  it('челлендж комбо: рекорд не понижается слабым заходом', async () => {
    const { seed, moves, combo } = seedWithCombo(200);
    const cheap = cheapComboRun(seed, 3);
    const token = await guestToken('Ада');
    const send = async (payload: object): Promise<unknown> => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/combo',
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      return response.json();
    };

    await send({ seed, moves });
    // Заход короткими цепочками: ходы дешевле рекорда.
    const result = (await send({ seed, moves: cheap.moves })) as {
      combo: number;
      best: number;
      record: boolean;
    };
    expect(result.combo).toBe(cheap.combo);
    expect(result.combo).toBeLessThan(combo);
    expect(result.record).toBe(false);
    expect(result.best).toBe(combo);
  });

  it('челлендж комбо: подделанный лог не проходит', async () => {
    const token = await guestToken('Мошенник');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/combo',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        seed: 1,
        moves: [{ path: [{ r: 0, c: 0 }, { r: 5, c: 5 }, { r: 0, c: 1 }], t: 1 }],
      },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).toBe('invalid-move');

    const board = await app.inject({ method: 'GET', url: '/api/combo/leaderboard' });
    expect((board.json() as { entries: unknown[] }).entries).toEqual([]);
  });

  it('челлендж комбо: без токена заход не принимается', async () => {
    const { seed, moves } = seedWithCombo(200);
    const sent = await app.inject({ method: 'POST', url: '/api/combo', payload: { seed, moves } });
    expect(sent.statusCode).toBe(401);
  });

  it('челлендж комбо: таблица ранжирует игроков по рекорду', async () => {
    const { seed, moves, combo } = seedWithCombo(200);
    const cheap = cheapComboRun(seed, 3);
    const strong = await guestToken('Сильный');
    const weak = await guestToken('Слабый');
    const send = async (token: string, payload: object): Promise<void> => {
      await app.inject({
        method: 'POST',
        url: '/api/combo',
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    };

    await send(strong, { seed, moves });
    await send(weak, { seed, moves: cheap.moves });

    const board = await app.inject({
      method: 'GET',
      url: '/api/combo/leaderboard',
      headers: { authorization: `Bearer ${weak}` },
    });
    const { entries, me } = board.json() as {
      entries: { name: string; rank: number; combo: number }[];
      me: { rank: number } | null;
    };
    expect(entries).toEqual([
      { rank: 1, name: 'Сильный', combo },
      { rank: 2, name: 'Слабый', combo: cheap.combo },
    ]);
    expect(me?.rank).toBe(2);
  });

  it('друг добавляется по коду — сразу с обеих сторон', async () => {
    const ada = await guestToken('Ада');
    const bob = await guestToken('Боб');

    const bobFriends = await app.inject({
      method: 'GET',
      url: '/api/me/friends',
      headers: { authorization: `Bearer ${bob}` },
    });
    const bobCode = (bobFriends.json() as { code: string }).code;
    expect(bobCode).toMatch(/^[A-Z0-9]{6}$/);

    // Код вводят руками — регистр и пробелы не должны мешать.
    const added = await app.inject({
      method: 'POST',
      url: '/api/friends',
      headers: { authorization: `Bearer ${ada}` },
      payload: { code: ` ${bobCode.toLowerCase()} ` },
    });
    expect(added.statusCode).toBe(200);

    for (const [token, expected] of [
      [ada, 'Боб'],
      [bob, 'Ада'],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/me/friends',
        headers: { authorization: `Bearer ${token}` },
      });
      const { friends } = response.json() as { friends: { name: string; record: unknown }[] };
      // Дружба взаимная: подтверждать нечего.
      expect(friends.map((friend) => friend.name)).toEqual([expected]);
      expect(friends[0]!.record).toEqual({ played: 0, won: 0 });
    }
  });

  it('несуществующий код и добавление себя отклоняются', async () => {
    const ada = await guestToken('Ада');
    const mine = await app.inject({
      method: 'GET',
      url: '/api/me/friends',
      headers: { authorization: `Bearer ${ada}` },
    });
    const myCode = (mine.json() as { code: string }).code;

    const missing = await app.inject({
      method: 'POST',
      url: '/api/friends',
      headers: { authorization: `Bearer ${ada}` },
      payload: { code: 'ZZZZZZ' },
    });
    expect(missing.statusCode).toBe(404);

    const self = await app.inject({
      method: 'POST',
      url: '/api/friends',
      headers: { authorization: `Bearer ${ada}` },
      payload: { code: myCode },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json()).toEqual({ error: 'self' });
  });

  it('повторное добавление и удаление друга безопасны', async () => {
    const ada = await guestToken('Ада');
    const bob = await guestToken('Боб');
    const bobCode = (
      (
        await app.inject({
          method: 'GET',
          url: '/api/me/friends',
          headers: { authorization: `Bearer ${bob}` },
        })
      ).json() as { code: string }
    ).code;

    await app.inject({
      method: 'POST',
      url: '/api/friends',
      headers: { authorization: `Bearer ${ada}` },
      payload: { code: bobCode },
    });
    // Кнопку могли нажать дважды — это не ошибка и не даёт дубля.
    const again = await app.inject({
      method: 'POST',
      url: '/api/friends',
      headers: { authorization: `Bearer ${ada}` },
      payload: { code: bobCode },
    });
    expect(again.statusCode).toBe(200);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/friends/${bobCode}`,
      headers: { authorization: `Bearer ${ada}` },
    });
    expect(removed.statusCode).toBe(200);

    // Удаление тоже взаимное: односторонней дружбы у нас нет.
    for (const token of [ada, bob]) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/me/friends',
        headers: { authorization: `Bearer ${token}` },
      });
      expect((response.json() as { friends: unknown[] }).friends).toEqual([]);
    }
  });

  it('наработка копится из режима без конца партии', async () => {
    const token = await guestToken('Наблюдатель');
    const add = async (points: number, moves: number) =>
      app.inject({
        method: 'POST',
        url: '/api/me/score',
        headers: { authorization: `Bearer ${token}` },
        payload: { points, moves },
      });

    expect((await add(1200, 12)).statusCode).toBe(200);
    expect((await add(800, 9)).json()).toEqual({ total: 2000 });

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json()).toMatchObject({ total: 2000 });
  });

  it('накрутить наработку одним запросом не выйдет', async () => {
    const token = await guestToken('Хитрец');

    // Ходов больше, чем человек успел бы сделать за время жизни аккаунта.
    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/me/score',
      headers: { authorization: `Bearer ${token}` },
      payload: { points: 100_000, moves: 1500 },
    });
    expect(tooMany.statusCode).toBe(429);

    // Немного ходов, но неправдоподобно дорогих.
    const tooRich = await app.inject({
      method: 'POST',
      url: '/api/me/score',
      headers: { authorization: `Bearer ${token}` },
      payload: { points: 199_999, moves: 3 },
    });
    expect(tooRich.statusCode).toBe(400);
    expect(tooRich.json()).toEqual({ error: 'implausible' });

    // За пределами схемы вообще не принимаем.
    const absurd = await app.inject({
      method: 'POST',
      url: '/api/me/score',
      headers: { authorization: `Bearer ${token}` },
      payload: { points: 10_000_000, moves: 1 },
    });
    expect(absurd.statusCode).toBe(400);

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    // Ни один из отклонённых досылов не прошёл.
    expect(me.json()).toMatchObject({ total: 0 });
  });

  it('спринт не трогает наработку: её досылает клиент по ходу партии', async () => {
    const token = await guestToken('Вольт');
    const seed = 4242;
    const { moves, score } = playHonestRun(seed, 4);
    const me = async (): Promise<{ total: number }> => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${token}` },
      });
      return response.json() as { total: number };
    };

    await app.inject({
      method: 'POST',
      url: '/api/sprint',
      headers: { authorization: `Bearer ${token}` },
      payload: { seed, moves },
    });
    // Потенциал спринта идёт обычным досылом — иначе он зачёлся бы дважды.
    expect((await me()).total).toBe(0);

    await app.inject({
      method: 'POST',
      url: '/api/me/score',
      headers: { authorization: `Bearer ${token}` },
      payload: { points: score, moves: moves.length },
    });
    expect((await me()).total).toBe(score);
  });

  it('новичок стоит на стартовом рейтинге и вне таблицы', async () => {
    const token = await guestToken('Новичок');
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json()).toMatchObject({
      name: 'Новичок',
      rating: 1500,
      league: 'Ученик алхимика',
      // До калибровки в таблице не показываемся.
      rank: null,
      placement: { played: 0, required: 5 },
      duels: { played: 0, won: 0 },
      next: { league: 'Младший научный сотрудник', gap: 100 },
    });

    const board = await app.inject({ method: 'GET', url: '/api/rating' });
    expect(board.json()).toEqual({ entries: [], me: null });
  });
});

describe('рейтинг за дуэль', () => {
  let app: FastifyInstance;
  let base: string;

  beforeEach(async () => {
    app = await buildApp({
      databaseUrl: ':memory:',
      jwtSecret: 'test-jwt',
      // Призрак в этих тестах только мешал бы: ждём живого соперника.
      duelGhosts: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    base = `127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  async function guest(name: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/auth/guest', payload: { name } });
    return (response.json() as { token: string }).token;
  }

  /** Живой игрок поверх настоящего WebSocket: инъекция сокеты не умеет. */
  class Client {
    readonly messages: DuelServerMessage[] = [];
    private constructor(private readonly socket: WebSocket) {}

    static async open(base: string, token: string): Promise<Client> {
      const socket = new WebSocket(`ws://${base}/duel?token=${token}`);
      const client = new Client(socket);
      socket.addEventListener('message', (event) => {
        client.messages.push(JSON.parse(String(event.data)) as DuelServerMessage);
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve());
        socket.addEventListener('error', () => reject(new Error('socket failed')));
      });
      return client;
    }

    send(message: unknown): void {
      this.socket.send(JSON.stringify(message));
    }

    close(): void {
      this.socket.close();
    }

    /** Ждёт сообщение, подходящее под условие: порядок ответов не гарантирован. */
    async wait<T extends DuelServerMessage>(match: (message: DuelServerMessage) => boolean) {
      const deadline = Date.now() + 5000;
      for (;;) {
        const found = this.messages.find(match);
        if (found) return found as T;
        if (Date.now() > deadline) {
          throw new Error(`timeout, got: ${JSON.stringify(this.messages)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  type Finished = Extract<DuelServerMessage, { type: 'finished' }>;

  /**
   * Сводит двух игроков и завершает матч сдачей первого — исход предсказуем.
   * Возвращает итоговые сообщения с рейтингом (в нерейтинговом матче — null).
   */
  async function playDuel(
    tokens: [string, string],
    options: { room?: string; rated?: boolean; moves?: number } = {},
  ): Promise<{ loser: Finished | null; winner: Finished | null }> {
    const loser = await Client.open(base, tokens[0]);
    const winner = await Client.open(base, tokens[1]);
    const join = options.room ? { type: 'join', room: options.room } : { type: 'join' };
    loser.send(join);
    await loser.wait((message) => message.type === 'searching');
    winner.send(join);
    const [matched] = await Promise.all([
      winner.wait<Extract<DuelServerMessage, { type: 'matched' }>>(
        (message) => message.type === 'matched',
      ),
      loser.wait((message) => message.type === 'matched'),
    ]);

    // Победитель играет честно: без ходов не было бы ни реплея, ни счёта.
    let board = createBoard(seedRng(matched.seed), DEFAULT_CONFIG);
    for (let i = 0; i < (options.moves ?? 2); i++) {
      const path = findAnyChain(board);
      winner.send({ type: 'move', path });
      await winner.wait((message) => message.type === 'accepted' || message.type === 'rejected');
      const applied = applyMove(board, path, DEFAULT_CONFIG, null);
      if (typeof applied !== 'string') board = applied.board;
      // Сервер отбивает нечеловеческий темп — выдерживаем паузу.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    loser.send({ type: 'leave' });
    // Рейтинг досылается отдельным сообщением уже после результата.
    const wanted = (message: DuelServerMessage): boolean =>
      message.type === 'finished' && (options.rated !== false ? message.rating !== undefined : true);
    const [loserFinal, winnerFinal] = await Promise.all([
      loser.wait<Finished>(wanted),
      winner.wait<Finished>(wanted),
    ]);
    loser.close();
    winner.close();
    return { loser: loserFinal, winner: winnerFinal };
  }

  it('победитель растёт, проигравший падает, и оба видят новый рейтинг', async () => {
    const tokens: [string, string] = [await guest('Проигравший'), await guest('Победитель')];
    const { loser, winner } = await playDuel(tokens);

    expect(winner!.rating!.after).toBeGreaterThan(winner!.rating!.before);
    expect(loser!.rating!.after).toBeLessThan(loser!.rating!.before);

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${tokens[1]}` },
    });
    const card = me.json() as {
      rating: number;
      rank: number | null;
      placement: { played: number; required: number };
      duels: { played: number; won: number };
      total: number;
    };
    expect(card.rating).toBe(winner!.rating!.after);
    expect(card.duels).toEqual({ played: 1, won: 1 });
    // Очки дуэли идут в наработку сами: сервер их уже посчитал.
    expect(card.total).toBe(winner!.score);
    // Одна победа лигу не даёт: сначала калибровка.
    expect(card.rank).toBeNull();
    expect(card.placement).toEqual({ played: 1, required: 5 });
    expect(winner!.rating!.placement).toEqual({ played: 1, required: 5 });

    const board = await app.inject({ method: 'GET', url: '/api/rating' });
    expect((board.json() as { entries: unknown[] }).entries).toEqual([]);
  });

  it('после калибровки игрок попадает в таблицу рейтинга', async () => {
    const tokens: [string, string] = [await guest('Проигравший'), await guest('Победитель')];
    for (let i = 0; i < 5; i++) await playDuel(tokens);

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${tokens[1]}` },
    });
    expect(me.json()).toMatchObject({ rank: 1, placement: null });

    const board = await app.inject({
      method: 'GET',
      url: '/api/rating',
      headers: { authorization: `Bearer ${tokens[0]}` },
    });
    const rating = board.json() as {
      entries: { rank: number; name: string; league: string }[];
      me: { rank: number; name: string };
    };
    expect(rating.entries.map((entry) => entry.name)).toEqual(['Победитель', 'Проигравший']);
    expect(rating.entries[0]!.league).toBeTruthy();
    expect(rating.me).toMatchObject({ rank: 2, name: 'Проигравший' });
  }, 20_000);

  it('история матчей помнит соперника, исход и сдвиг рейтинга', async () => {
    const tokens: [string, string] = [await guest('Проигравший'), await guest('Победитель')];
    await playDuel(tokens);

    const response = await app.inject({
      method: 'GET',
      url: '/api/me/history',
      headers: { authorization: `Bearer ${tokens[1]}` },
    });
    const { entries } = response.json() as {
      entries: {
        duelId: string;
        outcome: string;
        opponent: string;
        opponentScore: number;
        ghost: boolean;
        rating: { before: number; after: number };
        replay: boolean;
      }[];
    };
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      outcome: 'win',
      opponent: 'Проигравший',
      opponentScore: 0,
      ghost: false,
    });
    expect(entries[0]!.rating!.after).toBeGreaterThan(entries[0]!.rating!.before);
  });

  it('реплей отдаётся только своему хозяину', async () => {
    const tokens: [string, string] = [await guest('Проигравший'), await guest('Победитель')];
    await playDuel(tokens);
    const stranger = await guest('Чужой');

    const history = await app.inject({
      method: 'GET',
      url: '/api/me/history',
      headers: { authorization: `Bearer ${tokens[1]}` },
    });
    const { duelId } = (history.json() as { entries: { duelId: string }[] }).entries[0]!;

    const mine = await app.inject({
      method: 'GET',
      url: `/api/me/history/${duelId}/replay`,
      headers: { authorization: `Bearer ${tokens[1]}` },
    });
    expect(mine.statusCode).toBe(200);
    const replay = mine.json() as { seed: number; moves: MoveLog[]; opponent: string };
    expect(replay.opponent).toBe('Проигравший');
    // Ходы победителя: их достаточно, чтобы прокрутить партию на том же поле.
    expect(replay.moves.length).toBeGreaterThan(0);
    let board = createBoard(seedRng(replay.seed), DEFAULT_CONFIG);
    let score = 0;
    for (const move of replay.moves) {
      const applied = applyMove(board, move.path, DEFAULT_CONFIG, null);
      // Каждый записанный ход обязан быть легальным на своём месте —
      // иначе реплей рассыпался бы на середине.
      if (typeof applied === 'string') throw new Error(`ход не воспроизводится: ${applied}`);
      board = applied.board;
      score += applied.points;
    }
    expect(score).toBeGreaterThan(0);

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/me/history/${duelId}/replay`,
      headers: { authorization: `Bearer ${stranger}` },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('смена имени выдаёт новый токен и видна в истории соперника', async () => {
    const tokens: [string, string] = [await guest('Старое'), await guest('Победитель')];
    await playDuel(tokens);

    const renamed = await app.inject({
      method: 'POST',
      url: '/api/me/name',
      headers: { authorization: `Bearer ${tokens[0]}` },
      payload: { name: 'Новое' },
    });
    expect(renamed.statusCode).toBe(200);
    const fresh = (renamed.json() as { token: string; user: { name: string } }).user.name;
    expect(fresh).toBe('Новое');

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${(renamed.json() as { token: string }).token}` },
    });
    expect(me.json()).toMatchObject({ name: 'Новое', identities: [{ kind: 'guest' }] });

    // История хранит имя на момент матча — соперник должен узнать партию.
    const history = await app.inject({
      method: 'GET',
      url: '/api/me/history',
      headers: { authorization: `Bearer ${tokens[1]}` },
    });
    expect((history.json() as { entries: { opponent: string }[] }).entries[0]!.opponent).toBe(
      'Старое',
    );
  });

  it('соперник попадает в «недавние», а после добавления — в друзья со счётом', async () => {
    const tokens: [string, string] = [await guest('Проигравший'), await guest('Победитель')];
    const { winner } = await playDuel(tokens);
    // Код соперника приходит вместе с матчем — по нему и добавляем.
    expect(winner!.type).toBe('finished');

    const before = await app.inject({
      method: 'GET',
      url: '/api/me/friends',
      headers: { authorization: `Bearer ${tokens[1]}` },
    });
    const { recent } = before.json() as { recent: { name: string; code: string }[] };
    expect(recent.map((entry) => entry.name)).toEqual(['Проигравший']);

    const added = await app.inject({
      method: 'POST',
      url: '/api/friends',
      headers: { authorization: `Bearer ${tokens[1]}` },
      payload: { code: recent[0]!.code },
    });
    expect(added.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/me/friends',
      headers: { authorization: `Bearer ${tokens[1]}` },
    });
    const list = after.json() as {
      friends: { name: string; record: { played: number; won: number }; provisional: boolean }[];
      recent: unknown[];
    };
    expect(list.friends[0]).toMatchObject({
      name: 'Проигравший',
      // Личный счёт: одна встреча, победа за мной.
      record: { played: 1, won: 1 },
      provisional: true,
    });
    // Уже друг — в «недавних» его больше не предлагаем.
    expect(list.recent).toEqual([]);
  });

  it('матч в комнате с другом рейтинг не трогает', async () => {
    const tokens: [string, string] = [await guest('Друг'), await guest('Подруга')];
    const { winner } = await playDuel(tokens, { room: 'КОД1234', rated: false });
    expect(winner!.rating).toBeUndefined();

    // Даём фору асинхронному пересчёту: если бы он был, он бы уже прошёл.
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const token of tokens) {
      const me = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.json()).toMatchObject({ rating: 1500, placement: { played: 0, required: 5 } });
    }
  });
});

describe('заявка на цвет в одиночном заходе', () => {
  const cfg = DEFAULT_CONFIG;

  /** Цепочка заданной длины и цвета: поиск в глубину по соседям. */
  function findChain(board: Board, length: number, color: number): Cell[] | null {
    const dirs = [-1, 0, 1];
    const path: Cell[] = [];
    const taken = new Set<string>();
    const key = (cell: Cell): string => `${cell.r},${cell.c}`;
    const walk = (cell: Cell): boolean => {
      path.push(cell);
      taken.add(key(cell));
      if (path.length === length) return true;
      for (const dr of dirs) {
        for (const dc of dirs) {
          if (dr === 0 && dc === 0) continue;
          const next: Cell = { r: cell.r + dr, c: cell.c + dc };
          if (taken.has(key(next))) continue;
          if (cellAt(board.grid, next)?.color !== color) continue;
          if (walk(next)) return true;
        }
      }
      path.pop();
      taken.delete(key(cell));
      return false;
    };
    for (let r = 0; r < cfg.rows; r++) {
      for (let c = 0; c < cfg.cols; c++) {
        if (cellAt(board.grid, { r, c })?.color !== color) continue;
        if (walk({ r, c })) return path;
        path.length = 0;
        taken.clear();
      }
    }
    return null;
  }

  /**
   * Заход из двух ходов: заявка в окне и цепочка того же цвета уже в фазе.
   * Цвет подобран так, чтобы сид его сам не выбрал — иначе проверять нечего.
   */
  function claimRun(): { seed: number; moves: MoveLog[]; claimed: number; plain: number } {
    const claimT = cfg.phasePeriod + cfg.claimWindow / 2;
    const phaseT = cfg.phasePeriod + cfg.claimWindow + 1;
    for (let seed = 1; seed < 400; seed++) {
      const board = createBoard(seedRng(seed), cfg);
      const own = phaseColorAt(seed, phaseT, cfg)!;
      for (let color = 0; color < cfg.colors; color++) {
        if (color === own) continue;
        const first = findChain(board, cfg.claimChainLength, color);
        if (!first) continue;
        const after = applyMove(board, first, cfg, phaseColorAt(seed, claimT, cfg));
        if (typeof after === 'string') continue;
        const second = findChain(after.board, 3, color);
        if (!second) continue;
        const claimed = applyMove(after.board, second, cfg, color as Color);
        const plain = applyMove(after.board, second, cfg, own);
        if (typeof claimed === 'string' || typeof plain === 'string') continue;
        return {
          seed,
          moves: [
            { path: first, t: claimT },
            { path: second, t: phaseT },
          ],
          claimed: after.points + claimed.points,
          plain: after.points + plain.points,
        };
      }
    }
    throw new Error('no run found');
  }

  it('цвет фазы берётся из заявки, а не из сида', () => {
    const { seed, moves, claimed, plain } = claimRun();
    // Заявка подняла ход в фазе: сид дал бы другой цвет и меньше очков.
    expect(claimed).toBeGreaterThan(plain);
    expect(replaySprint(seed, moves)).toEqual({ score: claimed });
  });

  it('комбо считается по тому же цвету фазы', () => {
    const { seed, moves } = claimRun();
    const best = Math.max(
      ...moves.map((_, index) => {
        const upto = replaySprint(seed, moves.slice(0, index + 1));
        const before = index === 0 ? { score: 0 } : replaySprint(seed, moves.slice(0, index));
        if (typeof upto === 'string' || typeof before === 'string') throw new Error('replay');
        return upto.score - before.score;
      }),
    );
    expect(replayCombo(seed, moves)).toEqual({ combo: best });
  });
});

describe('таблицы за день и за всё время', () => {
  let app: FastifyInstance;
  let raw: ReturnType<typeof createClient>;
  let file: string;

  beforeEach(async () => {
    // Файловая база, а не ':memory:': к ней нужен второй клиент — состарить
    // запись, чтобы она выпала из сегодняшней таблицы.
    file = join(tmpdir(), `doton-board-${randomUUID()}.db`);
    app = await buildApp({ databaseUrl: `file:${file}`, jwtSecret: 'test-jwt' });
    raw = createClient({ url: `file:${file}` });
  });

  afterEach(async () => {
    raw.close();
    await app.close();
    await rm(file, { force: true });
  });

  async function guest(name: string): Promise<{ token: string; id: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/guest',
      payload: { name },
    });
    const body = response.json() as { token: string; user: { id: string } };
    return { token: body.token, id: body.user.id };
  }

  async function sprint(token: string, seed: number, moves: number): Promise<number> {
    const run = playHonestRun(seed, moves);
    await app.inject({
      method: 'POST',
      url: '/api/sprint',
      headers: { authorization: `Bearer ${token}` },
      payload: { seed, moves: run.moves },
    });
    return run.score;
  }

  function board(period: string, token?: string): Promise<{ entries: unknown[]; me: unknown }> {
    return app
      .inject({
        method: 'GET',
        url: `/api/sprint/leaderboard?period=${period}`,
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      })
      .then((response) => response.json() as { entries: unknown[]; me: unknown });
  }

  it('вчерашний рекорд держится в вечной таблице и уходит из дневной', async () => {
    const ada = await guest('Ада');
    const bob = await guest('Боб');
    const adaScore = await sprint(ada.token, 12345, 6);
    const bobScore = await sprint(bob.token, 999, 3);
    expect(adaScore).toBeGreaterThan(bobScore);

    // Оба здесь: обе таблицы видят сегодняшние заходы.
    expect((await board('day')).entries).toHaveLength(2);
    expect((await board('all')).entries).toHaveLength(2);

    // Заход Ады «состарился» на сутки.
    await raw.execute({
      sql: `UPDATE sprint_days SET day = date('now', '-1 day') WHERE user_id = ?`,
      args: [ada.id],
    });

    const today = await board('day', ada.token);
    expect(today.entries).toEqual([{ rank: 1, name: 'Боб', score: bobScore }]);
    // Своей строки у Ады сегодня нет — она сегодня не играла.
    expect(today.me).toBeNull();

    const always = await board('all', ada.token);
    expect(always.entries).toEqual([
      { rank: 1, name: 'Ада', score: adaScore },
      { rank: 2, name: 'Боб', score: bobScore },
    ]);
    expect(always.me).toEqual({ rank: 1, name: 'Ада', score: adaScore });
  });

  it('без периода отвечает вечной таблицей — как до появления дневной', async () => {
    const ada = await guest('Ада');
    const score = await sprint(ada.token, 12345, 5);
    await raw.execute({
      sql: `UPDATE sprint_days SET day = date('now', '-1 day') WHERE user_id = ?`,
      args: [ada.id],
    });

    const response = await app.inject({ method: 'GET', url: '/api/sprint/leaderboard' });
    expect((response.json() as { entries: unknown[] }).entries).toEqual([
      { rank: 1, name: 'Ада', score },
    ]);
  });

  it('в дневной таблице у игрока лучший заход дня, а не последний', async () => {
    const ada = await guest('Ада');
    const best = await sprint(ada.token, 12345, 6);
    const weaker = await sprint(ada.token, 999, 3);
    expect(weaker).toBeLessThan(best);

    expect((await board('day')).entries).toEqual([{ rank: 1, name: 'Ада', score: best }]);
  });

  it('комбо считается по тем же двум периодам', async () => {
    const ada = await guest('Ада');
    const { seed, moves, combo } = seedWithCombo(200);
    await app.inject({
      method: 'POST',
      url: '/api/combo',
      headers: { authorization: `Bearer ${ada.token}` },
      payload: { seed, moves },
    });

    const day = await app.inject({ method: 'GET', url: '/api/combo/leaderboard?period=day' });
    expect((day.json() as { entries: unknown[] }).entries).toEqual([
      { rank: 1, name: 'Ада', combo },
    ]);

    await raw.execute({
      sql: `UPDATE combo_days SET day = date('now', '-1 day') WHERE user_id = ?`,
      args: [ada.id],
    });
    const after = await app.inject({ method: 'GET', url: '/api/combo/leaderboard?period=day' });
    expect((after.json() as { entries: unknown[] }).entries).toEqual([]);

    const always = await app.inject({ method: 'GET', url: '/api/combo/leaderboard?period=all' });
    expect((always.json() as { entries: unknown[] }).entries).toEqual([
      { rank: 1, name: 'Ада', combo },
    ]);
  });
});

describe('loggedUrl', () => {
  it('срезает строку запроса: токен дуэли не должен попасть в лог', () => {
    expect(loggedUrl('/duel?token=eyJhbGciOi.secret.value')).toBe('/duel?…');
    expect(loggedUrl('/api/me')).toBe('/api/me');
    expect(loggedUrl(undefined)).toBe('');
  });
});

describe('порог гостевых аккаунтов', () => {
  it('после SIGNUP_LIMIT заходов с адреса отвечает 429', async () => {
    const app = await buildApp({ databaseUrl: ':memory:', jwtSecret: 'test-jwt' });
    // Тип ответа выводим, а не называем: у inject несколько перегрузок, и
    // ReturnType берёт из них цепочечную, а не ту, что отдаёт ответ.
    const guest = async () =>
      app.inject({ method: 'POST', url: '/api/auth/guest', payload: { name: 'Гость' } });

    for (let i = 0; i < SIGNUP_LIMIT; i++) {
      expect((await guest()).statusCode).toBe(200);
    }
    const blocked = await guest();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'too-many' });
    await app.close();
  });
});
