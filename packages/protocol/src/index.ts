import { z } from 'zod';

/**
 * Контракт клиент ↔ сервер. Клиент импортирует отсюда только типы
 * (import type), чтобы zod не попадал в бандл; сервер валидирует схемами.
 */

export const CellSchema = z.object({
  r: z.number().int().min(0).max(15),
  c: z.number().int().min(0).max(15),
});

/** Один ход реплея: путь цепочки и секунда партии, на которой он сделан. */
export const MoveLogSchema = z.object({
  path: z.array(CellSchema).min(3).max(64),
  t: z.number().min(0).max(600),
});

/**
 * Заход спринта на проверку. Сид выбирает клиент — поле у каждого своё,
 * общего расклада тут нет; сервер лишь переигрывает по нему ходы.
 */
export const SubmitSprintRequestSchema = z.object({
  seed: z.number().int().min(0).max(0xffffffff),
  moves: z.array(MoveLogSchema).min(1).max(400),
});

export const NameSchema = z.string().trim().min(1).max(24);

export const GuestAuthRequestSchema = z.object({ name: NameSchema });

export const RenameRequestSchema = z.object({ name: NameSchema });

/**
 * Смайлик на пропуске. Требуем хотя бы один пиктографический символ и
 * запрещаем буквы с цифрами: иначе вместо лица игрок поставит слово, а
 * место под фото рассчитано на один знак.
 */
export const AvatarSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .refine(
    (value) => /\p{Extended_Pictographic}/u.test(value) && !/[\p{L}\p{N}]/u.test(value),
    'bad-avatar',
  );

export const AvatarRequestSchema = z.object({ avatar: AvatarSchema });

/** Код друга: шесть символов без похожих начертаний, регистр не важен. */
export const FriendCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4,12}$/, 'bad-code');

export const AddFriendRequestSchema = z.object({ code: FriendCodeSchema });

/**
 * Заход режима заказов. Ход здесь — одно касание, поэтому и присылается
 * одна клетка: остальное — группу под ней, награду, смену окна — сервер
 * считает сам, переигрывая заход ядром от сида. Числу клиента он не верит
 * вовсе.
 */
export const OrderMoveSchema = z.object({
  cell: CellSchema,
  /** Секунда захода. Заход кончается сбоями, а не часами. */
  t: z.number().min(0).max(86_400),
});

/** Потолок журнала захода: столько ходов клиент готов доказать. */
export const ORDER_MOVE_LIMIT = 1200;

export const SubmitOrderRequestSchema = z.object({
  seed: z.number().int().min(0).max(0xffffffff),
  moves: z.array(OrderMoveSchema).min(1).max(ORDER_MOVE_LIMIT),
});

/** Приглашение друга в комнату: код комнаты тот же, что у приватной дуэли. */
/**
 * Шильдики корпуса: три номера из каталога ядра. Что номер существует и
 * положен игроку, проверяет уже сервер — схема ловит только форму.
 */
export const MarksRequestSchema = z.object({
  marks: z.array(z.string().max(16).nullable()).max(3),
});

/**
 * Покупка за жетоны: номер наклейки или оправы из каталога ядра. Цену
 * клиент не присылает — её знает сервер, и присланная цена была бы
 * приглашением назначить себе свою.
 */
export const BuyRequestSchema = z.object({
  id: z.string().max(16),
});

/** Оправа полосы шильдиков; null — снять. Что она куплена, проверяет сервер. */
export const FrameRequestSchema = z.object({
  frame: z.string().max(16).nullable(),
});

/**
 * Свой рисунок на пропуск: запись листа из `art.ts` ядра. Длину сторожим
 * здесь, а сами знаки — там же, в ядре: схема ловит форму, каталог красок
 * знает, какие номера в ней бывают.
 */
export const ArtRequestSchema = z.object({
  art: z.string().length(100),
});

/**
 * Служебная наладка: точные числа вместо игрового пути. Границы здесь не
 * про честность (за этой дверью честности нет и не должно быть), а про то,
 * чтобы прибор не показывал ерунду: рейтинг вне шкалы нарисовал бы лигу,
 * которой не бывает.
 */
export const ServiceRequestSchema = z.object({
  tokens: z.number().int().min(0).max(1_000_000).optional(),
  rating: z.number().int().min(0).max(4000).optional(),
  games: z.number().int().min(0).max(1000).optional(),
});

