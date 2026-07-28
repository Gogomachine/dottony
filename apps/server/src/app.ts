import { randomInt, randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  DuelClientMessageSchema,
  GuestAuthRequestSchema,
  SubmitDailyRequestSchema,
  TelegramAuthRequestSchema,
  DateSchema,
  type AuthResponse,
  type DailyInfo,
  type DuelServerMessage,
  type LeaderboardResponse,
  type SubmitDailyResponse,
} from '@doton/protocol';
import { dailySeed, replayDaily, todayUtc } from './daily.js';
import { Store } from './db.js';
import { DEFAULT_GHOST_SCORE, makeSyntheticGhost } from './ghost.js';
import { Matchmaker } from './matchmaker.js';
import { verifyTelegramInitData } from './telegram.js';

export interface AppOptions {
  /** Строка подключения libSQL: ':memory:', 'file:doton.db' или 'libsql://…'. */
  databaseUrl: string;
  databaseAuthToken?: string;
  jwtSecret: string;
  /** Секрет сида дня: без него завтрашнее поле можно вычислить заранее. */
  dailySecret: string;
  /** Токен бота — включает вход через Telegram. */
  telegramBotToken?: string;
  /** Матчи против записей, когда живого соперника нет (по умолчанию включены). */
  duelGhosts?: boolean;
  /** Сколько ждать живого соперника до призрака, мс. */
  ghostAfterMs?: number;
}

interface TokenPayload {
  sub: string;
  name: string;
}

const LEADERBOARD_SIZE = 50;

