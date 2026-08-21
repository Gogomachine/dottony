import { randomInt, randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  AddFriendRequestSchema,
  AddScoreRequestSchema,
  AvatarRequestSchema,
  BuyRequestSchema,
  FrameRequestSchema,
  MarksRequestSchema,
  DuelClientMessageSchema,
  FriendCodeSchema,
  GuestAuthRequestSchema,
  InviteRequestSchema,
  RenameRequestSchema,
  SubmitOrderRequestSchema,
  SubmitSprintRequestSchema,
  TelegramAuthRequestSchema,
  type AuthResponse,
  type BuyResponse,
  type OrderLeaderboardResponse,
  type DuelServerMessage,
  type DuelHistoryEntry,
  type DuelHistoryResponse,
  type FriendsResponse,
  type InviteInfo,
  type MeResponse,
  type MoveLog,
  type OrderMove,
  type RatingLeaderboardResponse,
  type ClaimLog,
  type ReplayResponse,
  type SprintLeaderboardResponse,
  type SubmitOrderResponse,
  type SubmitSprintResponse,
} from '@doton/protocol';
import {
  cleanMarks,
  isFace,
  leagueMark,
  markAllowed,
  markPrice,
  frameAllowed,
  isFrame,
  FRAME_PRICE,
  MARK_BIG,
  MARK_DUELS,
  MARK_STREAK,
  decayDeviation,
  LEAGUES,
  leagueOf,
  nextLeague,
  updateRating,
  PLACEMENT_GAMES,
  type Rating,
} from '@doton/core';
import { Bot, makeLinkToken, parseStart, type BotUpdate } from './bot.js';
import { orderTempo, replayOrder } from './order.js';
import { replaySprint } from './sprint.js';
import { Store, type BoardPeriod } from './db.js';
import {
  INVITE_LIMIT,
  INVITE_WINDOW_MS,
  MAX_POINTS_PER_MOVE,
  RateGuard,
  REQUEST_LIMIT,
  REQUEST_WINDOW_MS,
  SignupGuard,
  TOKEN_GAP_SECONDS,
} from './limits.js';
import { DEFAULT_GHOST_SCORE, makeSyntheticGhost, type Ghost } from './ghost.js';
import { Matchmaker, type MatchResult } from './matchmaker.js';
import type { DuelOutcome, DuelPlayer } from './duel.js';
import { verifyTelegramInitData } from './telegram.js';

export interface AppOptions {
  /** Строка подключения libSQL: ':memory:', 'file:doton.db' или 'libsql://…'. */
  databaseUrl: string;
  databaseAuthToken?: string;
  jwtSecret: string;
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
  /**
   * Кому верить про адрес клиента. За балансировщиком хостинга сокет
   * приходит от него, а не от игрока: без этого все игроки для сервера
   * выглядят одним адресом, и любой счётчик по адресу считает их вместе.
   * Значение — сколько прокси перед нами (у Render один). Своего
   * балансировщика нет — оставляем выключенным: иначе заголовок
   * X-Forwarded-For подделает кто угодно.
   */
  trustProxy?: boolean | number;
  /**
   * Откуда браузеру разрешено ходить в API. Пустой список — отражать
   * любой источник: так удобно в разработке и не опаснее, чем сейчас
   * (ключ игрока лежит в localStorage, и чужой странице он недоступен),
   * но на бою список лучше задать.
   */
  allowedOrigins?: string[];
  /** Потолок запросов с одного адреса в минуту. Подменяется в тестах. */
  requestLimit?: number;
}

interface TokenPayload {
  sub: string;
  name: string;
}

const LEADERBOARD_SIZE = 50;
const RATING_BOARD_SIZE = 50;
const HISTORY_SIZE = 20;
const RECENT_OPPONENTS = 8;

/**
 * Какую таблицу просят: сегодняшнюю или вечную. Всё, кроме явного
 * period=day, читаем как вечную — так старые клиенты видят прежний ответ.
 */