/**
 * Служба: действия над чужим аккаунтом. Причина обязательна и не пустая —
 * не ради бюрократии, а потому что через неделю ни один админ не помнит, за
 * что снял игроку имя, а игрок помнит всегда.
 */
export const AdminReasonSchema = z.string().trim().min(3).max(200);

export const AdminTokensRequestSchema = z.object({
  userId: z.string().min(1).max(64),
  /** Сколько станет. Не «прибавить»: у прибавки нет верного значения, если
   * страница показывает устаревший счёт. */
  tokens: z.number().int().min(0).max(1_000_000),
  reason: AdminReasonSchema,
});

export const AdminUserRequestSchema = z.object({
  userId: z.string().min(1).max(64),
  reason: AdminReasonSchema,
});

export const AdminNameRequestSchema = z.object({
  userId: z.string().min(1).max(64),
  name: NameSchema,
  reason: AdminReasonSchema,
});

/** Строка поиска: имя, код друга, Telegram-id или номер аккаунта. */
export const AdminFindQuerySchema = z.string().trim().min(1).max(64);

/** Строка списка найденных: столько, чтобы узнать нужного и не больше. */
export interface AdminFound {
  id: string;
  name: string;
  code: string | null;
  rating: number;
  tokens: number;
  /** Способы входа: по ним видно, гость это или человек из Telegram. */
  identities: string[];
  /** Когда игрока последний раз видели в приборе; null — ни разу. */
  seenAt: string | null;
}

/** Карточка игрока в службе: то же, что видит он сам, плюс служебное. */
export interface AdminCard extends AdminFound {
  league: string;
  /** Шильдики корпуса и рисунок — то, что видно сопернику. */
  marks: (string | null)[];
  art: string | null;
  frame: string | null;
  avatar: string | null;
  duels: { played: number; won: number };
  sprint: number;
  order: number;
  /** Всё, что игроку положено носить. */
  earned: string[];
}

/** Запись журнала службы: без него отменить чужое решение нечем. */
export interface AdminLogEntry {
  at: string;
  admin: string;
  target: string;
  targetName: string;
  action: string;
  detail: string;
  reason: string;
}

export interface AdminFindResponse {
  found: AdminFound[];
}

export interface AdminLogResponse {
  entries: AdminLogEntry[];
}

export const InviteRequestSchema = z.object({
  room: z.string().trim().min(4).max(16),
});

export const TelegramAuthRequestSchema = z.object({
  initData: z.string().min(1).max(8192),
});

/*
 * Наружу выведены только те типы запросов, которые кто-то читает: сервер
 * берёт разобранные данные прямо из safeParse, клиент собирает тело
 * запроса на месте. Остальные схемы говорят за себя — плодить рядом с
 * ними алиасы «на всякий случай» нечего.
 */
export type Cell = z.infer<typeof CellSchema>;
export type MoveLog = z.infer<typeof MoveLogSchema>;
export type OrderMove = z.infer<typeof OrderMoveSchema>;

export interface AuthResponse {
  token: string;
  user: { id: string; name: string };
}

/** Ответ на присланный спринт: что насчитало ядро и куда это ставит игрока. */
export interface SubmitSprintResponse {
  /** Счёт этого захода — по пересчёту сервера. */
  score: number;
  /** Личный рекорд после захода. */
  best: number;
  /** Рекорд обновлён. */
  record: boolean;
  rank: number;
}

/**
 * Период таблицы рекордов: сегодняшний день или всё время. День считается
 * по календарной дате UTC — он кончается у всех одновременно, а не
 * разъезжается по часовым поясам.
 */
export type BoardPeriod = 'day' | 'all';

/**
 * Шильдик рядом с именем: номер из каталога ядра; null — корпус чист.
 *
 * У своего шильдика рядом с номером едет и картинка: номер у него общий на
 * всех, а нарисован он у каждого свой. Приходит она только с тем, кто его и
 * правда носит, — таблица на полсотни строк не должна возить сотню лишних
 * знаков на каждого.
 */
export interface SprintEntry {
  rank: number;
  name: string;
  score: number;
  mark: string | null;
  art?: string;
}

export interface SprintLeaderboardResponse {
  entries: SprintEntry[];
  me: SprintEntry | null;
}

/** Ответ на присланный заход: что насчитало ядро и куда это ставит игрока. */
export interface SubmitOrderResponse {
  /** Счёт захода — по пересчёту сервера. */
  score: number;
  /** Сколько заказов в нём закрыто. */
  orders: number;
  /** Личный рекорд после захода. */
  best: number;
  /** Рекорд обновлён. */
  record: boolean;
  rank: number;
}