/** Собирает приложение и готовит схему БД. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const store = new Store(
    options.databaseAuthToken
      ? { url: options.databaseUrl, authToken: options.databaseAuthToken }
      : { url: options.databaseUrl },
  );
  await store.migrate();

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: options.jwtSecret });
  await app.register(websocket);

  const matchmaker = new Matchmaker({
    onFinish: (result) => {
      // Призрака в базу не пишем: он не игрок, и его «результат» уже там есть.
      const players = result.players.filter((player) => !player.ghost);
      if (players.length === 0) return;
      void store
        .saveDuel(result.duelId, result.seed, players)
        .catch((error: unknown) => app.log.error(error, 'failed to save duel'));
    },
    findGhost: async (playerId) => {
      if (options.duelGhosts === false) return undefined;
      const average = await store.averageDuelScore(playerId);
      const target = average ?? DEFAULT_GHOST_SCORE;
      const recorded = await store.pickGhostRun(playerId, target);
      if (recorded) {
        try {
          return {
            name: recorded.name,
            seed: recorded.seed,
            score: recorded.score,
            log: JSON.parse(recorded.log) as { t: number; points: number }[],
          };
        } catch {
          // Битая запись — лучше синтетический соперник, чем пустое ожидание.
        }
      }
      // Записей ещё нет: соперника отыгрывает Заппо примерно в силу игрока.
      return makeSyntheticGhost(randomInt(0, 0xffffffff), Math.round(target));
    },
    ...(options.ghostAfterMs === undefined ? {} : { ghostAfterMs: options.ghostAfterMs }),
  });

  app.addHook('onClose', () => {
    matchmaker.close();
    store.close();
  });

  const requireUser = async (request: FastifyRequest): Promise<TokenPayload> => {
    await request.jwtVerify();
    return request.user as TokenPayload;
  };

  const issueToken = (id: string, name: string): AuthResponse => ({
    token: app.jwt.sign({ sub: id, name } satisfies TokenPayload),
    user: { id, name },
  });

  // ---------- Авторизация ----------

  app.post('/api/auth/guest', async (request, reply) => {
    const parsed = GuestAuthRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const user = await store.createUser(randomUUID(), parsed.data.name);
    return issueToken(user.id, user.name);
  });

  app.post('/api/auth/telegram', async (request, reply) => {
    if (!options.telegramBotToken) {
      return reply.code(503).send({ error: 'telegram-auth-disabled' });
    }
    const parsed = TelegramAuthRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });

    const tgUser = verifyTelegramInitData(parsed.data.initData, options.telegramBotToken);
    if (!tgUser) return reply.code(401).send({ error: 'bad-init-data' });

    const existing = await store.userByTelegramId(tgUser.id);
    if (existing) {
      // Имя в Telegram могло смениться — держим свежее.
      if (existing.name !== tgUser.name) await store.renameUser(existing.id, tgUser.name);
      return issueToken(existing.id, tgUser.name);
    }
    const user = await store.createUser(randomUUID(), tgUser.name, tgUser.id);
    return issueToken(user.id, user.name);
  });

  // ---------- Ежедневный вызов ----------

  app.get('/api/daily', (): DailyInfo => {
    const date = todayUtc();
    return { date, seed: dailySeed(date, options.dailySecret) };
  });

  app.post('/api/daily/run', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = SubmitDailyRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });

    const { date, moves } = parsed.data;
    if (date !== todayUtc()) return reply.code(400).send({ error: 'not-today' });
    if (await store.hasRun(user.sub, date)) {
      return reply.code(409).send({ error: 'already-played' });
    }

    const replay = replayDaily(dailySeed(date, options.dailySecret), moves);
    if (typeof replay === 'string') return reply.code(400).send({ error: replay });

    await store.insertRun(user.sub, date, replay.score, JSON.stringify(moves));
    const response: SubmitDailyResponse = {
      score: replay.score,
      rank: await store.rank(date, replay.score),
    };
    return response;
  });

  app.get('/api/daily/leaderboard', async (request, reply) => {
    const query = request.query as { date?: string };
    const date = query.date ?? todayUtc();
    if (!DateSchema.safeParse(date).success) {
      return reply.code(400).send({ error: 'bad-request' });
    }

    // Авторизация не обязательна: без токена просто не будет строки «я».
    let me: LeaderboardResponse['me'] = null;
    try {
      const user = await requireUser(request);
      const run = await store.runOf(user.sub, date);
      if (run) {
        me = { rank: await store.rank(date, run.score), name: run.name, score: run.score };
      }
    } catch {
      // нет или битый токен — гость смотрит таблицу анонимно
    }

    const runs = await store.top(date, LEADERBOARD_SIZE);
    const entries = runs.map((run, index) => ({
      rank: index + 1,
      name: run.name,
      score: run.score,
    }));
    const response: LeaderboardResponse = { date, entries, me };
    return response;
  });

  // ---------- Дуэли ----------

  app.get('/api/me/duels', async (request) => {
    const user = await requireUser(request);
    return store.duelRecord(user.sub);
  });

  /**
   * Матч идёт по WebSocket: токен передаётся в query, так как браузерный
   * WebSocket не умеет слать заголовки.
   */
  app.get('/duel', { websocket: true }, (socket, request) => {
    const { token } = request.query as { token?: string };
    let user: TokenPayload;
    try {
      user = app.jwt.verify<TokenPayload>(token ?? '');
    } catch {
      socket.send(JSON.stringify({ type: 'error', error: 'unauthorized' } satisfies DuelServerMessage));
      socket.close();
      return;
    }

    const player = {
      id: user.sub,
      name: user.name,
      send: (message: DuelServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
    };

    socket.on('message', (raw: Buffer | string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        player.send({ type: 'error', error: 'bad-json' });
        return;
      }

      const message = DuelClientMessageSchema.safeParse(parsed);
      if (!message.success) {
        player.send({ type: 'error', error: 'bad-message' });
        return;
      }

      switch (message.data.type) {
        case 'join':
          matchmaker.join(player, message.data.room);
          break;
        case 'move': {
          const outcome = matchmaker.move(player.id, message.data.path, message.data.t);
          player.send(
            outcome.ok
              ? { type: 'accepted', score: outcome.score, points: outcome.points }
              : { type: 'rejected', reason: outcome.reason },
          );
          break;
        }
        case 'leave':
          matchmaker.leave(player.id);
          break;
      }
    });

    socket.on('close', () => matchmaker.leave(player.id));
  });

  app.get('/api/health', () => ({ ok: true, ...matchmaker.stats }));

  return app;
}
