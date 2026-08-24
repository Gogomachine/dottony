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
  startOrder,
  tapOrder,
  STICKER_PRICE,
  SLOT_PRICES,
  ART_LEN,
  OWN_MARK,
  OWN_PRICE,
  MARKS,
  MARK_SLOTS,
  FRAMES,
  slotItem,
  FRAME_PRICE,
  FACES,
  MARK_BIG,
  MARK_STREAK,
  tapGroup,
  DEFAULT_CONFIG,
  type Board,
  type Cell,
  type Color,
  type OrderRun,
} from '@doton/core';
import type {
  AdminCard,
  AdminFindResponse,
  AdminLogResponse,
  DuelServerMessage,
  MeResponse,
  MoveLog,
  OrderLeaderboardResponse,
  OrderMove,
} from '@doton/protocol';
import { buildApp, loggedUrl } from './app.js';
import { INVITE_LIMIT } from './limits.js';
import { parseStart } from './bot.js';
import { Store } from './db.js';
import { replayOrder } from './order.js';
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
 * Самая большая снимаемая группа: цвета окна, если `mine`, иначе любого
 * другого. По ней и играют заказы — растят пятно, разбирая всё вокруг.
 */
function biggestGroup(run: OrderRun, mine: boolean): { cell: Cell; size: number } | null {
  const cfg = DEFAULT_CONFIG;
  let best: { cell: Cell; size: number } | null = null;
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      const color = run.board.grid[r]![c]!.color;
      if (mine ? color !== run.color : color === run.color) continue;
      const size = tapGroup(run.board, { r, c }, cfg).length;
      if (size >= cfg.minChain && (best === null || size > best.size)) best = { cell: { r, c }, size };
    }
  }
  return best;
}

/**
 * Честный заход заказов: разбираем чужие цвета, пока пятно нужного не
 * дорастёт до цели, и тогда жмём. Возвращает ходы и то, что насчитало ядро.
 */
function playOrderRun(
  seed: number,
  movesCount: number,
  step = 0.2,
): { moves: OrderMove[]; score: number; orders: number } {
  const cfg = DEFAULT_CONFIG;
  let run: OrderRun = startOrder(seed, cfg);
  const moves: OrderMove[] = [];
  let t = 0;
  for (let i = 0; i < movesCount && !run.over; i++) {
    const mine = biggestGroup(run, true);
    const cell =
      mine !== null && mine.size >= cfg.orderTarget
        ? mine.cell
        : (biggestGroup(run, false)?.cell ?? mine?.cell ?? null);
    if (cell === null) break;
    t = Number((t + step).toFixed(3));
    const out = tapOrder(run, cell, t, cfg);
    if (typeof out === 'string') break;
    run = out.run;
    moves.push({ cell, t });
  }
  return { moves, score: run.score, orders: run.orders };
}

/** Заход, в котором заказ хотя бы раз закрыт: на нём и проверяем таблицу. */
function seedWithOrders(minimum: number): {
  seed: number;
  moves: OrderMove[];
  score: number;
  orders: number;
} {
  for (let seed = 1; seed < 60; seed++) {
    const run = playOrderRun(seed, 90);
    if (run.orders >= minimum) return { seed, ...run };
  }
  throw new Error('no seed with orders found');
}

