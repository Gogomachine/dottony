import { randomInt, randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  AddFriendRequestSchema,
  ArtRequestSchema,
  AvatarRequestSchema,
  AdminBanRequestSchema,
  AdminFindQuerySchema,
  AdminNameRequestSchema,
  AdminTokensRequestSchema,
  ReportRequestSchema,
  TourneyRoundRequestSchema,
  AdminUserRequestSchema,
  BuyRequestSchema,
  FrameRequestSchema,
  ServiceRequestSchema,
  MarksRequestSchema,
  DuelClientMessageSchema,
  FriendCodeSchema,
  GuestAuthRequestSchema,
  InviteRequestSchema,
  RenameRequestSchema,
  SubmitOrderRequestSchema,
  SubmitSprintRequestSchema,
  TelegramAuthRequestSchema,
  type AdminCard,
  type AdminFindResponse,
  type BanInfo,
  type AdminLogResponse,
  type AdminNoticesResponse,
  type AdminReportsResponse,
  type DuelKind,
  type TourneyHistoryResponse,
  type TourneyResponse,
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
  artPainted,
  cleanMarks,
  isArt,
  isFace,
  isOwnMark,
  TOURNEY_ENTRY,
  TOURNEY_ROUNDS,
  TOURNEY_ROUND_GRACE,
  TOURNEY_ROUND_SKEW,
  SHIFT_BONUS,
  SPRINT_SECONDS,
  tourneyDay,
  tourneyEntryDay,
  tourneyNext,
  tourneyPhase,
  tourneyPrizes,
  slotItem,
  MARKS,
  MARK_SLOTS,
  FRAMES,
  OWN_MARK,
  leagueMark,
  markAllowed,
  markPrice,
  openSlots,
  nextSlot,
  slotItemPrice,
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
import { judgeRun } from './judge.js';
import { Store, type BoardPeriod } from './db.js';
import {
  INVITE_LIMIT,
  INVITE_WINDOW_MS,
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
  /**
   * Служебный ключ наладки. Пока он не задан, дверей `/api/service/*` не
   * существует вовсе — они отвечают тем же «нет такой страницы», что и любой
   * выдуманный адрес, и по ответу сервера не видно, что режим вообще бывает.
   *
   * На боевом сервере его быть не должно: за этой дверью выдают жетоны и
   * шильдики числом, а не игрой, — то есть ровно то, чего не должно быть
   * ни у кого, кроме прибора на столе у наладчика.
   */
  serviceKey?: string;
  /**
   * Номера в Telegram тех, кто держит службу прибора. Список лежит в
   * настройках сервера, а не в базе: право входа в службу даёт тот, у кого
   * доступ к серверу, и отобрать его можно, не заходя в игру. Отдельного
   * пароля у службы нет — служащий входит обычным способом, и прибор узнаёт
   * его по той же личности, что и все остальные.
   */
  adminTelegramIds?: string[];
}

interface TokenPayload {
  sub: string;
  name: string;
}

/**
 * Сколько жетонов кладёт наладка. Не «бесконечно»: цену видно только на
 * конечном счёте, а с бесконечным не проверишь ни «не хватает», ни остаток
 * после покупки. Хватает на весь прилавок с запасом.
 */
const SERVICE_TOKENS = 9999;

/** Все ячейки корпуса, кроме первой: она и так открыта у всех. */
const SERVICE_SLOTS: string[] = Array.from({ length: MARK_SLOTS - 1 }, (_, index) =>
  slotItem(index + 1),
).filter((id): id is string => id !== null);

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
/**
 * Картинка своего шильдика в строке списка. Поле необязательное: у чужих
 * шильдиков картинки нет вовсе, и слать `art: undefined` в каждой строке
 * таблицы значило бы возить пустоту полсотни раз.
 */
function artField(art: string | null | undefined): { art?: string } {
  return art === null || art === undefined ? {} : { art };
}

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
        ...(recorded.art === null ? {} : { art: recorded.art }),
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
                  payToken(player.id),
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
            ...(recorded.art === null ? {} : { art: recorded.art }),
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

  /**
   * Кто сейчас наказан.
   *
   * Держим в памяти, а не спрашиваем базу на каждый запрос: банов единицы, а
   * запросов у играющего десятки в минуту. Список читается при старте и
   * правится тут же, как только служба кого-то наказала или простила, —
   * поэтому бан действует сразу, а не «когда-нибудь».
   *
   * Это работает, пока сервер один (у нас так). Если инстансов станет
   * несколько, соседние узнают о бане только при перезапуске — тогда это
   * место придётся переделать на общий кеш.
   */
  const banned = await store.bans();

  /** Бан игрока, если он есть и ещё не кончился. Просроченный снимаем сами. */
  const banOf = (userId: string): BanInfo | null => {
    const ban = banned.get(userId);
    if (!ban) return null;
    if (ban.until !== null && new Date(`${ban.until.replace(' ', 'T')}Z`).getTime() <= Date.now()) {
      // Срок вышел — прибор возвращается хозяину сам, без службы. Запись в
      // базе приберётся при следующем старте: см. `Store.bans`.
      banned.delete(userId);
      return null;
    }
    return ban;
  };

  /**
   * Отказ наказанному. Дверей у прибора много, а место, где его встречают,
   * должно быть одно: любая дверь за входом отвечает одинаково — чем и до
   * какого числа, чтобы игрок узнал причину, а не упёрся в молчание.
   */
  class Banned extends Error {
    constructor(readonly ban: BanInfo) {
      super('banned');
    }
  }

  const requireUser = async (request: FastifyRequest): Promise<TokenPayload> => {
    await request.jwtVerify();
    const user = request.user as TokenPayload;
    const ban = banOf(user.sub);
    if (ban) throw new Banned(ban);
    return user;
  };

  /**
   * Кто пришёл, даже если он наказан. Нужен ровно одной двери — своей же
   * карточке: не показать наказанному, за что и до какого числа, значило бы
   * сломать прибор молча.
   */
  const requireAnyUser = async (request: FastifyRequest): Promise<TokenPayload> => {
    await request.jwtVerify();
    return request.user as TokenPayload;
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Banned) {
      return reply.code(403).send({ error: 'banned', ...error.ban });
    }
    // Всё остальное — как раньше: Fastify сам разберётся с кодом и телом.
    return reply.send(error);
  });

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
  const payToken = async (userId: string): Promise<{ shift: number }> => {
    await store.grantToken(userId, TOKEN_GAP_SECONDS);
    // Смена: первый заход дня приносит надбавку. День берём турнирный —
    // две вещи, которые игрок делает раз в день, начинаются вместе.
    const paid = await store.payShift(userId, tourneyDay(new Date()), SHIFT_BONUS);
    return { shift: paid ? SHIFT_BONUS : 0 };
  };

  /**
   * Осматривает сыгранный заход и, если тот не похож на человеческий,
   * оставляет след для службы. Ничего не запрещает и не отменяет: решает
   * человек, а прибор только замечает — ошибиться тут дороже, чем
   * пропустить.
   */
  const notice = async (
    userId: string,
    place: string,
    replay: { score: number; sharp: number; moves: number },
    moves: MoveLog[],
  ): Promise<void> => {
    const noticed = judgeRun(replay, moves);
    if (noticed.length === 0) return;
    await store.addNotice(userId, place, noticed.join(' · '), replay.score);
    app.log.warn({ userId, place, noticed, score: replay.score }, 'run looks solved');
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
    const open = openSlots(earned);
    // Отметку за игру носит только тот, кому её выдали: чужую гасим, а не
    // отказываем всему корпусу — остальные ячейки игрок выбрал честно.
    // Закрытая ячейка гасится так же: купить её можно, обойти — нет.
    const marks = cleanMarks(parsed.data.marks).map((id, index) =>
      id !== null && index < open && markAllowed(id, earned) ? id : null,
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
    const id = parsed.data.id;
    const price = isFrame(id) ? FRAME_PRICE : (slotItemPrice(id) ?? markPrice(id));
    if (price === null) return reply.code(400).send({ error: 'not-for-sale' });

    // Ячейки продаются по порядку: третья без второй не открылась бы, и
    // тысяча жетонов ушла бы впустую.
    if (slotItemPrice(id) !== null && id !== nextSlot(await ownedMarks(user.sub))) {
      return reply.code(400).send({ error: 'slot-order' });
    }

    const outcome = await store.buyItem(user.sub, id, price);
    if (outcome === 'poor') return reply.code(402).send({ error: 'not-enough' });
    if (outcome === 'owned') return reply.code(409).send({ error: 'owned' });

    const [tokens, earned] = await Promise.all([store.tokensOf(user.sub), ownedMarks(user.sub)]);
    const response: BuyResponse = { tokens, earned, slots: openSlots(earned) };
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
   * Свой рисунок на пропуск. Единственное место в приборе, куда игрок
   * присылает своё, а не выбирает из готового, — и потому единственное, за
   * чем в принципе может понадобиться присмотр: шильдик видит соперник.
   *
   * Форму держим жёстко (ровно сто знаков, только известные краски), а
   * дальше полагаемся на тесноту сетки: в десяти клетках текста не набрать.
   * Ставить рисунок можно только тому, кто своё место уже купил, — иначе
   * прибор хранил бы картинки тех, кто ничего не покупал.
   */
  app.put('/api/me/art', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = ArtRequestSchema.safeParse(request.body);
    if (!parsed.success || !isArt(parsed.data.art)) {
      return reply.code(400).send({ error: 'bad-art' });
    }
    // Пустой лист на пропуск не ставится: это не рисунок, а стёртый рисунок,
    // и на корпусе он выглядел бы поломкой шильдика.
    if (artPainted(parsed.data.art) === 0) return reply.code(400).send({ error: 'empty-art' });
    if (!(await ownedMarks(user.sub)).includes(OWN_MARK)) {
      return reply.code(403).send({ error: 'not-owned' });
    }
    await store.setArt(user.sub, parsed.data.art);
    return { art: parsed.data.art };
  });

  /**
   * Смайлик на пропуске: единственное, что игрок выбирает о себе сам. Набор
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

  // ---------- Турнир ----------

  /**
   * Дневной турнир: один образец на всех, три захода за день, общий котёл.
   *
   * Счёт заходов считает сервер тем же пересчётом, что и в таблицах, — и
   * тем же ядром. Сид турнира клиент не присылает никогда: он общий, и
   * присланному верить нельзя.
   */
  const tourneyState = async (
    userId: string | null,
    /** Какой день показывать; по умолчанию сегодняшний. */
    wanted?: string,
  ): Promise<TourneyResponse> => {
    // Прежде чем показывать что-либо, добираем несчитанные дни: итоги
    // должны наступать сами, а не тогда, когда до сервера кто-то дошёл.
    await settleTourneys();
    const now = new Date();
    const today = tourneyDay(now);
    const day = wanted ?? today;
    // У прошедшего дня своего расписания уже нет: он весь позади.
    const phase = day === today ? tourneyPhase(now) : day < today ? 'done' : 'before';
    const [{ seed }, counts] = await Promise.all([store.tourneyOf(day), store.tourneyCount(day)]);
    const mine = userId === null ? null : await store.tourneyEntry(day, userId);
    const board = await store.tourneyBoard(day);
    // Куда записывают прямо сейчас. Смотреть можно любой день, а записаться
    // — только в тот, что ещё принимает: сегодняшний или завтрашний.
    const signupDay = tourneyEntryDay(now);
    const signup = {
      day: signupDay,
      entered:
        userId === null
          ? false
          : signupDay === day
            ? mine !== null
            : (await store.tourneyEntry(signupDay, userId)) !== null,
    };
    return {
      day,
      phase,
      signup,
      nextAt: tourneyNext(now).at.toISOString(),
      entry: TOURNEY_ENTRY,
      rounds: TOURNEY_ROUNDS,
      entered: counts.entered,
      scorers: counts.scorers,
      pool: counts.pool,
      prizes: tourneyPrizes(counts.pool, counts.scorers),
      mine:
        mine === null
          ? null
          : {
              rounds: mine.rounds,
              score: mine.score,
              scores: await store.tourneyScores(day, userId!),
              place: mine.place,
              prize: mine.prize,
              // Сид даём только вошедшему и только пока турнир идёт: до
              // открытия его знать рано, после закрытия — незачем.
              ...(phase === 'open' ? { seed } : {}),
            },
      board: board.map((row, index) => ({
        rank: index + 1,
        name: row.name,
        score: row.score,
        rounds: row.rounds,
        place: row.place,
        prize: row.prize,
        mark: row.mark,
        ...(row.art === undefined ? {} : { art: row.art }),
        ...(row.id === userId ? { me: true } : {}),
      })),
    };
  };

  app.get('/api/tourney', async (request, reply) => {
    // Смотреть турнир можно и без входа: это витрина, а не личное дело.
    const user = await currentUser(request);
    // Прошедший день смотрят по его ключу — так открываются итоги из
    // кабинета. Будущий не показываем вовсе: заводить турнир вперёд себя
    // значило бы раздавать сид дня, которого ещё не было.
    const wanted = (request.query as { day?: string }).day;
    if (wanted !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(wanted) || wanted > tourneyDay(new Date())) {
        return reply.code(400).send({ error: 'bad-day' });
      }
    }
    return tourneyState(user?.sub ?? null, wanted);
  });

  /** Своя история турниров: за какой день платил, чем кончилось. */
  app.get('/api/tourney/history', async (request): Promise<TourneyHistoryResponse> => {
    const user = await requireUser(request);
    await settleTourneys();
    const days = await store.tourneyHistory(user.sub, 30);
    return {
      days: days.map((row) => ({
        day: row.day,
        rounds: row.rounds,
        score: row.score,
        place: row.place,
        prize: row.prize,
        paid: row.paid,
        entered: row.entered,
        pool: row.pool,
      })),
    };
  });

  /**
   * Взнос за вход — в тот турнир, который сейчас принимает: сегодняшний,
   * пока он не закрылся, и завтрашний после закрытия. Записаться заранее
   * можно и ночью: ждать девяти утра, чтобы отдать жетоны, незачем.
   */
  app.post('/api/tourney/enter', async (request, reply) => {
    const user = await requireUser(request);
    const day = tourneyEntryDay(new Date());
    await store.tourneyOf(day);
    const outcome = await store.tourneyEnter(day, user.sub, TOURNEY_ENTRY);
    if (outcome === 'poor') return reply.code(402).send({ error: 'not-enough' });
    if (outcome === 'in') return reply.code(409).send({ error: 'already-in' });
    return tourneyState(user.sub);
  });

  /**
   * Начать заход. Раунд тратится здесь, а не в конце: заход, который
   * засчитывается только по истечении трёх минут, можно бросить на любой
   * секунде и начать заново — и «три захода» превратились бы в «сколько
   * угодно попыток, в зачёт три лучших».
   *
   * Номер раунда назначает сервер по тому, сколько уже начато: присланному
   * номеру верить нельзя.
   */
  app.post('/api/tourney/round/start', async (request, reply) => {
    const user = await requireUser(request);
    const now = new Date();
    if (tourneyPhase(now) !== 'open') return reply.code(409).send({ error: 'closed' });
    const day = tourneyDay(now);
    const entry = await store.tourneyEntry(day, user.sub);
    if (entry === null) return reply.code(403).send({ error: 'not-in' });
    if (entry.rounds >= TOURNEY_ROUNDS) return reply.code(409).send({ error: 'no-rounds' });
    const started = await store.tourneyStart(day, user.sub, entry.rounds + 1);
    if (!started) return reply.code(409).send({ error: 'no-rounds' });
    const { seed } = await store.tourneyOf(day);
    return { seed, round: entry.rounds + 1 };
  });

  /**
   * Конец захода: журнал ходов на проверку. Счёт считает сервер тем же
   * пересчётом, что и в таблицах, и на сиде турнира — присланному сиду тут
   * верить нельзя вовсе.
   */
  app.post('/api/tourney/round', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = TourneyRoundRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const now = new Date();
    if (tourneyPhase(now) !== 'open') return reply.code(409).send({ error: 'closed' });
    const day = tourneyDay(now);
    const entry = await store.tourneyEntry(day, user.sub);
    if (entry === null) return reply.code(403).send({ error: 'not-in' });

    /*
     * Часы захода — серверные. Секунды внутри журнала присылает клиент, и
     * по ним заход всегда «уложился в три минуты», сколько бы времени на
     * него ни ушло на самом деле: сид выдан утром, журнал можно прислать
     * вечером — с решателем в соседнем окне. Проверяем по метке начала.
     *
     * Опоздавший заход не пропадает бесследно: раунд был потрачен при
     * старте и остаётся в зачёте нулём — ровно как брошенный.
     */
    const age = await store.tourneyRoundAge(day, user.sub);
    if (age !== null && age > SPRINT_SECONDS + TOURNEY_ROUND_GRACE) {
      return reply.code(409).send({ error: 'too-late' });
    }
    /*
     * И снизу: заход не может прийти раньше, чем прошло заявленное им
     * время. Три минуты игры за двадцать секунд не играются — а решателю
     * нужно ровно это: посчитать поле и прислать готовый журнал с
     * выставленными секундами. Обойти вычислением нельзя, только просидеть
     * эти минуты по-настоящему.
     */
    const claimed = parsed.data.moves.reduce((last, move) => Math.max(last, move.t), 0);
    if (age !== null && age + TOURNEY_ROUND_SKEW < claimed) {
      return reply.code(409).send({ error: 'too-fast' });
    }

    const { seed } = await store.tourneyOf(day);
    const replay = replaySprint(seed, parsed.data.moves);
    if (typeof replay === 'string') return reply.code(400).send({ error: replay });
    const saved = await store.tourneyFinish(
      day,
      user.sub,
      replay.score,
      JSON.stringify(parsed.data.moves),
    );
    // Незаконченного захода нет: либо не начинали, либо он уже дописан.
    if (!saved) return reply.code(409).send({ error: 'not-started' });

    // Заход засчитан — и тут же осмотрен. Ставка в турнире жетонная, и
    // именно сюда пришёл бы решатель; заход при этом не отклоняется, прибор
    // только оставляет след для службы.
    await notice(user.sub, 'турнир', replay, parsed.data.moves);
    return tourneyState(user.sub);
  });

  /**
   * Раздаёт котлы всех дней, у которых прошло время итогов. Зовётся при
   * каждом взгляде на турнир и по часам — на спящем хостинге второе может и
   * не сработать, а первое сработает наверняка: кто-то да заглянет.
   *
   * Порядок мест: сумма очков, при равенстве — кто закончил раньше. Тот, кто
   * не сыграл ни одного захода, в раздаче не участвует: взнос он потерял, но
   * и делить его между теми, кто играл, честнее, чем возвращать.
   */
  async function settleTourneys(): Promise<void> {
    const now = new Date();
    const today = tourneyDay(now);
    const days = await store.tourneysToSettle(today);
    for (const day of days) {
      // Сегодняшний считаем, только когда пришло время итогов.
      if (day === today && tourneyPhase(now) !== 'done') continue;
      const counts = await store.tourneyCount(day);
      const board = await store.tourneyBoard(day, 1000);
      const played = board.filter((row) => row.rounds > 0);
      // Не сыграл никто — возвращаем взносы: турнира не было.
      const prizes =
        played.length === 0
          ? board.map(() => TOURNEY_ENTRY)
          : tourneyPrizes(counts.pool, played.length);
      // Место и приз получают все, кто вносил, — в том числе ноль. Пустая
      // клетка вместо нуля читалась бы как «ещё не считали», а считали уже:
      // вошёл, не сыграл, не выиграл — это тоже итог.
      await store.tourneySettle(
        day,
        board.map((row, index) => ({
          userId: row.id,
          place: index + 1,
          prize: prizes[index] ?? 0,
        })),
      );
      app.log.info({ day, players: counts.entered, pool: counts.pool }, 'tourney settled');
    }
  }

  /**
   * Часы турнира. Раздача по времени — вежливость, а не гарантия: на спящем
   * хостинге таймер не тикает, поэтому итоги всё равно наступают при первом
   * взгляде на турнир. Здесь мы лишь стараемся, чтобы взгляд не понадобился.
   */
  const tourneyClock = setInterval(
    () => void settleTourneys().catch((error: unknown) => app.log.error(error, 'tourney settle failed')),
    5 * 60_000,
  );
  tourneyClock.unref?.();
  app.addHook('onClose', () => clearInterval(tourneyClock));

  // ---------- Служба ----------

  /**
   * Служащий ли это. Прав в игре у него ровно столько же, сколько у всех:
   * служба — это не «может больше», а «отвечает за прибор». Единственное,
   * что она даёт, — служебный пульт над чужими аккаунтами, и каждое
   * движение там записывается в журнал.
   */
  const admins = new Set(options.adminTelegramIds ?? []);
  const isAdmin = async (userId: string): Promise<boolean> => {
    if (admins.size === 0) return false;
    const ids = await store.telegramIdsOf(userId);
    return ids.some((id) => admins.has(id));
  };

  /**
   * Пускает в служебную дверь. Не служащему отвечаем «нет такой страницы»,
   * как и наладка: знать, что пульт существует, посторонним незачем.
   */
  const servant = async (
    request: FastifyRequest,
    reply: { code(status: number): { send(body: unknown): unknown } },
  ): Promise<TokenPayload | null> => {
    let user: TokenPayload;
    try {
      user = await requireUser(request);
    } catch {
      reply.code(404).send({ error: 'not-found' });
      return null;
    }
    if (!(await isAdmin(user.sub))) {
      reply.code(404).send({ error: 'not-found' });
      return null;
    }
    return user;
  };

  /** Поиск игрока: одной строкой по имени, коду друга, Telegram или номеру. */
  app.get('/api/admin/find', async (request, reply) => {
    const user = await servant(request, reply);
    if (!user) return reply;
    const parsed = AdminFindQuerySchema.safeParse((request.query as { q?: string }).q ?? '');
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const response: AdminFindResponse = { found: await store.findPlayers(parsed.data) };
    return response;
  });

  /** Карточка игрока: то же, что видит он сам, плюс служебное. */
  app.get('/api/admin/card', async (request, reply) => {
    const user = await servant(request, reply);
    if (!user) return reply;
    const id = (request.query as { id?: string }).id ?? '';
    const found = await store.findPlayers(id, 1);
    const row = found.find((player) => player.id === id);
    if (!row) return reply.code(404).send({ error: 'no-player' });
    const [rating, marks, art, frame, avatar, duels, sprint, order, earned] = await Promise.all([
      store.ratingOf(id),
      store.marksOf(id),
      store.artOf(id),
      store.frameOf(id),
      store.avatarOf(id),
      store.duelRecord(id),
      store.bestSprint(id),
      store.bestOrder(id),
      ownedMarks(id),
    ]);
    const card: AdminCard = {
      ...row,
      rating: rating.rating,
      league: leagueOf(rating.rating).name,
      marks,
      art,
      frame,
      avatar,
      duels,
      sprint,
      order,
      earned,
    };
    return card;
  });

  /**
   * Жетоны игроку. Ставим числом, а не прибавкой: страница могла показывать
   * устаревший счёт, и «прибавить сто» превратилось бы в лотерею.
   */
  app.post('/api/admin/tokens', async (request, reply) => {
    const user = await servant(request, reply);
    if (!user) return reply;
    const parsed = AdminTokensRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const { userId, tokens, reason } = parsed.data;
    const was = await store.tokensOf(userId);
    await store.setTokens(userId, tokens);
    await note(user, userId, 'жетоны', `${was} → ${tokens}`, reason);
    return { tokens };
  });

  /**
   * Снять рисунок с пропуска. Это единственное в приборе, что игрок рисует
   * сам, — и единственное, что может оказаться непристойным. Место под свой
   * шильдик при этом остаётся: оно куплено за жетоны, и снимаем мы картинку,
   * а не покупку.
   */
  app.post('/api/admin/art/clear', async (request, reply) => {
    const user = await servant(request, reply);
    if (!user) return reply;
    const parsed = AdminUserRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const { userId, reason } = parsed.data;
    const was = await store.artOf(userId);
    await store.clearArt(userId);
    // В журнал пишем размер, а не сам рисунок: сто знаков подряд в строке
    // «было → стало» читать невозможно, а восстанавливать рисунок незачем —
    // игрок нарисует новый.
    await note(
      user,
      userId,
      'рисунок снят',
      was === null ? 'рисунка не было' : `закрашено ${artPainted(was)}`,
      reason,
    );
    return { art: null };
  });

  /**
   * Сменить имя. Право игрока на собственную замену при этом возвращается:
   * за чужое решение он платить не должен.
   */
  app.post('/api/admin/name', async (request, reply) => {
    const user = await servant(request, reply);
    if (!user) return reply;
    const parsed = AdminNameRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const { userId, name, reason } = parsed.data;
    const was = await store.nameOf(userId);
    if (was === null) return reply.code(404).send({ error: 'no-player' });
    await store.renameByService(userId, name);
    await note(user, userId, 'имя', `${was} → ${name}`, reason, name);
    return { name };
  });

  /**
   * Наказать. Срок в днях или навсегда; причина обязательна и уезжает
   * игроку — наказание, о котором не сказано за что, это просто поломка
   * прибора.
   *
   * Бан закрывает всё, что за входом: заходы, дуэли, таблицы, покупки,
   * корпус. Открытой остаётся одна дверь — своя карточка, чтобы наказанный
   * увидел срок и причину.
   *
   * Против гостя это лежачий полицейский: новый гостевой аккаунт заводится
   * в одно касание. По-настоящему бан держит того, кто вошёл через Telegram:
   * тот же номер приведёт в тот же — наказанный — аккаунт.
   */
  app.post('/api/admin/ban', async (request, reply) => {
    const user = await servant(request, reply);
    if (!user) return reply;
    const parsed = AdminBanRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const { userId, days, reason } = parsed.data;
    if (userId === user.sub) return reply.code(400).send({ error: 'self' });
    if (await isAdmin(userId)) return reply.code(400).send({ error: 'servant' });
    const name = await store.nameOf(userId);
    if (name === null) return reply.code(404).send({ error: 'no-player' });
    const until = await store.ban(userId, days, reason);
    banned.set(userId, { until, reason });
    await note(user, userId, 'бан', days === null ? 'навсегда' : `${days} дн.`, reason, name);
    const ban: BanInfo = { until, reason };
    return ban;
  });

  /** Простить. Причина остаётся в журнале — снятие такое же решение, как бан. */
  app.post('/api/admin/unban', async (request, reply) => {
    const user = await servant(request, reply);
    if (!user) return reply;
    const parsed = AdminUserRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const { userId, reason } = parsed.data;
    const was = banned.get(userId);
    await store.unban(userId);
    banned.delete(userId);
    await note(user, userId, 'бан снят', was === undefined ? 'бана не было' : was.reason, reason);
    return { ban: null };
  });

  /** Очередь жалоб: на кого жалуются и сколько человек. */
  app.get('/api/admin/reports', async (request, reply) => {
    const user = await servant(request, reply);
    if (!user) return reply;
    const response: AdminReportsResponse = { reports: await store.openReports() };
    return response;
  });

  /**
   * Жалобы разобраны. Записи не стираются — по ним видно, что на человека
   * уже жаловались; они лишь уходят из очереди.
   */
  app.post('/api/admin/reports/clear', async (request, reply) => {
    const user = await servant(request, reply);
    if (!user) return reply;
    const parsed = AdminUserRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const { userId, reason } = parsed.data;
    const count = await store.clearReports(userId, user.sub);
    await note(user, userId, 'жалобы разобраны', `${count}`, reason);
    return { cleared: count };
  });

  /**
   * Что заметил сам прибор: заходы, не похожие на человеческие.
   *
   * Отдельно от жалоб, и это важно. Жалоба — мнение игрока, её надо
   * проверять; здесь же лежит измеренное, но измеренное косвенно: сильная
   * игра и перебор отличаются числом, а не природой. Поэтому список ничего
   * не предлагает сделать — служащий смотрит карточку и решает сам.
   */
  app.get('/api/admin/notices', async (request, reply) => {
    const user = await servant(request, reply);
    if (!user) return reply;
    const response: AdminNoticesResponse = { notices: await store.notices() };
    return response;
  });

  /** Журнал: кто, кого, когда и почему. Новые записи сверху. */
  app.get('/api/admin/log', async (request, reply) => {
    const user = await servant(request, reply);
    if (!user) return reply;
    const response: AdminLogResponse = { entries: await store.adminLog() };
    return response;
  });

  /** Запись в журнал. Зовётся из каждого действия — молчаливых тут нет. */
  async function note(
    admin: TokenPayload,
    targetId: string,
    action: string,
    detail: string,
    reason: string,
    targetName?: string,
  ): Promise<void> {
    await store.logAdmin({
      adminId: admin.sub,
      adminName: admin.name,
      targetId,
      targetName: targetName ?? (await store.nameOf(targetId)) ?? '—',
      action,
      detail,
      reason,
    });
  }

  // ---------- Наладка ----------

  /**
   * Служебный режим: прибор со снятой задней крышкой.
   *
   * Он нужен ровно затем, чтобы посмотреть все состояния, до которых игрой
   * идти часами: полный корпус, все оправы, свой шильдик, лига, пустой
   * аккаунт новичка. Играть это не помогает никак — ни поле, ни правила, ни
   * счёт отсюда не трогаются: наладка выдаёт только украшения и жетоны.
   *
   * Две вещи держат её безопасной:
   *
   * 1. **Без ключа дверей нет.** Не «403», а `404`: сервер без `SERVICE_KEY`
   *    отвечает так же, как на любой выдуманный адрес.
   * 2. **Только над собой.** Кого налаживать, говорит не тело запроса, а
   *    токен игрока: чужой аккаунт этой дверью не достать вовсе, и
   *    воровать чей-то ключ ради чужого корпуса бессмысленно.
   */
  const service = async (
    request: FastifyRequest,
    reply: { code(status: number): { send(body: unknown): unknown } },
  ): Promise<TokenPayload | null> => {
    if (!options.serviceKey) {
      reply.code(404).send({ error: 'not-found' });
      return null;
    }
    const given = request.headers['x-service-key'];
    if (typeof given !== 'string' || given !== options.serviceKey) {
      reply.code(404).send({ error: 'not-found' });
      return null;
    }
    return requireUser(request);
  };

  /** Что у игрока стало после наладки — тем же составом, что и покупка. */
  const belongings = async (userId: string): Promise<BuyResponse> => {
    const [tokens, earned] = await Promise.all([store.tokensOf(userId), ownedMarks(userId)]);
    return { tokens, earned, slots: openSlots(earned) };
  };

  /**
   * Выдать всё: каждую наклейку, каждую оправу, все ячейки корпуса, место
   * под свой рисунок и жетонов с запасом. Отметки за игру и золото сюда не
   * входят намеренно — их и в наладке не выдают: посмотреть, как отметка
   * выглядит на корпусе, можно и не присваивая её себе.
   */
  app.post('/api/service/all', async (request, reply) => {
    const user = await service(request, reply);
    if (!user) return reply;
    const sale = [
      ...MARKS.filter((mark) => mark.price !== undefined).map((mark) => mark.id),
      ...FRAMES.map((frame) => frame.id),
      ...SERVICE_SLOTS,
    ];
    for (const id of sale) await store.grantMark(user.sub, id);
    await store.setTokens(user.sub, SERVICE_TOKENS);
    return belongings(user.sub);
  });

  /**
   * Снять всё: ни жетонов, ни купленного, ни выданного, ни надетого, ни
   * нарисованного. Так прибор выглядит у того, кто открыл его впервые, —
   * а посмотреть на это иначе можно только заводя новый аккаунт.
   */
  app.post('/api/service/none', async (request, reply) => {
    const user = await service(request, reply);
    if (!user) return reply;
    await store.clearBelongings(user.sub);
    return belongings(user.sub);
  });

  /**
   * Точные числа: жетоны и рейтинг. Жетонами проверяют цену («не хватает»
   * — тоже состояние), рейтингом — лиги и калибровку, до которых игрой идти
   * пять матчей.
   */
  app.post('/api/service/set', async (request, reply) => {
    const user = await service(request, reply);
    if (!user) return reply;
    const parsed = ServiceRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const { tokens, rating, games } = parsed.data;
    if (tokens !== undefined) await store.setTokens(user.sub, tokens);
    if (rating !== undefined) {
      // Рейтинг ставим обеим механикам разом: лига на пропуске одна, и
      // расхождение между цепочками и тапом здесь только мешало бы.
      const played = games ?? PLACEMENT_GAMES;
      await store.setRating(user.sub, rating, played, 'chain');
      await store.setRating(user.sub, rating, played, 'order');
    }
    return belongings(user.sub);
  });

  // ---------- Спринт ----------

  /**
   * Заход спринта. Клиент присылает ходы, сервер переигрывает их ядром и
   * сам считает счёт: в таблицу попадает только подтверждённое пересчётом.
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
    // Смотрим только на рекорды: проходной заход в таблицу не идёт, и
    // забивать им журнал службы незачем.
    if (saved.improved) await notice(user.sub, 'рекорд', replay, parsed.data.moves);
    const { shift } = await payToken(user.sub);
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
      ...(shift > 0 ? { shift } : {}),
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
      ...artField(row.art),
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
      const art = isOwnMark(mark) ? artField(await store.artOf(user.sub)) : {};
      if (best > 0 && rank !== null) me = { rank, name: user.name, score: best, mark, ...art };
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
    const { shift } = await payToken(user.sub);
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
      ...(shift > 0 ? { shift } : {}),
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
      ...artField(row.art),
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
      const art = isOwnMark(mark) ? artField(await store.artOf(user.sub)) : {};
      if (best > 0 && rank !== null) me = { rank, name: user.name, score: best, orders, mark, ...art };
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

  /** Карточка игрока: рейтинг, лига, место и сводка по дуэлям. */
  app.get('/api/me', async (request): Promise<MeResponse> => {
    const user = await requireAnyUser(request);
    const [
      rating,
      rank,
      duels,
      identities,
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
      art,
      admin,
      telegramIds,
      current,
    ] = await Promise.all([
        store.ratingOf(user.sub),
        store.ratingRank(user.sub),
        store.duelRecord(user.sub),
        store.identitiesOf(user.sub),
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
        store.artOf(user.sub),
        isAdmin(user.sub),
        store.telegramIdsOf(user.sub),
        store.nameOf(user.sub),
      ]);
    const up = nextLeague(rating.rating);
    const league = leagueOf(rating.rating);
    /*
     * Имя берём из базы, а не из токена. Обычно они совпадают — токен и
     * выдаётся с именем, — но службе имя менять можно, а чужой токен ей не
     * переписать. Раньше карточка повторяла токен, и снятое службой имя
     * менялось для всех, кроме самого игрока: у него оно жило до следующего
     * входа. Разошлось — выдаём новый пропуск тут же, вместе с карточкой.
     */
    const name = current ?? user.name;
    const reissued = name === user.name ? {} : { token: issueToken(user.sub, name).token };
    return {
      name,
      ...reissued,
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
      slots: openSlots(earned),
      earned,
      canRename: !renamed,
      tokens,
      frame,
      art,
      admin,
      telegram: telegramIds[0] ?? null,
      ban: banOf(user.sub),
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

  /**
   * Что клиенту нужно знать о сервере: как построить ссылки в Telegram.
   *
   * Имя бота спрашиваем прямо здесь, если оно ещё не известно. Раньше его
   * узнавали только при старте, не дожидаясь ответа, — а на спящем хостинге
   * сервер будит первый же запрос игрока, и клиент успевал спросить конфиг
   * раньше, чем приезжало имя. Ответ «бота нет» клиент запоминал на весь
   * сеанс, и привязка Telegram молча пропадала до перезагрузки страницы.
   */
  app.get('/api/config', async (): Promise<{ bot: string | null; miniApp: string | null }> => {
    if (!bot) return { bot: null, miniApp: null };
    await bot.resolveUsername();
    return { bot: bot.knownUsername, miniApp: bot.miniAppLink('') };
  });

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
   * Жалоба на игрока. Единственная дверь, которой игрок говорит о другом
   * игроке, — и потому единственная, куда стоит смотреть, ожидая злоупотреблений.
   *
   * Называют соперника кодом друга: он уже есть у клиента после матча, а
   * номера чужого аккаунта игрок не видит нигде. На что жалуются, не
   * спрашиваем — служба смотрит карточку целиком; повторная жалоба от того
   * же на того же ничего не добавляет.
   */
  app.post('/api/reports', async (request, reply) => {
    const user = await requireUser(request);
    const parsed = ReportRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad-request' });
    const target = await store.userByFriendCode(parsed.data.code.toUpperCase());
    if (!target) return reply.code(404).send({ error: 'no-such-code' });
    if (target.id === user.sub) return reply.code(400).send({ error: 'self' });
    await store.addReport(user.sub, target.id);
    return { ok: true };
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
      ...artField(row.art),
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
        const mark = marks.find((id) => id !== null) ?? null;
        me = {
          rank,
          name: user.name,
          rating: rating.rating,
          league: leagueOf(rating.rating).name,
          mark,
          ...(isOwnMark(mark) ? artField(await store.artOf(user.sub)) : {}),
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
    // Наказанного в матч не пускаем: дуэль — то, ради чего бан и бывает.
    if (banOf(user.sub)) {
      socket.send(JSON.stringify({ type: 'error', error: 'banned' } satisfies DuelServerMessage));
      socket.close();
      return;
    }

    const player: DuelPlayer = {
      id: user.sub,
      // Имя из токена — стартовое: сразу за этим его уточняет чтение из базы.
      name: user.name,
      send: (message: DuelServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
    };

    // Код друга нужен сопернику на экране результата, шильдики — с первой
    // секунды матча: на время дуэли соперник занимает корпус целиком.
    // Читаем один раз при подключении, но в подбор пускаем только после:
    // раньше это была гонка, и при быстром подборе соперник получал матч без
    // корпуса и без кода — а без кода нет ни «в друзья», ни жалобы.
    const known = Promise.all([
      store.friendCodeOf(user.sub),
      store.marksOf(user.sub),
      store.frameOf(user.sub),
      store.artOf(user.sub),
      // Имя тоже читаем: в токене оно могло остаться прежним, если игрока
      // переименовала служба, а соперник должен видеть нынешнее.
      store.nameOf(user.sub),
    ])
      .then(([code, marks, frame, art, name]) => {
        if (code) player.code = code;
        player.marks = marks;
        if (frame) player.frame = frame;
        if (art) player.art = art;
        if (name) player.name = name;
      })
      .catch((error: unknown) => app.log.error(error, 'duel player lookup failed'));

    /**
     * Ждём, пока прочитается корпус, и только потом становимся в очередь.
     * Задержка тут в один запрос к базе, а цена спешки — матч, в котором
     * соперник безымянный.
     */
    const joinWhenKnown = (room: string | undefined, kind: DuelKind): void => {
      void known.then(() => {
        // Сокет мог закрыться, пока читали: в очередь ставить уже некого.
        if (socket.readyState === socket.OPEN) matchmaker.join(player, room, kind);
      });
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
          joinWhenKnown(message.data.room, message.data.kind ?? 'chain');
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