export interface OrderEntry {
  rank: number;
  name: string;
  score: number;
  /** Сколько заказов закрыто в рекордном заходе. */
  orders: number;
  mark: string | null;
  /** Рисунок — только у того, кто носит свой шильдик. */
  art?: string;
}

export interface OrderLeaderboardResponse {
  entries: OrderEntry[];
  me: OrderEntry | null;
}

/** Приглашение на дуэль, ждущее игрока прямо в игре. */
export interface InviteInfo {
  /** Имя позвавшего и его шильдик — тот же, что видно в таблицах. */
  from: string;
  mark: string | null;
  /** Рисунок — только у того, кто носит свой шильдик. */
  art?: string;
  /** Комната, в которую он зовёт. */
  room: string;
}

export interface RatingEntry {
  rank: number;
  name: string;
  rating: number;
  league: string;
  mark: string | null;
  /** Рисунок — только у того, кто носит свой шильдик. */
  art?: string;
}

/** Способ входа в аккаунт: с чего начали и что привязали потом. */
export interface IdentityInfo {
  kind: 'guest' | 'telegram' | 'ton';
  linkedAt: string;
}

/** Строка истории матчей в личном кабинете. */
export interface DuelHistoryEntry {
  duelId: string;
  playedAt: string;
  score: number;
  outcome: 'win' | 'loss' | 'draw' | null;
  /** Соперника может не быть в записи: он ушёл до сохранения. */
  opponent: string | null;
  opponentScore: number | null;
  /** Соперник был записью чужой партии. */
  ghost: boolean;
  /** На чём играли: цепочки или заказы. */
  kind: DuelKind;
  /** Сдвиг рейтинга; null — матч был нерейтинговым. */
  rating: { before: number; after: number } | null;
  /** Партию можно прокрутить заново; в заказах прокрутки пока нет. */
  replay: boolean;
}

export interface DuelHistoryResponse {
  entries: DuelHistoryEntry[];
}

/**
 * Заявка на цвет резонанса: цепочка, взявшая фазу цикла. В реплее без неё
 * не обойтись — цвет фазы решали оба игрока, а ходы записаны только свои.
 */
export interface ClaimLog {
  cycle: number;
  color: number;
  length: number;
  t: number;
  /** Заявка того, чей это реплей. */
  mine: boolean;
}

/** Данные для прокрутки матча: поле восстанавливается из сида. */
export interface ReplayResponse {
  seed: number;
  moves: MoveLog[];
  score: number;
  opponent: string | null;
  /** Заявки обоих игроков; пусто у матчей, сыгранных до этой механики. */
  claims: ClaimLog[];
}

export interface FriendEntry {
  code: string;
  name: string;
  rating: number;
  league: string;
  /** Личный счёт: сколько сыграно между собой и сколько из них выиграно. */
  record: { played: number; won: number };
  /** Рейтинг ещё калибруется — показывать его как звание рано. */
  provisional: boolean;
}

/** Тот, с кем недавно играли, но ещё не в друзьях. */
export interface RecentOpponent {
  code: string;
  name: string;
  playedAt: string;
}

export interface FriendsResponse {
  /** Свой код — его диктуют или шлют ссылкой. */
  code: string;
  friends: FriendEntry[];
  recent: RecentOpponent[];
}