function boardPeriod(request: { query: unknown }): BoardPeriod {
  const asked = (request.query as { period?: unknown } | undefined)?.period;
  return asked === 'day' ? 'day' : 'all';
}

/** Сколько дней игрок не играл рейтинговых матчей. */
function idleDays(ratedAt: string | null): number {
  if (!ratedAt) return 0;
  const last = Date.parse(`${ratedAt.replace(' ', 'T')}Z`);
  if (Number.isNaN(last)) return 0;
  return Math.max(0, (Date.now() - last) / 86_400_000);
}

/**
 * Адрес запроса для лога — без строки запроса.
 *
 * Браузерный WebSocket не умеет слать заголовки, поэтому токен дуэли
 * приходит параметром `/duel?token=…`. В логе такой адрес — это выданный
 * навсегда токен, лежащий в открытом виде у всех, кто до логов дотянется.
 * Путь для отладки и так достаточен, а параметры не нужны.
 */
export function loggedUrl(url: string | undefined): string {
  if (!url) return '';
  const cut = url.indexOf('?');
  return cut === -1 ? url : `${url.slice(0, cut)}?…`;
}

/** Собирает приложение и готовит схему БД. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
    logger: options.logger
      ? {
          serializers: {
            req: (request) => ({
              method: request.method,
              url: loggedUrl(request.url),
              remoteAddress: request.ip,
            }),
          },
        }
      : false,
  });
  const store = new Store(
    options.databaseAuthToken
      ? { url: options.databaseUrl, authToken: options.databaseAuthToken }
      : { url: options.databaseUrl },
  );
  await store.migrate();

  /**
   * Мягкая остановка. Живые матчи надо досчитать раньше, чем плагин
   * вебсокетов оборвёт соединения своим preClose: иначе игрок не увидит
   * результата уже сыгранного матча. Хуки с одним именем идут в порядке
   * регистрации, поэтому этот стоит здесь — до register(websocket), —
   * хотя матчмейкера, который он останавливает, ещё нет.
   */
  let stopMatches = (): void => {};
  app.addHook('preClose', () => {
    stopMatches();
  });

  const origins = options.allowedOrigins ?? [];
  await app.register(cors, { origin: origins.length > 0 ? origins : true });
  await app.register(jwt, { secret: options.jwtSecret });
  // Ход дуэли — это десяток клеток; всё, что больше килобайта, прислано
  // не игрой. Без потолка ws принимает кадры до 100 МиБ, и один клиент
  // может занять память сервера, ничего не нарушая формально.
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  /**
   * Общий потолок запросов. Отдельные двери прикрыты своими счётчиками
   * (гостевой вход, приглашения), но перед ними стоит один общий: он не
   * разбирает, что просят, и не даёт одной машине занять сервер целиком.
   */
  const requests = new RateGuard(options.requestLimit ?? REQUEST_LIMIT, REQUEST_WINDOW_MS);
  app.addHook('onRequest', async (request, reply) => {
    if (requests.allow(request.ip)) return;
    await reply.code(429).header('retry-after', '60').send({ error: 'too-many' });
  });

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
    const kind = result.kind;

    const before = await Promise.all([
      store.ratingOf(first.playerId, kind),
      store.ratingOf(second.playerId, kind),
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
        await store.saveRating(outcome.playerId, after, kind);
        await store.saveRatingChange(result.duelId, outcome.playerId, was.rating, after.rating);
        // Лига даёт отметку на корпус. Выданное не отбирается: рейтинг
        // просядет, а то, что человек там был, — уже случилось. Отметки
        // пока висят на цепочках: у заказов своя лестница и свои будут.
        const badge = kind === 'chain' ? leagueMark(LEAGUES.indexOf(leagueOf(after.rating))) : null;
        if (badge) await store.grantMark(outcome.playerId, badge);
        // Сотня матчей — отметка за выслугу, а не за силу.
        const record = await store.duelRecord(outcome.playerId);
        if (record.played >= MARK_DUELS) await store.grantMark(outcome.playerId, 'e-duels');
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

  /**
   * Призрак для дуэли на заказах — чужой записанный заход. Поле берётся
   * из его сида, поэтому у живого игрока условия те же, что были у него,
   * а темп очков считается переигровкой журнала касаний.
   */
  const orderGhost = async (playerId: string): Promise<Ghost | undefined> => {
    const recorded = await store.pickOrderRun(playerId);
    if (!recorded) return undefined;
    try {
      const moves = JSON.parse(recorded.moves) as OrderMove[];
      const log = orderTempo(recorded.seed, moves);
      if (log.length === 0) return undefined;
      return {
        name: recorded.name,
        seed: recorded.seed,
        score: log.reduce((sum, step) => sum + step.points, 0),
        log,
        marks: recorded.marks,
      };
    } catch {
      // Битая запись — соперника просто не будет; ждать живого честнее,
      // чем подставлять призрака, играющего в пустоту.
      return undefined;
    }
  };

  /**
   * Незаконченные записи итогов. Матч сохраняется не сразу: сначала
   * ответ игроку, потом база. При остановке сервера эти обещания надо
   * дождаться, иначе последний матч пропадёт вместе с процессом.
   */
  const saving = new Set<Promise<unknown>>();
  const track = (task: Promise<unknown>): void => {
    saving.add(task);
    void task.finally(() => saving.delete(task));
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
      track(
        store
          .saveDuel(result.duelId, result.seed, result.kind, players, result.claims)
          .then(() =>
            Promise.all(
              players
                .filter((player) => !player.ghost)
                // Матч дают в жетонах столько же, сколько соло-заход: время
                // он занимает то же, а звать в дуэль выгоднее, чем прятаться
                // от неё.
                .map((player) =>
                  Promise.all([store.addTotal(player.id, player.score), payToken(player.id)]),
                ),
            ),
          )
          .then(() => applyRatings(result))
          .catch((error: unknown) => app.log.error(error, 'failed to save duel')),
      );
    },
    findGhost: async (playerId, kind) => {
      if (options.duelGhosts === false) return undefined;
      // В заказах записью служит настоящий заход заказов: его темп берётся
      // из журнала касаний, переигранного ядром.
      if (kind === 'order') return orderGhost(playerId);
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
            marks: recorded.marks,
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

  // Хук, объявленный до плагина вебсокетов, теперь знает, что останавливать.
  stopMatches = () => matchmaker.close();

  app.addHook('onClose', async () => {
    // На случай остановки в обход preClose: закрыть дважды безопасно.
    matchmaker.close();
    // Итоги досчитанных матчей ещё пишутся — база закрывается после них.
    await Promise.allSettled([...saving]);
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

  const signups = new SignupGuard();
  const invites = new RateGuard(INVITE_LIMIT, INVITE_WINDOW_MS);

  app.post('/api/auth/guest', async (request, reply) => {
    // Дверь без пароля и подписи: за ней сразу заводится аккаунт, поэтому
    // общего потолка ей мало — тут счёт свой и куда более строгий.
    if (!signups.allow(request.ip)) return reply.code(429).send({ error: 'too-many' });
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
  /**
   * Смена имени. Она одна на аккаунт: имя приходит из Telegram, и одной
   * осознанной замены игроку хватает — дальше по этому имени его знают
   * соперники, друзья и таблицы, и менять его туда-сюда значит путать их.
   */
  app.post('/api/me/name', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = RenameRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const changed = await store.renameUser(user.sub, parsed.data.name);
    if (!changed) return reply.code(409).send({ error: 'rename-used' });
    return issueToken(user.sub, parsed.data.name);
  });

  /**
   * Жетон за доведённый до конца заход или матч. Платим за то, что игрок
   * доиграл, а не за то, что выиграл: проигравшему заход стоил того же
   * времени, и брать с него дважды незачем.
   */
  const payToken = async (userId: string): Promise<void> => {
    await store.grantToken(userId, TOKEN_GAP_SECONDS);
  };

  /**
   * Что игроку сейчас положено носить: выданное навсегда плюс золото, пока
   * он держит вечную таблицу. Второе живёт не в базе, а в самой таблице,
   * поэтому спрашивается заново каждый раз.
   */
  async function ownedMarks(userId: string): Promise<string[]> {
    const [earned, gold] = await Promise.all([
      store.earnedMarks(userId),
      store.goldMarks(userId),
    ]);
    return [...earned, ...gold];
  }

  /**
   * Шильдики корпуса. Набор закрытый, поэтому проверка короткая: номер
   * должен быть из каталога ядра — всё остальное отсекается там же.
   */
  app.put('/api/me/marks', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = MarksRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const earned = await ownedMarks(user.sub);
    // Отметку за игру носит только тот, кому её выдали: чужую гасим, а не
    // отказываем всему корпусу — остальные ячейки игрок выбрал честно.
    const marks = cleanMarks(parsed.data.marks).map((id) =>
      id !== null && markAllowed(id, earned) ? id : null,
    );
    await store.setMarks(user.sub, marks);
    return { marks };
  });

  /**
   * Покупка наклейки за жетоны. Цену называет сервер по каталогу ядра:
   * присланной цене верить нельзя, а другой цены у наклейки нет — она одна
   * на все.
   *
   * Отметки за игру и золото сюда не проходят: у них нет цены, и это не
   * упущение — купить их нельзя, в этом вся их ценность.
   */
  app.post('/api/me/buy', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = BuyRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    // Дверь одна на всё, что продаётся: цену называет тот каталог, в
    // котором номер нашёлся.
    const price = isFrame(parsed.data.id) ? FRAME_PRICE : markPrice(parsed.data.id);
    if (price === null) return reply.code(400).send({ error: 'not-for-sale' });

    const outcome = await store.buyItem(user.sub, parsed.data.id, price);
    if (outcome === 'poor') return reply.code(402).send({ error: 'not-enough' });
    if (outcome === 'owned') return reply.code(409).send({ error: 'owned' });

    const [tokens, earned] = await Promise.all([store.tokensOf(user.sub), ownedMarks(user.sub)]);
    const response: BuyResponse = { tokens, earned };
    return response;
  });

  /**
   * Оправа полосы шильдиков. Носят одну и снимают её тем же запросом с
   * пустым значением: снять — это не отдельное действие, а тот же выбор.
   */
  app.put('/api/me/frame', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = FrameRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const frame = parsed.data.frame;
    if (!frameAllowed(frame, await ownedMarks(user.sub))) {
      return reply.code(400).send({ error: 'not-owned' });
    }
    await store.setFrame(user.sub, frame);
    return { frame };
  });

  /**
   * Смайлик на пропуске: единственное, что игрок рисует о себе сам. Набор
   * закрытый и лежит в ядре — оттуда его берёт и сетка выбора в кабинете, и
   * эта проверка. Своего смайлика игрок не присылает: аватар видит соперник,
   * и принимать сюда что попало значит заводить себе модерацию.
   */
  app.post('/api/me/avatar', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = AvatarRequestSchema.safeParse(request.body);
    if (!parsed.success || !isFace(parsed.data.avatar)) {
      return reply.code(400).send({ error: 'bad-avatar' });
    }
    await store.setAvatar(user.sub, parsed.data.avatar);
    return { avatar: parsed.data.avatar };
  });

  // ---------- Спринт ----------

  /**
   * Заход спринта. Клиент присылает ходы, сервер переигрывает их ядром и
   * сам считает счёт: в таблицу попадает только подтверждённое пересчётом.
   *
   * В наработку отсюда ничего не добавляем: потенциал спринта клиент шлёт
   * по ходу партии обычным досылом, и зачесть их дважды нельзя.
   */
  app.post('/api/sprint', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = SubmitSprintRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });

    const replay = replaySprint(parsed.data.seed, parsed.data.moves);
    if (typeof replay === 'string') return reply.code(400).send({ error: replay });

    const saved = await store.saveSprint(
      user.sub,
      replay.score,
      parsed.data.seed,
      JSON.stringify(parsed.data.moves),
    );
    await payToken(user.sub);
    // Первое место дня — отметка на корпус. Считаем по дневной таблице:
    // вечная слишком неподвижна, чтобы за неё что-то выдавать.
    if ((await store.sprintRank(user.sub, 'day')) === 1) {
      await store.grantMark(user.sub, 'e-sprint');
    }
    const response: SubmitSprintResponse = {
      score: replay.score,
      best: saved.best,
      record: saved.improved,
      rank: (await store.sprintRank(user.sub)) ?? 1,
    };
    return response;
  });

  app.get('/api/sprint/leaderboard', async (request): Promise<SprintLeaderboardResponse> => {
    const period = boardPeriod(request);
    const rows = await store.sprintTop(LEADERBOARD_SIZE, period);
    const entries = rows.map((row, index) => ({
      rank: index + 1,
      name: row.name,
      score: row.score,
      mark: row.mark,
    }));

    // Авторизация не обязательна: без токена просто не будет строки «я».
    let me: SprintLeaderboardResponse['me'] = null;
    try {
      const user = await requireUser(request);
      const [best, rank, marks] = await Promise.all([
        store.bestSprint(user.sub, period),
        store.sprintRank(user.sub, period),
        store.marksOf(user.sub),
      ]);
      const mark = marks.find((id) => id !== null) ?? null;
      if (best > 0 && rank !== null) me = { rank, name: user.name, score: best, mark };
    } catch {
      // нет или битый токен — гость смотрит таблицу анонимно
    }

    return { entries, me };
  });

  // ---------- Заказы ----------

  /**
   * Заход режима заказов. Клиент присылает касания, сервер переигрывает их
   * ядром и сам считает счёт: в таблицу попадает только то, что
   * подтверждено пересчётом.
   */
  app.post('/api/order', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = SubmitOrderRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });

    const replay = replayOrder(parsed.data.seed, parsed.data.moves);
    if (typeof replay === 'string') return reply.code(400).send({ error: replay });

    const saved = await store.saveOrder(
      user.sub,
      replay.score,
      replay.orders,
      parsed.data.seed,
      JSON.stringify(parsed.data.moves),
    );
    await payToken(user.sub);
    if ((await store.orderRank(user.sub, 'day')) === 1) {
      await store.grantMark(user.sub, 'e-order');
    }
    // Отметки за сам заход: серия окон и самая крупная снятая группа.
    if (replay.streak >= MARK_STREAK) await store.grantMark(user.sub, 'e-run');
    if (replay.biggest >= MARK_BIG) await store.grantMark(user.sub, 'e-big');
    const response: SubmitOrderResponse = {
      score: replay.score,
      orders: replay.orders,
      best: saved.best,
      record: saved.improved,
      rank: (await store.orderRank(user.sub)) ?? 1,
    };
    return response;
  });

  app.get('/api/order/leaderboard', async (request): Promise<OrderLeaderboardResponse> => {
    const period = boardPeriod(request);
    const rows = await store.orderTop(LEADERBOARD_SIZE, period);
    const entries = rows.map((row, index) => ({
      rank: index + 1,
      name: row.name,
      score: row.score,
      orders: row.orders,
      mark: row.mark,
    }));

    // Авторизация не обязательна: без токена просто не будет строки «я».
    let me: OrderLeaderboardResponse['me'] = null;
    try {
      const user = await requireUser(request);
      const [best, orders, rank, marks] = await Promise.all([
        store.bestOrder(user.sub, period),
        store.ordersOf(user.sub, period),
        store.orderRank(user.sub, period),
        store.marksOf(user.sub),
      ]);
      const mark = marks.find((id) => id !== null) ?? null;
      if (best > 0 && rank !== null) me = { rank, name: user.name, score: best, orders, mark };
    } catch {
      // нет или битый токен — гость смотрит таблицу анонимно
    }

    return { entries, me };
  });

  // ---------- Дуэли ----------

  app.get('/api/me/duels', async (request) => {
    const user = await requireUser(request);
    return store.duelRecord(user.sub);
  });

  /**
   * Досыл потенциала из режимов, которые сервер не пересчитывает целиком.
   * Дуэли сюда не ходят: их очки сервер считает сам и засчитывает у себя.
   */
  app.post('/api/me/score', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = AddScoreRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });

    const { points, moves } = parsed.data;
    // Один ход не может стоить сколько угодно: даже самая длинная цепочка
    // с каскадом вспышек в резонансе не даёт и близко столько.
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
    const [
      rating,
      rank,
      duels,
      identities,
      total,
      avatar,
      sprint,
      sprintRank,
      order,
      orders,
      orderRank,
      marks,
      earned,
      duelRating,
      duelRank,
      renamed,
      tokens,
      frame,
    ] = await Promise.all([
        store.ratingOf(user.sub),
        store.ratingRank(user.sub),
        store.duelRecord(user.sub),
        store.identitiesOf(user.sub),
        store.totalScore(user.sub),
        store.avatarOf(user.sub),
        store.bestSprint(user.sub),
        store.sprintRank(user.sub),
        store.bestOrder(user.sub),
        store.ordersOf(user.sub),
        store.orderRank(user.sub),
        store.marksOf(user.sub),
        ownedMarks(user.sub),
        store.ratingOf(user.sub, 'order'),
        store.ratingRank(user.sub, 'order'),
        store.renamed(user.sub),
        store.tokensOf(user.sub),
        store.frameOf(user.sub),
      ]);
    const up = nextLeague(rating.rating);
    const league = leagueOf(rating.rating);
    return {
      name: user.name,
      avatar,
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
      orderDuel: {
        rating: duelRating.rating,
        league: leagueOf(duelRating.rating).name,
        rank: duelRank,
        placement:
          duelRating.games >= PLACEMENT_GAMES
            ? null
            : { played: duelRating.games, required: PLACEMENT_GAMES },
      },
      sprint: { best: sprint, rank: sprintRank },
      order: { best: order, orders, rank: orderRank },
      marks,
      earned,
      canRename: !renamed,
      tokens,
      frame,
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
      'Соединяй точки, копи вспышки, вызывай друзей на дуэль.\n\n' +
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
    // Считаем по зовущему, а не по адресу: дверь эта — за входом, и
    // отвечает за вызовы человек, а не сеть, из которой он пришёл.
    if (!invites.allow(user.sub)) return reply.code(429).send({ error: 'too-many' });
    const parsedCode = FriendCodeSchema.safeParse((request.params as { code: string }).code);
    const parsedBody = InviteRequestSchema.safeParse(request.body);
    if (!parsedCode.success || !parsedBody.success) {
      return reply.code(400).send({ error: 'bad-request' });
    }
    const friend = await store.userByFriendCode(parsedCode.data);
    if (!friend) return reply.code(404).send({ error: 'no-such-code' });
    // Звать можно только друзей — иначе рассылку получил бы кто угодно.
    if (!(await store.areFriends(user.sub, friend.id))) {
      return reply.code(403).send({ error: 'not-a-friend' });
    }

    // Приглашение всегда кладём в игру: друг увидит его прямо в приборе,
    // если он там. Это и есть основной путь, и от бота он не зависит вовсе.
    await store.addInvite(friend.id, user.sub, parsedBody.data.room);
    if (await store.isOnline(friend.id)) return { ok: true, where: 'game' };

    // В приборе его нет — тогда стучимся в Telegram. Не всем можно: бот не
    // пишет первым тому, кто его не запускал.
    if (!bot) return reply.code(503).send({ error: 'telegram-disabled' });
    const chat = await store.botChatOf(friend.id);
    if (!chat) return reply.code(409).send({ error: 'no-telegram' });

    // Ссылка ведёт прямо в комнату: друг нажимает кнопку и попадает в
    // матч, а не переписывает код. Кода в письме поэтому нет вовсе — он
    // остаётся у позвавшего на экране на случай, если ссылка не собралась.
    const open = bot.miniAppLink(`duel_${parsedBody.data.room}`);
    const sent = await bot.sendMessage(
      chat,
      `${user.name} зовёт тебя к прибору — дуэль в dotoscope.` +
        (open ? '' : `\nКод комнаты: ${parsedBody.data.room}`),
      open ? { text: '🔭 Принять вызов', url: open } : undefined,
    );
    if (!sent) return reply.code(409).send({ error: 'not-delivered' });
    return { ok: true, where: 'telegram' };
  });

  /**
   * Приглашения, ждущие игрока. Клиент опрашивает этот путь, пока игра
   * открыта, — он же служит признаком «человек в приборе»: по нему решаем,
   * звать его в игре или писать в Telegram.
   */
  app.get('/api/me/invites', async (request): Promise<{ invites: InviteInfo[] }> => {
    const user = await requireUser(request);
    await store.touchSeen(user.sub);
    return { invites: await store.invitesFor(user.sub) };
  });

  /** Приглашение принято или отвергнуто — в обоих случаях оно отработало. */
  app.delete('/api/me/invites/:room', async (request, reply) => {
    const user = await requireUser(request);
    const room = String((request.params as { room: string }).room);
    if (room.length < 4 || room.length > 16) return reply.code(400).send({ error: 'bad-room' });
    await store.dropInvite(user.sub, room);
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
        kind: row.kind,
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
    // Заявки решали цвет фаз: без них реплей насчитал бы другие очки.
    // У матчей до этой механики колонка пуста — там цвет и так из сида.
    let claims: ClaimLog[] = [];
    if (replay.claims !== null) {
      try {
        claims = (JSON.parse(replay.claims) as (ClaimLog & { by: string })[]).map(
          ({ by, ...claim }) => ({ ...claim, mine: by === user.sub }),
        );
      } catch {
        claims = [];
      }
    }
    const response: ReplayResponse = {
      seed: replay.seed,
      moves,
      score: replay.score,
      opponent: replay.opponentName,
      claims,
    };
    return response;
  });

  app.get('/api/rating', async (request): Promise<RatingLeaderboardResponse> => {
    // Таблиц рейтинга две — по одной на механику; без параметра это
    // цепочки, как было до заказов.
    const kind = (request.query as { kind?: string }).kind === 'order' ? 'order' : 'chain';
    const rows = await store.ratingLeaderboard(RATING_BOARD_SIZE, kind);
    const entries = rows.map((row, index) => ({
      rank: index + 1,
      name: row.name,
      rating: row.rating,
      league: leagueOf(row.rating).name,
      mark: row.mark,
    }));

    // Токен не обязателен: гость просто увидит таблицу без своей строки.
    let me: RatingLeaderboardResponse['me'] = null;
    try {
      const user = await requireUser(request);
      const rank = await store.ratingRank(user.sub, kind);
      if (rank !== null) {
        const [rating, marks] = await Promise.all([
          store.ratingOf(user.sub, kind),
          store.marksOf(user.sub),
        ]);
        me = {
          rank,
          name: user.name,
          rating: rating.rating,
          league: leagueOf(rating.rating).name,
          mark: marks.find((id) => id !== null) ?? null,
        };
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

    // Код друга нужен сопернику на экране результата, шильдики — с первой
    // секунды матча: на время дуэли соперник занимает корпус целиком.
    // Читаем один раз при подключении: к моменту подбора оба уже на месте.
    void Promise.all([
      store.friendCodeOf(user.sub),
      store.marksOf(user.sub),
      store.frameOf(user.sub),
    ])
      .then(([code, marks, frame]) => {
        if (code) player.code = code;
        player.marks = marks;
        if (frame) player.frame = frame;
      })
      .catch((error: unknown) => app.log.error(error, 'duel player lookup failed'));

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
          matchmaker.join(player, message.data.room, message.data.kind ?? 'chain');
          break;
        case 'move': {
          const outcome = matchmaker.move(player.id, message.data.path);
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