/** Заход, где до цели не дотянули: счёт нулевой, окна уходят впустую. */
function emptyOrderRun(seed: number): { moves: OrderMove[]; score: number } {
  const cfg = DEFAULT_CONFIG;
  let run: OrderRun = startOrder(seed, cfg);
  const moves: OrderMove[] = [];
  let t = 0;
  for (let i = 0; i < 6 && !run.over; i++) {
    const cell = biggestGroup(run, false)?.cell ?? biggestGroup(run, true)?.cell;
    if (!cell) break;
    t = Number((t + 0.3).toFixed(3));
    const out = tapOrder(run, cell, t, cfg);
    if (typeof out === 'string') break;
    run = out.run;
    moves.push({ cell, t });
  }
  return { moves, score: run.score };
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

describe('replayOrder', () => {
  it('насчитывает тот же счёт, что и честный заход', () => {
    const { seed, moves, score, orders } = seedWithOrders(1);
    expect(score).toBeGreaterThan(0);
    const replayed = replayOrder(seed, moves);
    if (typeof replayed === 'string') throw new Error(replayed);
    expect(replayed.score).toBe(score);
    expect(replayed.orders).toBe(orders);
    // Лучшее в заходе: серия не длиннее числа закрытых заказов, а самая
    // крупная снятая группа не меньше цели.
    expect(replayed.streak).toBeGreaterThan(0);
    expect(replayed.streak).toBeLessThanOrEqual(orders);
    expect(replayed.biggest).toBeGreaterThanOrEqual(DEFAULT_CONFIG.orderTarget);
  });

  it('счёт растёт только закрытыми заказами', () => {
    const { seed, moves, score } = seedWithOrders(1);
    const partial = replayOrder(seed, moves.slice(0, 1));
    if (typeof partial === 'string') throw new Error(partial);
    // Первый ход пятно только растит: заказ им не закрыть.
    expect(partial.score).toBe(0);
    expect(partial.orders).toBe(0);
    expect(partial.biggest).toBe(0);
    expect(score).toBeGreaterThan(partial.score);
  });

  it('заход без заказов ничего не стоит', () => {
    const empty = emptyOrderRun(7);
    expect(empty.score).toBe(0);
    expect(replayOrder(7, empty.moves)).toEqual({ score: 0, orders: 0, streak: 0, biggest: 0 });
  });

  it('пустые окна кончают заход, и ходы после конца не в счёт', () => {
    const cfg = DEFAULT_CONFIG;
    const { seed, moves } = seedWithOrders(1);
    // Тот же журнал, но с зазором в целое окно между ходами: каждый ход
    // приходит уже в новом окне, и запас сбоев кончается на третьем.
    const lazy = moves.map((move, index) => ({ ...move, t: (index + 1) * (cfg.orderWindow + 1) }));
    const replayed = replayOrder(seed, lazy);
    if (typeof replayed === 'string') throw new Error(replayed);
    expect(replayed.orders).toBe(0);
    expect(replayed.score).toBe(0);
  });

  it('отклоняет нечеловеческий темп', () => {
    const { seed, moves } = seedWithOrders(1);
    expect(replayOrder(seed, moves.map((move) => ({ ...move, t: 1 })))).toBe('bad-timing');
  });

  it('отклоняет ход по клетке, где группы нет', () => {
    const cfg = DEFAULT_CONFIG;
    const run = startOrder(1, cfg);
    let lonely: Cell | null = null;
    for (let r = 0; r < cfg.rows && lonely === null; r++) {
      for (let c = 0; c < cfg.cols && lonely === null; c++) {
        if (tapGroup(run.board, { r, c }, cfg).length < cfg.minChain) lonely = { r, c };
      }
    }
    if (lonely === null) throw new Error('нет одиночной точки');
    expect(replayOrder(1, [{ cell: lonely, t: 1 }])).toBe('invalid-move');
  });

  it('часы захода не ограничены тремя минутами', () => {
    const { seed, moves } = seedWithOrders(1);
    const late = moves.map((move) => ({ ...move, t: move.t + 3600 }));
    expect(typeof replayOrder(seed, late)).not.toBe('string');
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
      store.saveDuel('d1', 42, 'chain', [{ id: 'u1', score: 300, log: [{ t: 1, points: 300 }] }]),
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

  it('имя бота приходит в конфиг с первого же запроса, а не когда успеет', async () => {
    // Раньше имя узнавали при старте, не дожидаясь ответа Telegram. На
    // спящем хостинге сервер будит первый же запрос игрока, и клиент
    // успевал спросить конфиг раньше, чем приезжало имя: привязка Telegram
    // молча пропадала до перезагрузки страницы.
    //
    // Медленный ответ Telegram здесь и воспроизводит ту гонку: без ожидания
    // конфиг ответил бы «бота нет».
    let asked = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      const method = String(url).split('/').pop() ?? '';
      if (method !== 'getMe') {
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      asked += 1;
      await new Promise((done) => setTimeout(done, 50));
      return new Response(JSON.stringify({ ok: true, result: { username: 'dotoscope_bot' } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const cold = await buildApp({
      databaseUrl: ':memory:',
      jwtSecret: JWT,
      telegramBotToken: BOT_TOKEN,
    });
    try {
      const config = await cold.inject({ method: 'GET', url: '/api/config' });
      expect(config.json()).toEqual({
        bot: 'dotoscope_bot',
        miniApp: 'https://t.me/dotoscope_bot?startapp=',
      });
      // Спрошенное имя держим, а пока ответ в пути — ждём один запрос на
      // всех: наплыв после пробуждения не должен стать наплывом на Telegram.
      expect(asked).toBe(1);
      await cold.inject({ method: 'GET', url: '/api/config' });
      expect(asked).toBe(1);
    } finally {
      await cold.close();
    }
  });

  it('без бота конфиг честно пуст, а не молчит', async () => {
    const bare = await buildApp({ databaseUrl: ':memory:', jwtSecret: JWT });
    try {
      const config = await bare.inject({ method: 'GET', url: '/api/config' });
      expect(config.json()).toEqual({ bot: null, miniApp: null });
    } finally {
      await bare.close();
    }
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

  it('имя меняется один раз: вторая попытка не проходит', async () => {
    const enter = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/telegram',
        payload: { initData: signedInitData({ id: 778, username: 'cucumber' }) },
      });
    const first = (await enter()).json() as { token: string; user: { name: string } };
    const me = async (token: string): Promise<{ name: string; canRename: boolean }> =>
      (
        await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json() as { name: string; canRename: boolean };
    const put = (token: string, name: string) =>
      app.inject({
        method: 'POST',
        url: '/api/me/name',
        headers: { authorization: `Bearer ${token}` },
        payload: { name },
      });

    // Имя из Telegram заменой не считается: игрок своего ещё не давал.
    expect(await me(first.token)).toMatchObject({ name: 'cucumber', canRename: true });

    const renamed = await put(first.token, 'Огурец');
    expect(renamed.statusCode).toBe(200);
    const token = (renamed.json() as { token: string }).token;
    expect(await me(token)).toMatchObject({ name: 'Огурец', canRename: false });

    // Вторая замена отклоняется, и имя остаётся прежним.
    const again = await put(token, 'Огурец Второй');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'rename-used' });
    expect(await me(token)).toMatchObject({ name: 'Огурец', canRename: false });

    // Новый вход из Telegram замену не возвращает: она на аккаунте, а не
    // на устройстве.
    const back = (await enter()).json() as { token: string };
    expect(await me(back.token)).toMatchObject({ name: 'Огурец', canRename: false });
  });

  it('имя держится за аккаунтом Telegram, а не берётся заново из профиля', async () => {
    // Новый вход из Telegram — это открытие мини-приложения заново: токена у
    // клиента может не быть вовсе, и аккаунт находится по одному initData.
    const enter = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/telegram',
        payload: { initData: signedInitData({ id: 777, username: 'cucumber' }) },
      });
    const first = (await enter()).json() as { token: string; user: { name: string } };
    // При заведении аккаунта имя берётся из Telegram: своего игрок ещё не дал.
    expect(first.user.name).toBe('cucumber');

    const renamed = await app.inject({
      method: 'POST',
      url: '/api/me/name',
      headers: { authorization: `Bearer ${first.token}` },
      payload: { name: 'Огурец' },
    });
    expect((renamed.json() as { user: { name: string } }).user.name).toBe('Огурец');

    // И при следующем входе, и в карточке стоит выбранное игроком, а не
    // Telegram: имя оттуда берётся один раз, при заведении аккаунта.
    const again = (await enter()).json() as { token: string; user: { name: string } };
    expect(again.user.name).toBe('Огурец');
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${again.token}` },
    });
    expect((me.json() as { name: string }).name).toBe('Огурец');

    // Нажатие Start в боте имя тоже не трогает: аккаунт уже есть.
    await app.inject(update('/start', { id: 777, username: 'cucumber' }));
    const afterStart = (await enter()).json() as { user: { name: string } };
    expect(afterStart.user.name).toBe('Огурец');
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
    // Кода в письме нет: комнату несёт кнопка, диктовать нечего.
    expect(String(sent.payload.text)).not.toContain('ROOM1234');
    const markup = sent.payload.reply_markup as { inline_keyboard: { url: string }[][] };
    expect(markup.inline_keyboard[0]![0]!.url).toBe(
      'https://t.me/dotoscope_bot?startapp=duel_ROOM1234',
    );
  });

  it('приглашение ждёт друга в самой игре, а не в Telegram', async () => {
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

    // Боб спросил про приглашения — значит он в приборе.
    const empty = await app.inject({
      method: 'GET',
      url: '/api/me/invites',
      headers: { authorization: `Bearer ${bob}` },
    });
    expect(empty.json()).toEqual({ invites: [] });

    const invite = await app.inject({
      method: 'POST',
      url: `/api/friends/${bobCode}/invite`,
      headers: { authorization: `Bearer ${ada}` },
      payload: { room: 'ROOM4242' },
    });
    // Боб в игре, поэтому в Telegram ему не пишут вовсе.
    expect(invite.statusCode).toBe(200);
    expect(invite.json()).toEqual({ ok: true, where: 'game' });

    const waiting = await app.inject({
      method: 'GET',
      url: '/api/me/invites',
      headers: { authorization: `Bearer ${bob}` },
    });
    expect(waiting.json()).toEqual({
      invites: [{ from: 'Ада', mark: null, room: 'ROOM4242' }],
    });

    // Принял или отбросил — приглашение отработало и больше не ждёт.
    await app.inject({
      method: 'DELETE',
      url: '/api/me/invites/ROOM4242',
      headers: { authorization: `Bearer ${bob}` },
    });
    const after = await app.inject({
      method: 'GET',
      url: '/api/me/invites',
      headers: { authorization: `Bearer ${bob}` },
    });
    expect(after.json()).toEqual({ invites: [] });
  });

  it('вызовы другу под счётом: десяток за час, дальше отказ', async () => {
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
    // Боб в приборе: приглашение кладётся в игру, Telegram не при чём.
    await app.inject({
      method: 'GET',
      url: '/api/me/invites',
      headers: { authorization: `Bearer ${bob}` },
    });

    const invite = (room: string) =>
      app.inject({
        method: 'POST',
        url: `/api/friends/${bobCode}/invite`,
        headers: { authorization: `Bearer ${ada}` },
        payload: { room },
      });

    for (let i = 0; i < INVITE_LIMIT; i++) {
      expect((await invite(`ROOM00${10 + i}`)).statusCode).toBe(200);
    }
    const extra = await invite('ROOM0099');
    expect(extra.statusCode).toBe(429);
    expect(extra.json()).toEqual({ error: 'too-many' });
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

describe('пороги и границы', () => {
  it('общий потолок отсекает поток запросов с одного адреса', async () => {
    const app = await buildApp({ databaseUrl: ':memory:', jwtSecret: 'test-jwt', requestLimit: 3 });
    try {
      for (let i = 0; i < 3; i++) {
        const ok = await app.inject({ method: 'GET', url: '/api/health' });
        expect(ok.statusCode).toBe(200);
      }
      const stopped = await app.inject({ method: 'GET', url: '/api/health' });
      expect(stopped.statusCode).toBe(429);
      expect(stopped.json()).toEqual({ error: 'too-many' });
      // Клиенту говорят, когда возвращаться, а не оставляют гадать.
      expect(stopped.headers['retry-after']).toBe('60');
    } finally {
      await app.close();
    }
  });

  it('список источников, если он задан, пускает только своих', async () => {
    const own = 'https://gogomachine.github.io';
    const app = await buildApp({
      databaseUrl: ':memory:',
      jwtSecret: 'test-jwt',
      allowedOrigins: [own],
    });
    try {
      const mine = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { origin: own },
      });
      expect(mine.headers['access-control-allow-origin']).toBe(own);

      const stranger = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { origin: 'https://evil.example' },
      });
      // Ответ приходит, но браузер чужой странице его не отдаст.
      expect(stranger.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('без списка источников отражается любой — так удобно в разработке', async () => {
    const app = await buildApp({ databaseUrl: ':memory:', jwtSecret: 'test-jwt' });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { origin: 'http://localhost:5173' },
      });
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    } finally {
      await app.close();
    }
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
    await store.saveDuel('d1', 42, 'chain', [
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

  it('смайлик на пропуске берётся только из набора прибора', async () => {
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

    const first = FACES[0]!;
    const second = FACES[FACES.length - 1]!;
    expect((await put(first)).statusCode).toBe(200);
    expect((await me()).avatar).toBe(first);
    expect((await put(second)).statusCode).toBe(200);
    expect((await me()).avatar).toBe(second);

    // Набор закрытый: не проходит ни слово, ни число, ни склейка из
    // нескольких знаков, ни флаг, ни типографский символ из соседнего блока
    // Юникода — тот выводится текстом, а не картинкой.
    for (const bad of ['Ада', '42', 'x🔭', '', '👨‍🚀', '🇷🇺', '★', '🏻']) {
      expect((await put(bad)).statusCode).toBe(400);
    }
    expect((await me()).avatar).toBe(second);
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
    expect(leaderboard.entries).toEqual([{ rank: 1, name: 'Вольт', score, mark: null }]);
    expect(leaderboard.me).toEqual({ rank: 1, name: 'Вольт', score, mark: null });
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

  it('заказы: заход попадает в таблицу с пересчитанным счётом', async () => {
    const { seed, moves, score, orders } = seedWithOrders(1);
    const token = await guestToken('Ада');

    const sent = await app.inject({
      method: 'POST',
      url: '/api/order',
      headers: { authorization: `Bearer ${token}` },
      payload: { seed, moves },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({ score, orders, best: score, record: true, rank: 1 });

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((me.json() as { order: unknown }).order).toEqual({ best: score, orders, rank: 1 });

    const board = await app.inject({
      method: 'GET',
      url: '/api/order/leaderboard',
      headers: { authorization: `Bearer ${token}` },
    });
    const { entries, me: mine } = board.json() as {
      entries: { name: string; score: number; rank: number }[];
      me: { rank: number; score: number } | null;
    };
    expect(entries).toEqual([{ rank: 1, name: 'Ада', score, orders, mark: null }]);
    expect(mine).toEqual({ rank: 1, name: 'Ада', score, orders, mark: null });
  });

  it('заказы: рекорд не понижается слабым заходом', async () => {
    const { seed, moves, score } = seedWithOrders(1);
    const empty = emptyOrderRun(seed);
    const token = await guestToken('Ада');
    const send = async (payload: object): Promise<unknown> => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/order',
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      return response.json();
    };

    await send({ seed, moves });
    // Заход без единого заказа: счёт нулевой, рекорд не трогает.
    const result = (await send({ seed, moves: empty.moves })) as {
      score: number;
      best: number;
      record: boolean;
    };
    expect(result.score).toBe(0);
    expect(result.record).toBe(false);
    expect(result.best).toBe(score);
  });

  it('заказы: подделанный лог не проходит', async () => {
    const token = await guestToken('Мошенник');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/order',
      headers: { authorization: `Bearer ${token}` },
      payload: { seed: 1, moves: [{ cell: { r: 0, c: 0 }, t: 1 }, { cell: { r: 0, c: 0 }, t: 1.01 }] },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).toBe('bad-timing');

    const board = await app.inject({ method: 'GET', url: '/api/order/leaderboard' });
    expect((board.json() as { entries: unknown[] }).entries).toEqual([]);
  });

  it('заказы: без токена заход не принимается', async () => {
    const { seed, moves } = seedWithOrders(1);
    const sent = await app.inject({ method: 'POST', url: '/api/order', payload: { seed, moves } });
    expect(sent.statusCode).toBe(401);
  });

  it('заказы: таблица ранжирует игроков по счёту', async () => {
    const { seed, moves, score, orders } = seedWithOrders(1);
    const empty = emptyOrderRun(seed);
    const strong = await guestToken('Сильный');
    const weak = await guestToken('Слабый');
    const send = async (token: string, payload: object): Promise<void> => {
      await app.inject({
        method: 'POST',
        url: '/api/order',
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    };

    await send(strong, { seed, moves });
    await send(weak, { seed, moves: empty.moves });

    const board = await app.inject({
      method: 'GET',
      url: '/api/order/leaderboard',
      headers: { authorization: `Bearer ${weak}` },
    });
    const { entries, me } = board.json() as {
      entries: { name: string; rank: number; score: number }[];
      me: { rank: number } | null;
    };
    // Слабый заход в вечную таблицу не попал вовсе: там нечего показывать.
    expect(entries).toEqual([{ rank: 1, name: 'Сильный', score, orders, mark: null }]);
    expect(me).toBeNull();
  });

  it('жетоны: платят за доведённый заход, и не чаще, чем заход идёт', async () => {
    const token = await guestToken('Сменщик');
    const tokensOf = async (): Promise<number> => {
      const me = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${token}` },
      });
      return (me.json() as { tokens: number }).tokens;
    };
    expect(await tokensOf()).toBe(0);

    // Отклонённый заход не заход: журнал не сошёлся — платить не за что.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/sprint',
      headers: { authorization: `Bearer ${token}` },
      payload: { seed: 777, moves: playHonestRun(777 ^ 0xdeadbeef, 5).moves },
    });
    expect(bad.statusCode).toBe(400);
    expect(await tokensOf()).toBe(0);

    const honest = playHonestRun(12345, 4);
    const sprint = await app.inject({
      method: 'POST',
      url: '/api/sprint',
      headers: { authorization: `Bearer ${token}` },
      payload: { seed: 12345, moves: honest.moves },
    });
    expect(sprint.statusCode).toBe(200);
    expect(await tokensOf()).toBe(1);

    // Второй заход подряд честен по счёту, но пришёл раньше, чем заход мог
    // закончиться, — жетон за него не дают. Счёт при этом засчитан.
    const run = seedWithOrders(1);
    const order = await app.inject({
      method: 'POST',
      url: '/api/order',
      headers: { authorization: `Bearer ${token}` },
      payload: { seed: run.seed, moves: run.moves },
    });
    expect(order.statusCode).toBe(200);
    expect((order.json() as { record: boolean }).record).toBe(true);
    expect(await tokensOf()).toBe(1);
  });

  /**
   * Даром на корпусе не носят ничего, поэтому шильдик для опытов надо
   * сперва заслужить: один заход тапа в пустой базе — это первое место дня.
   */
  async function earnMark(token: string): Promise<string> {
    const run = seedWithOrders(1);
    const sent = await app.inject({
      method: 'POST',
      url: '/api/order',
      headers: { authorization: `Bearer ${token}` },
      payload: { seed: run.seed, moves: run.moves },
    });
    expect(sent.statusCode).toBe(200);
    return 'e-order';
  }

  it('шильдики: выбор сохраняется и приходит в карточку', async () => {
    const token = await guestToken('Ада');
    const mine = await earnMark(token);

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/me/marks',
      headers: { authorization: `Bearer ${token}` },
      // Вторым номером — некупленная наклейка: своё встаёт, чужое гаснет.
      payload: { marks: [mine, 's0'] },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ marks: [mine, null, null] });

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((me.json() as { marks: unknown }).marks).toEqual([mine, null, null]);
  });

  it('шильдики: выдуманный номер и повтор не проходят', async () => {
    const token = await guestToken('Мошенник');
    const put = async (marks: unknown): Promise<unknown> => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/me/marks',
        headers: { authorization: `Bearer ${token}` },
        payload: { marks },
      });
      return response.json();
    };

    const id = await earnMark(token);
    // Номера не из каталога гасят ячейку, а не занимают её.
    expect(await put([id, 'p999', id])).toEqual({ marks: [id, null, null] });
    // Больше трёх корпус не примет вовсе.
    const тесно = await app.inject({
      method: 'PUT',
      url: '/api/me/marks',
      headers: { authorization: `Bearer ${token}` },
      payload: { marks: [id, id, id, id] },
    });
    expect(тесно.statusCode).toBe(400);
  });

  it('наклейки: без жетонов не продаются, а отметки за игру не продаются вовсе', async () => {
    const token = await guestToken('Бедный');
    const buy = async (id: string): Promise<number> => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/me/buy',
        headers: { authorization: `Bearer ${token}` },
        payload: { id },
      });
      return response.statusCode;
    };

    // Наклейка есть в продаже, но платить нечем.
    expect(await buy('s0')).toBe(402);
    // Отметка за игру и золото цены не имеют вовсе: их заслуживают.
    expect(await buy('e-order')).toBe(400);
    expect(await buy('g-sprint')).toBe(400);
    expect(await buy('s999')).toBe(400);

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((me.json() as { earned: string[] }).earned).toEqual([]);
  });

  it('оправа: чужую не надеть, купленную носят и снимают', async () => {
    const file = join(tmpdir(), `doton-frame-${randomUUID()}.db`);
    const shop = await buildApp({ databaseUrl: `file:${file}`, jwtSecret: 'test-jwt' });
    const db = createClient({ url: `file:${file}` });
    try {
      const auth = await shop.inject({
        method: 'POST',
        url: '/api/auth/guest',
        payload: { name: 'Модник' },
      });
      const token = (auth.json() as { token: string }).token;
      const wear = async (frame: string | null): Promise<{ statusCode: number }> =>
        shop.inject({
          method: 'PUT',
          url: '/api/me/frame',
          headers: { authorization: `Bearer ${token}` },
          payload: { frame },
        });
      const card = async (): Promise<{ frame: string | null; tokens: number }> => {
        const me = await shop.inject({
          method: 'GET',
          url: '/api/me',
          headers: { authorization: `Bearer ${token}` },
        });
        return me.json() as { frame: string | null; tokens: number };
      };

      // Некупленную оправу не надеть, выдуманную — тем более.
      expect((await wear('f-brass')).statusCode).toBe(400);
      expect((await wear('f-нет-такой')).statusCode).toBe(400);
      expect((await card()).frame).toBeNull();

      await db.execute(`UPDATE users SET tokens = ${FRAME_PRICE}`);
      const bought = await shop.inject({
        method: 'POST',
        url: '/api/me/buy',
        headers: { authorization: `Bearer ${token}` },
        payload: { id: 'f-brass' },
      });
      expect(bought.statusCode).toBe(200);
      expect(bought.json()).toEqual({ tokens: 0, earned: ['f-brass'], slots: 1 });

      expect((await wear('f-brass')).statusCode).toBe(200);
      expect((await card()).frame).toBe('f-brass');
      // Снять оправу — тот же запрос с пустым значением, а не отдельный.
      expect((await wear(null)).statusCode).toBe(200);
      expect((await card()).frame).toBeNull();
    } finally {
      db.close();
      await shop.close();
      await rm(file, { force: true });
    }
  });

  it('ячейки: вторая покупается, третья только после неё, закрытая не носит', async () => {
    const file = join(tmpdir(), `doton-slots-${randomUUID()}.db`);
    const shop = await buildApp({ databaseUrl: `file:${file}`, jwtSecret: 'test-jwt' });
    const db = createClient({ url: `file:${file}` });
    try {
      const auth = await shop.inject({
        method: 'POST',
        url: '/api/auth/guest',
        payload: { name: 'Хозяин корпуса' },
      });
      const token = (auth.json() as { token: string }).token;
      const buy = async (id: string): Promise<{ statusCode: number; json: () => unknown }> =>
        shop.inject({
          method: 'POST',
          url: '/api/me/buy',
          headers: { authorization: `Bearer ${token}` },
          payload: { id },
        });
      const wear = async (marks: unknown): Promise<unknown> => {
        const response = await shop.inject({
          method: 'PUT',
          url: '/api/me/marks',
          headers: { authorization: `Bearer ${token}` },
          payload: { marks },
        });
        return response.json();
      };
      const card = async (): Promise<{ slots: number; tokens: number }> => {
        const me = await shop.inject({
          method: 'GET',
          url: '/api/me',
          headers: { authorization: `Bearer ${token}` },
        });
        return me.json() as { slots: number; tokens: number };
      };

      // Даром открыта одна ячейка.
      expect((await card()).slots).toBe(1);

      await db.execute(`UPDATE users SET tokens = ${SLOT_PRICES[1]! + SLOT_PRICES[2]! + 2 * STICKER_PRICE + 2}`);
      expect((await buy('s0')).statusCode).toBe(200);
      expect((await buy('s1')).statusCode).toBe(200);
      // Две наклейки есть, а ячейка одна: вторая гаснет, а не занимает место.
      expect(await wear(['s0', 's1'])).toEqual({ marks: ['s0', null, null] });

      // Третью ячейку в обход второй не продают.
      expect((await buy(slotItem(2)!)).statusCode).toBe(400);
      expect((await card()).slots).toBe(1);

      const second = await buy(slotItem(1)!);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ slots: 2 });
      expect(await wear(['s0', 's1'])).toEqual({ marks: ['s0', 's1', null] });

      const third = await buy(slotItem(2)!);
      expect(third.statusCode).toBe(200);
      expect(third.json()).toMatchObject({ slots: 3 });
      // Купленную ячейку второй раз не продают.
      expect((await buy(slotItem(2)!)).statusCode).toBe(400);
      // Жетоны сняты ровно по каталогу.
      expect((await card()).tokens).toBe(2);
    } finally {
      db.close();
      await shop.close();
      await rm(file, { force: true });
    }
  });

  it('служба: посторонним дверей нет, служащему открыт пульт и журнал', async () => {
    const desk = await buildApp({
      databaseUrl: ':memory:',
      jwtSecret: 'test-jwt',
      telegramBotToken: BOT_TOKEN,
      // Служащий один, и узнают его по номеру в Telegram — не по паролю.
      adminTelegramIds: ['777'],
    });
    try {
      const byTelegram = async (id: number, name: string): Promise<string> => {
        const auth = await desk.inject({
          method: 'POST',
          url: '/api/auth/telegram',
          payload: { initData: signedInitData({ id, first_name: name, username: name }) },
        });
        return (auth.json() as { token: string }).token;
      };
      const boss = await byTelegram(777, 'Служащий');
      const player = await byTelegram(500, 'Игрок');
      const desks = { authorization: `Bearer ${boss}` };
      const theirs = { authorization: `Bearer ${player}` };

      // Обычному игроку пульта не существует — ни одной двери.
      for (const url of ['/api/admin/find?q=и', '/api/admin/card?id=1', '/api/admin/log']) {
        expect((await desk.inject({ method: 'GET', url, headers: theirs })).statusCode).toBe(404);
      }
      // И без токена тоже: незачем и знать, что пульт бывает.
      expect((await desk.inject({ method: 'GET', url: '/api/admin/log' })).statusCode).toBe(404);
      // В самой игре у служащего прав не больше: признак только в карточке.
      const mine = await desk.inject({ method: 'GET', url: '/api/me', headers: desks });
      expect((mine.json() as MeResponse).admin).toBe(true);
      const his = await desk.inject({ method: 'GET', url: '/api/me', headers: theirs });
      expect((his.json() as MeResponse).admin).toBe(false);

      // Поиск по имени находит игрока, и по нему открывается карточка.
      const found = await desk.inject({ method: 'GET', url: '/api/admin/find?q=Игрок', headers: desks });
      const list = (found.json() as AdminFindResponse).found;
      expect(list.length).toBeGreaterThan(0);
      const target = list.find((row) => row.name === 'Игрок')!;
      expect(target.identities).toContain('telegram');
      // По коду друга находится тот же самый — им и диктуют.
      const byCode = await desk.inject({
        method: 'GET',
        url: `/api/admin/find?q=${target.code}`,
        headers: desks,
      });
      expect((byCode.json() as AdminFindResponse).found[0]?.id).toBe(target.id);

      const deed = async (
        what: string,
        payload: Record<string, unknown>,
      ): Promise<{ statusCode: number }> =>
        desk.inject({ method: 'POST', url: `/api/admin/${what}`, headers: desks, payload });

      // Без причины не делается ничего: журнал без причины бесполезен.
      expect((await deed('tokens', { userId: target.id, tokens: 500 })).statusCode).toBe(400);
      expect((await deed('tokens', { userId: target.id, tokens: 500, reason: 'ок' })).statusCode).toBe(400);

      expect(
        (await deed('tokens', { userId: target.id, tokens: 500, reason: 'вернул за сбой матча' }))
          .statusCode,
      ).toBe(200);
      expect(
        (await deed('name', { userId: target.id, name: 'Игрок 2', reason: 'имя было непристойным' }))
          .statusCode,
      ).toBe(200);
      expect(
        (await deed('art/clear', { userId: target.id, reason: 'рисунок непристойный' })).statusCode,
      ).toBe(200);

      const card = await desk.inject({
        method: 'GET',
        url: `/api/admin/card?id=${target.id}`,
        headers: desks,
      });
      const after = card.json() as AdminCard;
      expect(after.tokens).toBe(500);
      expect(after.name).toBe('Игрок 2');
      expect(after.art).toBeNull();

      // Своё право на замену имени игрок при этом не потерял: за чужое
      // решение он платить не должен.
      const player2 = await desk.inject({ method: 'GET', url: '/api/me', headers: theirs });
      expect((player2.json() as MeResponse).canRename).toBe(true);

      // Всё записано: кто, кому, что и почему.
      const log = await desk.inject({ method: 'GET', url: '/api/admin/log', headers: desks });
      const entries = (log.json() as AdminLogResponse).entries;
      expect(entries).toHaveLength(3);
      expect(entries.map((row) => row.action)).toEqual(['рисунок снят', 'имя', 'жетоны']);
      for (const row of entries) {
        expect(row.admin).toBeTruthy();
        expect(row.reason.length).toBeGreaterThan(2);
        expect(row.target).toBe(target.id);
      }
      expect(entries.find((row) => row.action === 'жетоны')?.detail).toBe('0 → 500');
    } finally {
      await desk.close();
    }
  });

  it('служба: без списка служащих пульта нет ни у кого', async () => {
    const desk = await buildApp({
      databaseUrl: ':memory:',
      jwtSecret: 'test-jwt',
      telegramBotToken: BOT_TOKEN,
    });
    try {
      const auth = await desk.inject({
        method: 'POST',
        url: '/api/auth/telegram',
        payload: { initData: signedInitData({ id: 777, first_name: 'Служащий' }) },
      });
      const token = (auth.json() as { token: string }).token;
      const me = await desk.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect((me.json() as MeResponse).admin).toBe(false);
      const log = await desk.inject({
        method: 'GET',
        url: '/api/admin/log',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(log.statusCode).toBe(404);
    } finally {
      await desk.close();
    }
  });

  it('наладка: без ключа дверей нет вовсе', async () => {
    // Сервер без SERVICE_KEY отвечает так же, как на выдуманный адрес: по
    // ответу не видно, что служебный режим вообще бывает.
    const token = await guestToken('Гость');
    for (const url of ['/api/service/all', '/api/service/none', '/api/service/set']) {
      const closed = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${token}`, 'x-service-key': 'какой-нибудь' },
        payload: {},
      });
      expect(closed.statusCode).toBe(404);
    }
  });

  it('наладка: с ключом выдаёт всё, снимает всё и ставит числа — только себе', async () => {
    const shop = await buildApp({
      databaseUrl: ':memory:',
      jwtSecret: 'test-jwt',
      serviceKey: 'ключ-наладчика',
    });
    try {
      const guest = async (name: string): Promise<string> => {
        const auth = await shop.inject({
          method: 'POST',
          url: '/api/auth/guest',
          payload: { name },
        });
        return (auth.json() as { token: string }).token;
      };
      const mine = await guest('Наладчик');
      const other = await guest('Посторонний');
      const headers = { authorization: `Bearer ${mine}`, 'x-service-key': 'ключ-наладчика' };
      const call = async (
        what: string,
        payload: Record<string, number> = {},
        who: Record<string, string> = headers,
      ): Promise<{ statusCode: number }> =>
        shop.inject({ method: 'POST', url: `/api/service/${what}`, headers: who, payload });
      const card = async (token: string): Promise<MeResponse> => {
        const me = await shop.inject({
          method: 'GET',
          url: '/api/me',
          headers: { authorization: `Bearer ${token}` },
        });
        return me.json() as MeResponse;
      };

      // Чужой ключ — тот же ответ, что и без ключа: дверь не отвечает.
      expect(
        (await call('all', {}, { authorization: `Bearer ${mine}`, 'x-service-key': 'не тот' }))
          .statusCode,
      ).toBe(404);

      const all = await call('all');
      expect(all.statusCode).toBe(200);
      const opened = await card(mine);
      // На прилавке не остаётся ничего некупленного: наклейки, оправы,
      // ячейки и место под свой рисунок.
      for (const mark of MARKS) {
        if (mark.price !== undefined) expect(opened.earned).toContain(mark.id);
      }
      for (const frame of FRAMES) expect(opened.earned).toContain(frame.id);
      expect(opened.slots).toBe(MARK_SLOTS);
      expect(opened.tokens).toBeGreaterThan(1000);
      // Отметки за игру наладка не выдаёт: их не присваивают даже себе.
      expect(opened.earned).not.toContain('e-order');

      // Числа ставятся точно — по ним проверяют «не хватает» и лиги.
      expect((await call('set', { tokens: 7 })).statusCode).toBe(200);
      expect((await card(mine)).tokens).toBe(7);
      expect((await call('set', { rating: 1950, games: 5 })).statusCode).toBe(200);
      const rated = await card(mine);
      expect(rated.rating).toBe(1950);
      expect(rated.placement).toBeNull();
      expect(rated.league).toBe('Учёный');
      // Вне шкалы рейтинг не ставится: лиги для него нет.
      expect((await call('set', { rating: 99999 })).statusCode).toBe(400);

      // Снять всё — прибор глазами новичка.
      expect((await call('none')).statusCode).toBe(200);
      const bare = await card(mine);
      expect(bare.earned).toEqual([]);
      expect(bare.tokens).toBe(0);
      expect(bare.slots).toBe(1);
      expect(bare.marks).toEqual([null, null, null]);
      expect(bare.frame).toBeNull();
      expect(bare.art).toBeNull();

      // И всё это время сосед по базе не тронут: кого налаживать, говорит
      // токен, а не тело запроса, — чужой аккаунт этой дверью не достать.
      const stranger = await card(other);
      expect(stranger.earned).toEqual([]);
      expect(stranger.tokens).toBe(0);
      expect(stranger.rating).not.toBe(1950);
    } finally {
      await shop.close();
    }
  });

  it('свой шильдик: покупается за жетоны, а рисунок ставится отдельно', async () => {
    // База в файле: жетоны надо доначислить со стороны — заработать три
    // сотни заходов в тесте нельзя, их разделяет минута.
    const file = join(tmpdir(), `doton-own-${randomUUID()}.db`);
    const shop = await buildApp({ databaseUrl: `file:${file}`, jwtSecret: 'test-jwt' });
    const db = createClient({ url: `file:${file}` });
    try {
      const auth = await shop.inject({
        method: 'POST',
        url: '/api/auth/guest',
        payload: { name: 'Художник' },
      });
      const token = (auth.json() as { token: string }).token;
      const headers = { authorization: `Bearer ${token}` };
      const art = `${'0'.repeat(4)}${'.'.repeat(ART_LEN - 4)}`;
      const put = async (drawn: string): Promise<{ statusCode: number }> =>
        shop.inject({ method: 'PUT', url: '/api/me/art', headers, payload: { art: drawn } });
      const card = async (): Promise<MeResponse> => {
        const me = await shop.inject({ method: 'GET', url: '/api/me', headers });
        return me.json() as MeResponse;
      };

      // Места ещё нет — рисунок не принимают: прибор не хранит картинки тех,
      // кто ничего не покупал.
      expect((await put(art)).statusCode).toBe(403);
      expect((await card()).art).toBeNull();

      await db.execute(`UPDATE users SET tokens = ${OWN_PRICE + 2}`);
      const bought = await shop.inject({
        method: 'POST',
        url: '/api/me/buy',
        headers,
        payload: { id: OWN_MARK },
      });
      expect(bought.statusCode).toBe(200);
      expect(bought.json()).toEqual({ tokens: 2, earned: [OWN_MARK], slots: 1 });

      // Форму держим жёстко: чужая длина, незнакомая краска и пустой лист
      // отклоняются одинаково — и до того, как что-то сохранится.
      expect((await put('0'.repeat(ART_LEN - 1))).statusCode).toBe(400);
      expect((await put(`${'.'.repeat(ART_LEN - 1)}z`)).statusCode).toBe(400);
      expect((await put('.'.repeat(ART_LEN))).statusCode).toBe(400);
      expect((await card()).art).toBeNull();

      expect((await put(art)).statusCode).toBe(200);
      const me = await card();
      expect(me.art).toBe(art);
      // Купленный шильдик пускают на корпус, как любой другой.
      const worn = await shop.inject({
        method: 'PUT',
        url: '/api/me/marks',
        headers,
        payload: { marks: [OWN_MARK] },
      });
      expect(worn.json()).toEqual({ marks: [OWN_MARK, null, null] });

      // В таблице рядом с номером едет и картинка — иначе шильдик приехал бы
      // сопернику пустым.
      const run = seedWithOrders(1);
      await shop.inject({
        method: 'POST',
        url: '/api/order',
        headers,
        payload: { seed: run.seed, moves: run.moves },
      });
      const board = await shop.inject({ method: 'GET', url: '/api/order/leaderboard' });
      expect((board.json() as OrderLeaderboardResponse).entries[0]).toMatchObject({
        mark: OWN_MARK,
        art,
      });

      // Второй раз место не продают, и жетоны за него не берут. Считаем от
      // того, что есть сейчас: заход за таблицу успел доплатить жетон.
      const before = (await card()).tokens;
      const again = await shop.inject({
        method: 'POST',
        url: '/api/me/buy',
        headers,
        payload: { id: OWN_MARK },
      });
      expect(again.statusCode).toBe(409);
      expect((await card()).tokens).toBe(before);
    } finally {
      db.close();
      await shop.close();
      await rm(file, { force: true });
    }
  });

  it('наклейки: покупка снимает цену, выдаёт наклейку и второй раз не берёт', async () => {
    // База в файле: жетоны надо доначислить со стороны — заработать сотню
    // заходов в тесте нельзя, их разделяет минута.
    const file = join(tmpdir(), `doton-buy-${randomUUID()}.db`);
    const shop = await buildApp({ databaseUrl: `file:${file}`, jwtSecret: 'test-jwt' });
    const db = createClient({ url: `file:${file}` });
    try {
      const auth = await shop.inject({
        method: 'POST',
        url: '/api/auth/guest',
        payload: { name: 'Покупатель' },
      });
      const token = (auth.json() as { token: string }).token;
      await db.execute(`UPDATE users SET tokens = ${STICKER_PRICE + 3}`);

      const buy = async (): Promise<{ statusCode: number; json: () => unknown }> =>
        shop.inject({
          method: 'POST',
          url: '/api/me/buy',
          headers: { authorization: `Bearer ${token}` },
          payload: { id: 's0' },
        });

      const bought = await buy();
      expect(bought.statusCode).toBe(200);
      expect(bought.json()).toEqual({ tokens: 3, earned: ['s0'], slots: 1 });

      // Купленную наклейку теперь пускают на корпус — до покупки не пускали.
      const worn = await shop.inject({
        method: 'PUT',
        url: '/api/me/marks',
        headers: { authorization: `Bearer ${token}` },
        payload: { marks: ['s0', 's1'] },
      });
      expect(worn.json()).toEqual({ marks: ['s0', null, null] });

      // Второй раз ту же наклейку не продают, и жетоны за неё не берут.
      const again = await buy();
      expect(again.statusCode).toBe(409);
      const me = await shop.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect((me.json() as { tokens: number }).tokens).toBe(3);
    } finally {
      db.close();
      await shop.close();
      await rm(file, { force: true });
    }
  });

  it('шильдики: отметку за игру дают за первое место дня', async () => {
    const { seed, moves, score } = seedWithOrders(1);
    const token = await guestToken('Ада');
    expect(score).toBeGreaterThan(0);

    const before = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((before.json() as { earned: string[] }).earned).toEqual([]);
    // Пока не выдана — на корпус её не поставить.
    const early = await app.inject({
      method: 'PUT',
      url: '/api/me/marks',
      headers: { authorization: `Bearer ${token}` },
      payload: { marks: ['e-order'] },
    });
    expect(early.json()).toEqual({ marks: [null, null, null] });

    await app.inject({
      method: 'POST',
      url: '/api/order',
      headers: { authorization: `Bearer ${token}` },
      payload: { seed, moves },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    // Заход тут единственный, поэтому вместе с отметкой дня приезжает и
    // золото вечной таблицы — проверяем именно отметку дня.
    expect((after.json() as { earned: string[] }).earned).toContain('e-order');

    const put = await app.inject({
      method: 'PUT',
      url: '/api/me/marks',
      headers: { authorization: `Bearer ${token}` },
      payload: { marks: ['e-order'] },
    });
    expect(put.json()).toEqual({ marks: ['e-order', null, null] });
  });

  it('шильдики: золото вечной таблицы снимается, как только тебя обогнали', async () => {
    // Два захода на разных сидах: слабый и заведомо сильнее его.
    const weak = seedWithOrders(1);
    let strong: { seed: number; moves: OrderMove[]; score: number } | null = null;
    for (let seed = 1; seed < 60 && strong === null; seed++) {
      const run = playOrderRun(seed, 90);
      if (run.score > weak.score) strong = { seed, moves: run.moves, score: run.score };
    }
    if (strong === null) throw new Error('no stronger run found');

    const ada = await guestToken('Ада');
    const bob = await guestToken('Боб');
    const send = async (token: string, run: { seed: number; moves: OrderMove[] }): Promise<void> => {
      await app.inject({
        method: 'POST',
        url: '/api/order',
        headers: { authorization: `Bearer ${token}` },
        payload: { seed: run.seed, moves: run.moves },
      });
    };
    const me = async (token: string): Promise<{ earned: string[]; marks: (string | null)[] }> => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${token}` },
      });
      return response.json() as { earned: string[]; marks: (string | null)[] };
    };

    // Первое место в вечной таблице — золото выдано и его можно надеть.
    await send(ada, weak);
    expect((await me(ada)).earned).toContain('g-order');
    const put = await app.inject({
      method: 'PUT',
      url: '/api/me/marks',
      headers: { authorization: `Bearer ${ada}` },
      payload: { marks: ['g-order'] },
    });
    expect(put.json()).toEqual({ marks: ['g-order', null, null] });

    // Боб обошёл — золото переехало к нему, у Ады корпус погас.
    await send(bob, strong);
    const adaNow = await me(ada);
    expect(adaNow.earned).not.toContain('g-order');
    expect(adaNow.marks).toEqual([null, null, null]);
    expect((await me(bob)).earned).toContain('g-order');

    // И в таблице у Ады золота тоже нет — соперник видит то же самое.
    const board = await app.inject({ method: 'GET', url: '/api/order/leaderboard' });
    const entries = (board.json() as { entries: { name: string; mark: string | null }[] }).entries;
    expect(entries.find((entry) => entry.name === 'Ада')?.mark).toBeNull();

    // Место вернулось — вернулось и золото: выбор в базе никто не стирал.
    await send(ada, { seed: strong.seed, moves: strong.moves });
    const adaBack = await me(ada);
    expect(adaBack.earned).toContain('g-order');
    expect(adaBack.marks).toEqual(['g-order', null, null]);
  });

  it('шильдики: крупная группа и серия окон дают свои отметки', async () => {
    const { seed, moves } = seedWithOrders(1);
    const replayed = replayOrder(seed, moves);
    if (typeof replayed === 'string') throw new Error(replayed);
    const token = await guestToken('Ада');

    await app.inject({
      method: 'POST',
      url: '/api/order',
      headers: { authorization: `Bearer ${token}` },
      payload: { seed, moves },
    });

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const earned = (me.json() as { earned: string[] }).earned;
    // Что заход заслужил, то и выдано: лишнего прибор не даёт.
    expect(earned.includes('e-big')).toBe(replayed.biggest >= MARK_BIG);
    expect(earned.includes('e-run')).toBe(replayed.streak >= MARK_STREAK);
  });

  it('шильдики: без токена не поставить', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/me/marks',
      payload: { marks: ['e-order'] },
    });
    expect(response.statusCode).toBe(401);
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

  it('остановка сервера не теряет матч: игроки видят итог, база его помнит', async () => {
    // Своя база в файле: после остановки в неё надо будет заглянуть.
    const file = join(tmpdir(), `doton-stop-${randomUUID()}.db`);
    const server = await buildApp({
      databaseUrl: `file:${file}`,
      jwtSecret: 'test-jwt',
      duelGhosts: false,
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const where = `127.0.0.1:${address.port}`;

    const enter = async (name: string): Promise<{ token: string; id: string }> => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/guest',
        payload: { name },
      });
      const body = response.json() as { token: string; user: { id: string } };
      return { token: body.token, id: body.user.id };
    };
    const ada = await enter('Ада');
    const bob = await enter('Боб');

    const first = await Client.open(where, ada.token);
    const second = await Client.open(where, bob.token);
    first.send({ type: 'join', kind: 'chain' });
    await first.wait((message) => message.type === 'searching');
    second.send({ type: 'join', kind: 'chain' });
    const matched = await second.wait<Extract<DuelServerMessage, { type: 'matched' }>>(
      (message) => message.type === 'matched',
    );
    first.send({ type: 'move', path: findAnyChain(createBoard(seedRng(matched.seed), DEFAULT_CONFIG)) });
    await first.wait((message) => message.type === 'accepted');

    // Выкладка посреди матча: сервер получает SIGTERM и закрывается.
    await server.close();

    // Игроки получили обычный итог, а не молчание в оборванном сокете.
    const outcome = await first.wait<Finished>((message) => message.type === 'finished');
    expect(outcome.outcome).toBe('win');
    expect(outcome.score).toBeGreaterThan(0);
    await second.wait<Finished>((message) => message.type === 'finished');
    first.close();
    second.close();

    // И матч дописан в базу: закрытие дождалось записи.
    const store = new Store({ url: `file:${file}` });
    try {
      const history = await store.duelHistory(ada.id, 10);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ opponentName: 'Боб', outcome: 'win', kind: 'chain' });
      expect(history[0]?.score).toBeGreaterThan(0);
    } finally {
      store.close();
      await rm(file, { force: true });
    }
  });

  /**
   * Сводит двух игроков и завершает матч сдачей первого — исход предсказуем.
   * Возвращает итоговые сообщения с рейтингом (в нерейтинговом матче — null).
   */
  async function playDuel(
    tokens: [string, string],
    options: { room?: string; rated?: boolean; moves?: number; kind?: 'chain' | 'order' } = {},
  ): Promise<{ loser: Finished | null; winner: Finished | null }> {
    const loser = await Client.open(base, tokens[0]);
    const winner = await Client.open(base, tokens[1]);
    const kind = options.kind ?? 'chain';
    const join = options.room
      ? { type: 'join', room: options.room, kind }
      : { type: 'join', kind };
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
    // В заказах ход — одно касание, и группу под ним считает сервер.
    let board = createBoard(seedRng(matched.seed), DEFAULT_CONFIG);
    for (let i = 0; i < (kind === 'order' ? 1 : (options.moves ?? 2)); i++) {
      if (kind === 'order') {
        winner.send({ type: 'move', path: [{ r: 0, c: 0 }] });
        await winner.wait((message) => message.type === 'accepted' || message.type === 'rejected');
        continue;
      }
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
    };
    expect(card.rating).toBe(winner!.rating!.after);
    expect(card.duels).toEqual({ played: 1, won: 1 });
    // Одна победа лигу не даёт: сначала калибровка.
    expect(card.rank).toBeNull();
    expect(card.placement).toEqual({ played: 1, required: 5 });
    expect(winner!.rating!.placement).toEqual({ played: 1, required: 5 });

    const board = await app.inject({ method: 'GET', url: '/api/rating' });
    expect((board.json() as { entries: unknown[] }).entries).toEqual([]);
  });

  it('жетоны: матч оплачивают обоим — и победителю, и проигравшему', async () => {
    const tokens: [string, string] = [await guest('Проигравший'), await guest('Победитель')];
    await playDuel(tokens);

    // Рейтинг досылают после записи матча, поэтому к этому мигу жетоны
    // уже начислены: отдельного ожидания не нужно.
    for (const token of tokens) {
      const me = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect((me.json() as { tokens: number }).tokens).toBe(1);
    }
  });

  it('дуэль на заказах двигает свой рейтинг, а не рейтинг цепочек', async () => {
    const tokens: [string, string] = [await guest('Слабый'), await guest('Сильный')];
    const { winner } = await playDuel(tokens, { kind: 'order' });
    expect(winner!.rating!.after).toBeGreaterThan(winner!.rating!.before);

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${tokens[1]}` },
    });
    const card = me.json() as {
      rating: number;
      orderDuel: { rating: number; placement: { played: number } | null };
    };
    // Рейтинг заказов вырос, рейтинг цепочек остался нетронутым.
    expect(card.orderDuel.rating).toBe(winner!.rating!.after);
    expect(card.orderDuel.rating).toBeGreaterThan(1500);
    expect(card.rating).toBe(1500);
    expect(card.orderDuel.placement).toEqual({ played: 1, required: 5 });

    // И таблицы у механик разные: в цепочках этого матча как не бывало.
    const chain = await app.inject({ method: 'GET', url: '/api/rating' });
    const order = await app.inject({ method: 'GET', url: '/api/rating?kind=order' });
    expect((chain.json() as { entries: unknown[] }).entries).toEqual([]);
    expect((order.json() as { entries: unknown[] }).entries).toEqual([]);
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
    expect(today.entries).toEqual([{ rank: 1, name: 'Боб', score: bobScore, mark: null }]);
    // Своей строки у Ады сегодня нет — она сегодня не играла.
    expect(today.me).toBeNull();

    const always = await board('all', ada.token);
    expect(always.entries).toEqual([
      { rank: 1, name: 'Ада', score: adaScore, mark: null },
      { rank: 2, name: 'Боб', score: bobScore, mark: null },
    ]);
    expect(always.me).toEqual({ rank: 1, name: 'Ада', score: adaScore, mark: null });
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
      { rank: 1, name: 'Ада', score, mark: null },
    ]);
  });

  it('в дневной таблице у игрока лучший заход дня, а не последний', async () => {
    const ada = await guest('Ада');
    const best = await sprint(ada.token, 12345, 6);
    const weaker = await sprint(ada.token, 999, 3);
    expect(weaker).toBeLessThan(best);

    expect((await board('day')).entries).toEqual([{ rank: 1, name: 'Ада', score: best, mark: null }]);
  });

  it('заказы считаются по тем же двум периодам', async () => {
    const ada = await guest('Ада');
    const { seed, moves, score, orders } = seedWithOrders(1);
    await app.inject({
      method: 'POST',
      url: '/api/order',
      headers: { authorization: `Bearer ${ada.token}` },
      payload: { seed, moves },
    });

    const day = await app.inject({ method: 'GET', url: '/api/order/leaderboard?period=day' });
    expect((day.json() as { entries: unknown[] }).entries).toEqual([
      { rank: 1, name: 'Ада', score, orders, mark: null },
    ]);

    await raw.execute({
      sql: `UPDATE order_days SET day = date('now', '-1 day') WHERE user_id = ?`,
      args: [ada.id],
    });
    const after = await app.inject({ method: 'GET', url: '/api/order/leaderboard?period=day' });
    expect((after.json() as { entries: unknown[] }).entries).toEqual([]);

    const always = await app.inject({ method: 'GET', url: '/api/order/leaderboard?period=all' });
    expect((always.json() as { entries: unknown[] }).entries).toEqual([
      { rank: 1, name: 'Ада', score, orders, mark: null },
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