export interface MeResponse {
  name: string;
  /**
   * Осталась ли замена имени. Она одна на аккаунт: имя приходит из Telegram,
   * и одной осознанной замены хватает — дальше по нему игрока знают соперники
   * и таблицы.
   */
  canRename: boolean;
  /**
   * Жетоны: валюта прибора. Копятся за доведённые до конца заходы и матчи —
   * по одному за каждый, и за матч столько же, сколько за соло.
   */
  tokens: number;
  /** Смайлик на пропуске; null — игрок его ещё не ставил. */
  avatar: string | null;
  rating: number;
  deviation: number;
  league: string;
  /** Нижняя граница текущей лиги — из неё считается прогресс до следующей. */
  leagueFrom: number;
  /** Следующая лига и сколько очков до неё; null — уже на вершине. */
  next: { league: string; gap: number } | null;
  /** Место в таблице; null, пока игрок не прошёл калибровку. */
  rank: number | null;
  /** Сколько рейтинговых матчей сыграно и сколько нужно; null — калибровка пройдена. */
  placement: { played: number; required: number } | null;
  duels: { played: number; won: number };
  /** Способы входа: гость, Telegram, кошелёк. */
  identities: IdentityInfo[];
  /**
   * Рейтинг дуэлей на заказах. Отдельный от цепочек: механики разные, и
   * одно число на двоих врало бы про обе.
   */
  orderDuel: {
    rating: number;
    league: string;
    rank: number | null;
    placement: { played: number; required: number } | null;
  };
  /** Цепочки: личный рекорд за заход и место в таблице. */
  sprint: { best: number; rank: number | null };
  /** Тап: лучший заход, сколько в нём сделано и место в таблице. */
  order: { best: number; orders: number; rank: number | null };
  /** Шильдики корпуса: три ячейки, пустая — null. */
  marks: (string | null)[];
  /**
   * Сколько ячеек корпуса открыто. Первая есть у всех, вторая и третья
   * покупаются за жетоны — цены лежат в каталоге ядра.
   */
  slots: number;
  /**
   * Всё, что игроку положено носить: выданное за игру, купленное за жетоны
   * (наклейки и оправы) и золото, пока он держит таблицу. Даром не носится
   * ничего — пустой корпус в начале это не поломка, а начало пути.
   */
  earned: string[];
  /** Надетая оправа полосы шильдиков; null — полоса без оправы. */
  frame: string | null;
  /**
   * Служба: игрок значится в списке служащих прибора. Не «может больше» в
   * игре — в игре он ровно такой же, — а «видит служебный пульт».
   */
  admin: boolean;
  /**
   * Свой номер в Telegram; null — вход не привязан. Нужен затем, чтобы
   * человек мог сверить его со списком служащих на сервере: без этого
   * закрытый пульт нечем отличить от опечатки в настройке. Это свой
   * собственный номер и приходит он только своему хозяину.
   */
  telegram: string | null;
  /**
   * Свой рисунок на пропуске: запись листа из `art.ts` ядра; null — игрок
   * своего шильдика ещё не покупал. Хранится на сервере, а не только в
   * устройстве: его видит соперник, и с нового телефона он должен приехать
   * вместе с остальным пропуском.
   */
  art: string | null;
}

/** Что стало после покупки: остаток жетонов и обновлённый список своего. */
export interface BuyResponse {
  tokens: number;
  earned: string[];
  /** Сколько ячеек корпуса открыто: покупкой могла быть и ячейка. */
  slots: number;
}

export interface RatingLeaderboardResponse {
  entries: RatingEntry[];
  me: RatingEntry | null;
}

export interface ApiError {
  error: string;
}

// ---------- Дуэли (WebSocket) ----------

/**
 * На чём играется дуэль. Механики две, и они не смешиваются: в цепочках
 * ведут пальцем и ловят резонанс, в заказах снимают группу одним касанием
 * за окно. Подбор идёт отдельно для каждой — иначе матч был бы про то, кто
 * во что играет, а не кто как играет.
 */
export const DuelKindSchema = z.enum(['chain', 'order']);
export type DuelKind = z.infer<typeof DuelKindSchema>;

/**
 * Длительность дуэли по механикам, сек.
 *
 * У цепочек полторы минуты: там счёт растёт с каждого хода, и полторы
 * минуты — это уже полсотни ходов. В заказах счёт даёт только закрытое
 * окно, а пятно нужного цвета растят несколько окон подряд: за то же время
 * матч решался бы тем, кому раньше повезло с раскладом. Поэтому там три
 * минуты — десять окон, место и на разгон, и на ошибку.
 */
export const DUEL_SECONDS: Record<DuelKind, number> = { chain: 90, order: 180 };

export const DuelJoinSchema = z.object({
  type: z.literal('join'),
  /** Код приватной комнаты; без него — открытый подбор соперника. */
  room: z.string().trim().min(4).max(16).optional(),
  /** Механика матча; без поля — цепочки, как было до заказов. */
  kind: DuelKindSchema.optional(),
});

/*
 * Секунды хода здесь нет намеренно: в дуэли время считает сервер по своим
 * часам, и присланному значению всё равно не было бы веры. Лишнее поле в
 * контракте только притворялось бы, что на него смотрят.
 */
export const DuelMoveSchema = z.object({
  type: z.literal('move'),
  // Одна точка — это касание в заказах; длину цепочки проверяет само ядро,
  // и проверять её дважды, да ещё и разными числами, незачем.
  path: z.array(CellSchema).min(1).max(64),
});

