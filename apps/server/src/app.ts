import { randomInt, randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  AddFriendRequestSchema,
  AddScoreRequestSchema,
  DuelClientMessageSchema,
  FriendCodeSchema,
  GuestAuthRequestSchema,
  InviteRequestSchema,
  RenameRequestSchema,
  SubmitDailyRequestSchema,
  TelegramAuthRequestSchema,
  DateSchema,
  type AuthResponse,
  type DailyInfo,
  type DuelServerMessage,
  type DuelHistoryEntry,
  type DuelHistoryResponse,
  type FriendsResponse,
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
import { Bot, makeLinkToken, parseStart, type BotUpdate } from './bot.js';
import { dailySeed, replayDaily, todayUtc } from './daily.js';
import { Store } from './db.js';
import { DEFAULT_GHOST_SCORE, makeSyntheticGhost } from './ghost.js';
import { Matchmaker, type MatchResult } from './matchmaker.js';
import type { DuelOutcome, DuelPlayer } from './duel.js';
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
  /** Короткое имя мини-приложения из BotFather, если оно задано. */
  telegramAppName?: string;
  /** Публичный адрес сервера: по нему регистрируется вебхук бота. */
  publicUrl?: string;
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
const RECENT_OPPONENTS = 8;
/** Потолок стоимости одного хода — грубая проверка правдоподобия досыла. */
const MAX_POINTS_PER_MOVE = 20_000;

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

  const bot = options.telegramBotToken
    ? new Bot(options.telegramBotToken, options.jwtSecret, {
        ...(options.telegramAppName ? { appName: options.telegramAppName } : {}),
        onError: (error) => app.log.error(error, 'telegram api failed'),
      })
    : null;

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
        .then(() =>
          Promise.all(
            players
              .filter((player) => !player.ghost)
              .map((player) => store.addTotal(player.id, player.score)),
          ),
        )
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
      // Записей ещё нет: соперника отыгрывает «Эталон» примерно в силу игрока.
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
      // Имя из Telegram берём только при создании аккаунта. Затирать им
      // выбранное в кабинете нельзя: игрок переименовался осознанно, а
      // Telegram у него мог быть привязан вообще позже.
      return issueToken(existing.id, existing.name);
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
    // Очки уже пересчитаны ядром — засчитываем в наработку без проверок.
    await store.addTotal(user.sub, replay.score);
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
   * Досыл отсчётов из режимов без конца партии. Дуэли и вызов дня сюда не
   * ходят: их очки сервер считает сам и засчитывает у себя.
   */
  app.post('/api/me/score', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = AddScoreRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });

    const { points, moves } = parsed.data;
    // Один ход не может стоить сколько угодно: даже самая длинная цепочка
    // с каскадом линз в резонансе не даёт и близко столько.
    if (points > moves * MAX_POINTS_PER_MOVE) {
      return reply.code(400).send({ error: 'implausible' });
    }

    const result = await store.addScore(user.sub, points, moves);
    if (result === 'too-fast') return reply.code(429).send({ error: 'too-fast' });
    return result;
  });

  /** Карточка игрока: рейтинг, лига, место и сводка по дуэлям. */
  app.get('/api/me', async (request): Promise<MeResponse> => {
    const user = await requireUser(request);
    const [rating, rank, duels, identities, daily, total] = await Promise.all([
      store.ratingOf(user.sub),
      store.ratingRank(user.sub),
      store.duelRecord(user.sub),
      store.identitiesOf(user.sub),
      store.dailyRecord(user.sub),
      store.totalScore(user.sub),
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
      total,
      identities,
      daily,
    };
  });

  // ---------- Бот ----------

  /**
   * Обрабатывает `/start`, в том числе с полезной нагрузкой из ссылки:
   * `f_КОД` добавляет в друзья, `l_токен` привязывает Telegram к аккаунту,
   * заведённому в браузере на другом устройстве.
   */
  const handleStart = async (
    telegramId: string,
    name: string,
    payload: string,
  ): Promise<string> => {
    const existing = await store.userByIdentity('telegram', telegramId);

    // Привязку разбираем до создания аккаунта: иначе мы бы сначала завели
    // этому Telegram новый профиль, а потом сами же отказали в привязке,
    // сославшись на занятость — и так в самом частом случае.
    if (payload.startsWith('l_')) {
      const owner = await store.consumeLinkToken(payload.slice(2));
      if (!owner) return 'Код привязки не подошёл — он живёт десять минут. Возьми новый в профиле.';
      if (existing) {
        await store.markBotStarted(telegramId);
        return existing.id === owner
          ? 'Этот аккаунт уже привязан.'
          : 'Этот Telegram уже привязан к другому профилю. Отвяжи его там или входи под ним.';
      }
      await store.linkIdentity(owner, { kind: 'telegram', externalId: telegramId });
      await store.markBotStarted(telegramId);
      return 'Готово: теперь этот Telegram открывает твой профиль на любом устройстве.';
    }

    // Само нажатие Start — разрешение писать: до него бот молчит.
    const user =
      existing ??
      (await store.createUser(randomUUID(), name, { kind: 'telegram', externalId: telegramId }));
    await store.markBotStarted(telegramId);

    if (payload.startsWith('f_')) {
      const friend = await store.userByFriendCode(payload.slice(2).toUpperCase());
      if (!friend) return 'Такого кода друга нет — проверь ссылку.';
      if (friend.id === user.id) return 'Это твой собственный код.';
      await store.addFriend(user.id, friend.id);
      return `${friend.name} теперь у тебя в друзьях. Зови на дуэль!`;
    }

    return (
      'dotoscope — прибор для наблюдения за круглыми объектами.\n' +
      'Соединяй точки, шлифуй линзы, вызывай друзей на дуэль.\n\n' +
      'ROUND THINGS INC'
    );
  };

  if (bot) {
    app.post('/telegram/webhook', async (request, reply) => {
      // Адрес вебхука знает только Telegram, но открытый эндпоинт всё
      // равно нужно защитить: секрет приходит заголовком.
      if (!bot.matchesSecret(request.headers['x-telegram-bot-api-secret-token'] as string)) {
        return reply.code(401).send({ error: 'bad-secret' });
      }

      const update = request.body as BotUpdate;
      const message = update.message;
      const payload = parseStart(message?.text);
      const telegramId = message?.from?.id;
      if (payload === null || telegramId === undefined) return { ok: true };

      const name = message?.from?.username || message?.from?.first_name || `tg${telegramId}`;
      try {
        const answer = await handleStart(String(telegramId), name, payload);
        const link = bot.miniAppLink('');
        await bot.sendMessage(
          String(message?.chat?.id ?? telegramId),
          answer,
          link ? { text: '🔭 Открыть прибор', url: link } : undefined,
        );
      } catch (error) {
        // Ошибку Telegram не увидит: повтор доставки только продублировал
        // бы действие, а /start у нас идемпотентен.
        app.log.error(error, 'telegram start failed');
      }
      return { ok: true };
    });

    // Имя бота нужно клиенту для ссылок-приглашений; вебхук ставим сами,
    // чтобы после деплоя не оставалось ручных шагов.
    void bot.resolveUsername().then(async (username) => {
      app.log.info({ username }, 'telegram bot connected');
      if (!options.publicUrl) return;
      const url = new URL('/telegram/webhook', options.publicUrl).toString();
      const ok = await bot.setWebhook(url);
      app.log.info({ url, ok }, 'telegram webhook registered');
    });
  }

  /** Что клиенту нужно знать о сервере: как построить ссылки в Telegram. */
  app.get('/api/config', (): { bot: string | null; miniApp: string | null } => ({
    bot: bot?.knownUsername ?? null,
    miniApp: bot?.miniAppLink('') ?? null,
  }));

  // ---------- Друзья ----------

  /** Список друзей с личным счётом и те, с кем недавно играли. */
  app.get('/api/me/friends', async (request): Promise<FriendsResponse> => {
    const user = await requireUser(request);
    const [code, friends, versus, recent] = await Promise.all([
      store.friendCodeOf(user.sub),
      store.friendsOf(user.sub),
      store.headToHead(user.sub),
      store.recentOpponents(user.sub, RECENT_OPPONENTS),
    ]);
    return {
      code: code ?? '',
      friends: friends
        .filter((friend): friend is typeof friend & { code: string } => friend.code !== null)
        .map((friend) => ({
          code: friend.code,
          name: friend.name,
          rating: friend.rating,
          league: leagueOf(friend.rating).name,
          record: versus.get(friend.id) ?? { played: 0, won: 0 },
          provisional: friend.ratedGames < PLACEMENT_GAMES,
        })),
      recent,
    };
  });

  app.post('/api/friends', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = AddFriendRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-code' });

    const friend = await store.userByFriendCode(parsed.data.code);
    if (!friend) return reply.code(404).send({ error: 'no-such-code' });
    if (friend.id === user.sub) return reply.code(400).send({ error: 'self' });

    // Повторное добавление не ошибка: кнопка могла нажаться дважды.
    await store.addFriend(user.sub, friend.id);
    return { name: friend.name, code: parsed.data.code };
  });

  /**
   * Код привязки Telegram. Нужен, когда игра открыта в браузере на другом
   * устройстве: там initData взять неоткуда, и без этого у человека
   * появился бы второй аккаунт.
   */
  app.post('/api/me/link/telegram', async (request, reply) => {
    const user = await requireUser(request);
    if (!bot) return reply.code(503).send({ error: 'telegram-disabled' });

    const token = makeLinkToken();
    await store.createLinkToken(user.sub, token);
    const url = bot.startLink(`l_${token}`);
    if (!url) return reply.code(503).send({ error: 'telegram-disabled' });
    return { url };
  });

  /**
   * Зовёт друга в комнату сообщением в Telegram. Не всем можно написать:
   * бот не пишет первым тому, кто его не запускал, — тогда честно говорим
   * об этом, и клиент предлагает переслать ссылку руками.
   */
  app.post('/api/friends/:code/invite', async (request, reply) => {
    const user = await requireUser(request);
    const parsedCode = FriendCodeSchema.safeParse((request.params as { code: string }).code);
    const parsedBody = InviteRequestSchema.safeParse(request.body);
    if (!parsedCode.success || !parsedBody.success) {
      return reply.code(400).send({ error: 'bad-request' });
    }
    if (!bot) return reply.code(503).send({ error: 'telegram-disabled' });

    const friend = await store.userByFriendCode(parsedCode.data);
    if (!friend) return reply.code(404).send({ error: 'no-such-code' });
    // Звать можно только друзей — иначе рассылку получил бы кто угодно.
    if (!(await store.areFriends(user.sub, friend.id))) {
      return reply.code(403).send({ error: 'not-a-friend' });
    }

    const chat = await store.botChatOf(friend.id);
    const link = bot.miniAppLink(parsedBody.data.room);
    if (!chat || !link) return reply.code(409).send({ error: 'no-telegram' });

    const sent = await bot.sendMessage(chat, `${user.name} зовёт тебя к прибору — дуэль в dotoscope.`, {
      text: '🔭 Принять вызов',
      url: link,
    });
    if (!sent) return reply.code(409).send({ error: 'not-delivered' });
    return { ok: true };
  });

  app.delete('/api/friends/:code', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = FriendCodeSchema.safeParse((request.params as { code: string }).code);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-code' });

    const friend = await store.userByFriendCode(parsed.data);
    if (!friend) return reply.code(404).send({ error: 'no-such-code' });
    await store.removeFriend(user.sub, friend.id);
    return { ok: true };
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

    const player: DuelPlayer = {
      id: user.sub,
      name: user.name,
      send: (message: DuelServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
    };

    // Код друга нужен сопернику на экране результата. Читаем один раз при
    // подключении: к моменту подбора он уже на месте.
    void store
      .friendCodeOf(user.sub)
      .then((code) => {
        if (code) player.code = code;
      })
      .catch((error: unknown) => app.log.error(error, 'friend code lookup failed'));

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
    // Токен бота задаётся переменной окружения — так видно, доехал ли он,
    // не залезая в логи. Само значение, разумеется, не показываем.
    telegram: bot !== null,
    bot: bot?.knownUsername ?? null,
    ...matchmaker.stats,
  }));

  return app;
}
