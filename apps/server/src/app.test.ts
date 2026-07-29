import { createHmac, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
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
import type { DuelServerMessage, MoveLog } from '@doton/protocol';
import { buildApp } from './app.js';
import { Store } from './db.js';
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

describe('миграции', () => {
  it('доливает колонку log в базу, созданную до появления призраков', async () => {
    const url = `file:${join(tmpdir(), `zaapo-migrate-${randomUUID()}.db`)}`;
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
    const url = `file:${join(tmpdir(), `zaapo-identities-${randomUUID()}.db`)}`;
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
      { id: 'ghost:Заппо:1', name: 'Заппо', score: 500, log: [{ t: 1, points: 500 }], ghost: true },
    ]);

    const [entry] = await store.duelHistory('u1', 10);
    expect(entry).toMatchObject({ opponentName: 'Заппо', opponentScore: 500, opponentGhost: true });
    // Запись призрака не должна снова стать призраком: это копия чужого темпа.
    await expect(store.pickGhostRun('u1', 500)).resolves.toBeUndefined();
    // И на сводку дуэлей строка призрака не влияет.
    await expect(store.duelRecord('u1')).resolves.toEqual({ played: 1, won: 0 });
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
      league: '9 вольт',
      // До калибровки в таблице не показываемся.
      rank: null,
      placement: { played: 0, required: 5 },
      duels: { played: 0, won: 0 },
      next: { league: 'Киловатт', gap: 100 },
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
      dailySecret: DAILY_SECRET,
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
      winner.send({ type: 'move', path, t: i });
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