export const DuelLeaveSchema = z.object({ type: z.literal('leave') });

export const DuelClientMessageSchema = z.discriminatedUnion('type', [
  DuelJoinSchema,
  DuelMoveSchema,
  DuelLeaveSchema,
]);

export type DuelClientMessage = z.infer<typeof DuelClientMessageSchema>;

/**
 * Заказ в дуэли: то, чего нет в счёте, но без чего экран не собрать —
 * какого цвета окно, сколько его осталось и сколько сбоев уже набрано.
 */
export interface DuelOrderState {
  color: number;
  /** Секунды до конца текущего окна. */
  remaining: number;
  /** Номер окна с начала матча. */
  cycle: number;
  /** Упущено окон; на третьем матч кончается поражением. */
  fails: number;
}

/** Точка поля в снимке состояния: цвет и признак заряда. */
export interface DuelDot {
  color: number;
  charged: boolean;
}

/**
 * Снимок матча для возвращения игрока после обрыва связи.
 * Сервер — источник истины, поэтому шлём и поле, и счёт, и остаток времени.
 */
export interface DuelSnapshot {
  seed: number;
  /** Механика матча: от неё зависит и поле, и правила хода. */
  kind: DuelKind;
  /** Состояние захода заказов; у дуэли на цепочках его нет. */
  order?: DuelOrderState;
  grid: DuelDot[][];
  score: number;
  opponentScore: number;
  opponent: string;
  /** Корпус соперника: номера из каталога ядра, null — пустая ячейка. */
  opponentMarks: (string | null)[];
  /** Оправа полосы соперника; её нет — полоса рисуется обычной. */
  opponentFrame?: string;
  /** Рисунок соперника — если он носит свой шильдик. Запись из `art.ts` ядра. */
  opponentArt?: string;
  ghost: boolean;
  /** Код соперника — по нему его можно добавить в друзья. */
  opponentCode?: string;
  /** Сколько секунд матча осталось. */
  remaining: number;
  /** Серия зарядов, чтобы множитель не сбросился. */
  streak: number;
  /** Заявки на цвет резонанса: вернувшийся должен видеть тот же цвет. */
  claims: ClaimLog[];
}

/** Сообщения сервера. Поле board приходит только своё — чужое не раскрываем. */
export type DuelServerMessage =
  | { type: 'searching'; room?: string }
  /** Игрок вернулся в незаконченный матч. */
  | ({ type: 'resumed' } & DuelSnapshot)
  | {
      type: 'matched';
      seed: number;
      /** Механика матча: цепочки или заказы. */
      kind: DuelKind;
      /** Сколько секунд осталось до конца матча на момент старта. */
      duration: number;
      opponent: string;
      /** Корпус соперника: номера из каталога ядра, null — пустая ячейка. */
      opponentMarks: (string | null)[];
      /** Оправа полосы соперника; её нет — полоса рисуется обычной. */
      opponentFrame?: string;
      /** Рисунок соперника — если он носит свой шильдик. */
      opponentArt?: string;
      /** Матч против записанной попытки: соперник офлайн. */
      ghost: boolean;
      /** Код соперника — по нему его можно добавить в друзья. */
      opponentCode?: string;
    }
  /** Ход принят: сервер подтверждает начисленные очки. */
  | { type: 'accepted'; score: number; points: number }
  /** Ход отклонён — клиент рассинхронизировался, поле стоит перечитать. */
  | { type: 'rejected'; reason: string }
  /** Счёт соперника; в заказах с ним едет и его запас сбоев. */
  | { type: 'opponent'; score: number; fails?: number }
  /**
   * Заявка на цвет ближайшего резонанса — своя или соперника. Свои заявки
   * клиент тоже узнаёт отсюда, а не считает сам: окно решают серверные
   * часы, и заявка у самой границы окна иначе разошлась бы с сервером.
   */
  | { type: 'claim'; cycle: number; color: number; length: number; t: number; mine: boolean }
  | {
      type: 'finished';
      score: number;
      opponentScore: number;
      outcome: 'win' | 'loss' | 'draw';
      /** Как матч сдвинул рейтинг; отсутствует, если матч был нерейтинговым. */
      rating?: {
        before: number;
        after: number;
        league: string;
        /** Идёт калибровка: лига ещё не присвоена. */
        placement?: { played: number; required: number };
      };
    }
  | { type: 'error'; error: string };
