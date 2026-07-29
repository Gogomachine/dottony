import { randomInt, randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  DuelClientMessageSchema,
  GuestAuthRequestSchema,
  RenameRequestSchema,
  SubmitDailyRequestSchema,
  TelegramAuthRequestSchema,
  DateSchema,
  type AuthResponse,
  type DailyInfo,
  type DuelServerMessage,
  type DuelHistoryEntry,
  type DuelHistoryResponse,
  type LeaderboardResponse,
  type MeResponse,
  type MoveLog,
  type RatingLeaderboardResponse,
  type ReplayResponse,
  type SubmitDailyResponse,
} from '@doton/protocol';
import {
  decayDeviation,
  leagueOf,
  nextLeague,
  updateRating,
  PLACEMENT_GAMES,
  type Rating,
} from '@doton/core';
import { dailySeed, replayDaily, todayUtc } from './daily.js';
import { Store } from './db.js';
import { DEFAULT_GHOST_SCORE, makeSyntheticGhost } from './ghost.js';
import { Matchmaker, type MatchResult } from './matchmaker.js';
import type { DuelOutcome } from './duel.js';
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
  /** Логи запросов и ошибок — включаем в проде. */
  logger?: boolean;
}

interface TokenPayload {
  sub: string;
  name: string;
}

const LEADERBOARD_SIZE = 50;
const RATING_BOARD_SIZE = 50;
const HISTORY_SIZE = 20;

/** Сколько дней игрок не играл рейтинговых матчей. */
function idleDays(ratedAt: string | null): number {
  if (!ratedAt) return 0;
  const last = Date.parse(`${ratedAt.replace(' ', 'T')}Z`);
  if (Number.isNaN(last)) return 0;
  return Math.max(0, (Date.now() - last) / 86_400_000);
}

/** Собирает приложение и готовит схему БД. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const store = new Store(
    options.databaseAuthToken
      ? { url: options.databaseUrl, authToken: options.databaseAuthToken }
      : { url: options.databaseUrl },
  );
  await store.migrate();

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: options.jwtSecret });
  await app.register(websocket);

  /**
   * Пересчитывает рейтинги обоих игроков по итогу матча и сообщает им
   * новые значения. Считаем после отправки результата: игрок сразу видит
   * исход, а рейтинг «догоняет» через мгновение.
   */
  const applyRatings = async (result: MatchResult): Promise<void> => {
    if (!result.rated || result.outcomes.length !== 2) return;
    const [first, second] = result.outcomes as [DuelOutcome, DuelOutcome];

    const before = await Promise.all([
      store.ratingOf(first.playerId),
      store.ratingOf(second.playerId),
    ]);
    // Простой между матчами повышает неуверенность — так рейтинг вернувшегося
    // игрока быстрее приходит к его настоящей силе.
    const [firstBefore, secondBefore] = before.map((rating) =>
      decayDeviation(rating, idleDays(rating.ratedAt)),
    ) as [Rating, Rating];

    const updates = [
      {
        outcome: first,
        before: firstBefore,
        played: before[0]!.games,
        after: updateRating(firstBefore, secondBefore, first.outcome),
      },
      {
        outcome: second,
        before: secondBefore,
        played: before[1]!.games,
        after: updateRating(secondBefore, firstBefore, second.outcome),
      },
    ];

    await Promise.all(
      updates.map(async ({ outcome, before: was, played, after }) => {
        await store.saveRating(outcome.playerId, after);
        await store.saveRatingChange(result.duelId, outcome.playerId, was.rating, after.rating);
        outcome.player.send({
          type: 'finished',
          score: outcome.score,
          opponentScore: outcome.opponentScore,
          outcome: outcome.outcome,
          rating: {
            before: was.rating,
            after: after.rating,
            league: leagueOf(after.rating).name,
            ...(played + 1 < PLACEMENT_GAMES
              ? { placement: { played: played + 1, required: PLACEMENT_GAMES } }
              : {}),
          },
        });
      }),
    );
  };

  const matchmaker = new Matchmaker({
    onFinish: (result) => {
      const outcomes = new Map(result.outcomes.map((entry) => [entry.playerId, entry.outcome]));
      // Призрака пишем тоже — иначе в истории матч выглядел бы как игра
      // с пустотой. В подбор призраков и в рейтинг его строка не попадает:
      // там всё идёт через users, а своего аккаунта у него нет.
      const players = result.players.map((player) => {
        const outcome = outcomes.get(player.id);
        return outcome ? { ...player, outcome } : player;
      });
      // Матч без единого живого игрока сохранять незачем.
      if (players.every((player) => player.ghost)) return;
      void store
        .saveDuel(result.duelId, result.seed, players)
        .then(() => applyRatings(result))
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
    onError: (error) => app.log.error(error, 'ghost lookup failed'),
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

  /** Токен, если он есть и валиден. Для мест, где вход не обязателен. */
  const currentUser = async (request: FastifyRequest): Promise<TokenPayload | null> => {
    try {
      return await requireUser(request);
    } catch {
      return null;
    }
  };

  const issueToken = (id: string, name: string): AuthResponse => ({
    token: app.jwt.sign({ sub: id, name } satisfies TokenPayload),
    user: { id, name },
  });

  // ---------- Авторизация ----------

  app.post('/api/auth/guest', async (request, reply) => {
    const parsed = GuestAuthRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const id = randomUUID();
    // Гостевой вход — тоже способ входа: аккаунт с самого начала живёт по
    // общим правилам, и привязка Telegram или кошелька его не заменяет.
    const user = await store.createUser(id, parsed.data.name, { kind: 'guest', externalId: id });
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

    const existing = await store.userByIdentity('telegram', tgUser.id);
    if (existing) {
      // Имя в Telegram могло смениться — держим свежее.
      if (existing.name !== tgUser.name) await store.renameUser(existing.id, tgUser.name);
      return issueToken(existing.id, tgUser.name);
    }

    // Игрок уже играл гостем на этом устройстве: Telegram привязываем к тому
    // же аккаунту, иначе рейтинг и история остались бы на брошенной учётке.
    const guest = await currentUser(request);
    if (guest) {
      const linked = await store.linkIdentity(guest.sub, {
        kind: 'telegram',
        externalId: tgUser.id,
      });
      if (linked !== 'taken') return issueToken(guest.sub, guest.name);
    }

    const user = await store.createUser(randomUUID(), tgUser.name, {
      kind: 'telegram',
      externalId: tgUser.id,
    });
    return issueToken(user.id, user.name);
  });

  /** Смена имени. Токен несёт имя, поэтому выдаём новый. */
  app.post('/api/me/name', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = RenameRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    await store.renameUser(user.sub, parsed.data.name);
    return issueToken(user.sub, parsed.data.name);
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

  /** Карточка игрока: рейтинг, лига, место и сводка по дуэлям. */
  app.get('/api/me', async (request): Promise<MeResponse> => {
    const user = await requireUser(request);
    const [rating, rank, duels, identities, daily] = await Promise.all([
      store.ratingOf(user.sub),
      store.ratingRank(user.sub),
      store.duelRecord(user.sub),
      store.identitiesOf(user.sub),
      store.dailyRecord(user.sub),
    ]);
    const up = nextLeague(rating.rating);
    const league = leagueOf(rating.rating);
    return {
      name: user.name,
      rating: rating.rating,
      deviation: rating.deviation,
      league: league.name,
      leagueFrom: league.from,
      next: up ? { league: up.league.name, gap: up.gap } : null,
      rank,
      placement:
        rating.games >= PLACEMENT_GAMES
          ? null
          : { played: rating.games, required: PLACEMENT_GAMES },
      duels,
      identities,
      daily,
    };
  });

  app.get('/api/me/history', async (request): Promise<DuelHistoryResponse> => {
    const user = await requireUser(request);
    const rows = await store.duelHistory(user.sub, HISTORY_SIZE);
    return {
      entries: rows.map((row) => ({
        duelId: row.duelId,
        playedAt: row.playedAt,
        score: row.score,
        outcome: row.outcome as DuelHistoryEntry['outcome'],
        opponent: row.opponentName,
        opponentScore: row.opponentScore,
        ghost: row.opponentGhost,
        rating:
          row.ratingBefore === null || row.ratingAfter === null
            ? null
            : { before: row.ratingBefore, after: row.ratingAfter },
        replay: row.hasReplay,
      })),
    };
  });

  /** Реплей своей партии: сид поля плюс сыгранные цепочки. */
  app.get('/api/me/history/:duelId/replay', async (request, reply) => {
    const user = await requireUser(request);
    const { duelId } = request.params as { duelId: string };
    const replay = await store.duelReplay(duelId, user.sub);
    // Нет записи либо матч чужой — в обоих случаях показывать нечего.
    if (!replay) return reply.code(404).send({ error: 'no-replay' });

    let moves: MoveLog[];
    try {
      moves = JSON.parse(replay.moves) as MoveLog[];
    } catch {
      return reply.code(404).send({ error: 'no-replay' });
    }
    const response: ReplayResponse = {
      seed: replay.seed,
      moves,
      score: replay.score,
      opponent: replay.opponentName,
    };
    return response;
  });

  app.get('/api/rating', async (request): Promise<RatingLeaderboardResponse> => {
    const rows = await store.ratingLeaderboard(RATING_BOARD_SIZE);
    const entries = rows.map((row, index) => ({
      rank: index + 1,
      name: row.name,
      rating: row.rating,
      league: leagueOf(row.rating).name,
    }));

    // Токен не обязателен: гость просто увидит таблицу без своей строки.
    let me: RatingLeaderboardResponse['me'] = null;
    try {
      const user = await requireUser(request);
      const rank = await store.ratingRank(user.sub);
      if (rank !== null) {
        const rating = await store.ratingOf(user.sub);
        me = { rank, name: user.name, rating: rating.rating, league: leagueOf(rating.rating).name };
      }
    } catch {
      // нет или битый токен — смотрим таблицу анонимно
    }
    return { entries, me };
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

    // Закрытие сокета — не сдача: браузер рвёт соединение при сворачивании.
    socket.on('close', () => matchmaker.disconnect(player.id));
  });

  // ghosts в ответе позволяет с одного взгляда понять, доехал ли деплой
  // с призраками, не залезая в логи.
  app.get('/api/health', () => ({
    ok: true,
    ghosts: options.duelGhosts !== false,
    ...matchmaker.stats,
  }));

  return app;
}
