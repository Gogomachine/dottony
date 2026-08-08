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
 * Досыл набранного в режимах без конца партии. Ходы нужны для проверки
 * правдоподобия: сервер не видел этой партии и не может пересчитать её
 * ядром, как дуэль или спринт.
 */
export const AddScoreRequestSchema = z.object({
  points: z.number().int().min(1).max(200_000),
  moves: z.number().int().min(1).max(2000),
});

/**
 * Челлендж бесконечного режима — лучший потенциал за один ход. Ходы
 * присылаются целиком: цена хода зависит от состояния поля, а его не
 * восстановить иначе как переиграв заход от сида. Числу клиента сервер не
 * верит вовсе — он считает комбо сам.
 */
export const ComboMoveSchema = z.object({
  path: z.array(CellSchema).min(3).max(64),
  /** Секунда захода. В бесконечном режиме партия идёт хоть сутки. */
  t: z.number().min(0).max(86_400),
});

/** Потолок журнала захода: столько ходов клиент готов доказать. */
export const COMBO_MOVE_LIMIT = 1200;

export const SubmitComboRequestSchema = z.object({
  seed: z.number().int().min(0).max(0xffffffff),
  moves: z.array(ComboMoveSchema).min(1).max(COMBO_MOVE_LIMIT),
});

/** Приглашение друга в комнату: код комнаты тот же, что у приватной дуэли. */
export const InviteRequestSchema = z.object({
  room: z.string().trim().min(4).max(16),
});

export const TelegramAuthRequestSchema = z.object({
  initData: z.string().min(1).max(8192),
});

export type Cell = z.infer<typeof CellSchema>;
export type MoveLog = z.infer<typeof MoveLogSchema>;
export type SubmitSprintRequest = z.infer<typeof SubmitSprintRequestSchema>;
export type GuestAuthRequest = z.infer<typeof GuestAuthRequestSchema>;
export type RenameRequest = z.infer<typeof RenameRequestSchema>;
export type AvatarRequest = z.infer<typeof AvatarRequestSchema>;
export type AddFriendRequest = z.infer<typeof AddFriendRequestSchema>;
export type AddScoreRequest = z.infer<typeof AddScoreRequestSchema>;
export type ComboMove = z.infer<typeof ComboMoveSchema>;
export type SubmitComboRequest = z.infer<typeof SubmitComboRequestSchema>;
export type TelegramAuthRequest = z.infer<typeof TelegramAuthRequestSchema>;

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

export interface SprintEntry {
  rank: number;
  name: string;
  score: number;
}

export interface SprintLeaderboardResponse {
  entries: SprintEntry[];
  me: SprintEntry | null;
}

/** Ответ на присланный заход: что насчитало ядро и куда это ставит игрока. */
export interface SubmitComboResponse {
  /** Лучший потенциал за один ход в этом заходе — по пересчёту сервера. */
  combo: number;
  /** Личный рекорд после захода. */
  best: number;
  /** Рекорд обновлён. */
  record: boolean;
  rank: number;
}

export interface ComboEntry {
  rank: number;
  name: string;
  combo: number;
}

export interface ComboLeaderboardResponse {
  entries: ComboEntry[];
  me: ComboEntry | null;
}

export interface RatingEntry {
  rank: number;
  name: string;
  rating: number;
  league: string;
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
  /** Сдвиг рейтинга; null — матч был нерейтинговым. */
  rating: { before: number; after: number } | null;
  /** Партию можно прокрутить заново. */
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
  /** Наработка прибора: весь потенциал за всё время, во всех режимах. */
  total: number;
  /** Способы входа: гость, Telegram, кошелёк. */
  identities: IdentityInfo[];
  /** Спринт: личный рекорд за три минуты и место в таблице. */
  sprint: { best: number; rank: number | null };
  /** Челлендж бесконечного режима: лучший ход и место в таблице. */
  combo: { best: number; rank: number | null };
}

export interface RatingLeaderboardResponse {
  entries: RatingEntry[];
  me: RatingEntry | null;
}

export interface ApiError {
  error: string;
}

// ---------- Дуэли (WebSocket) ----------

/** Длительность дуэли, сек. */
export const DUEL_SECONDS = 90;

export const DuelJoinSchema = z.object({
  type: z.literal('join'),
  /** Код приватной комнаты; без него — открытый подбор соперника. */
  room: z.string().trim().min(4).max(16).optional(),
});

export const DuelMoveSchema = z.object({
  type: z.literal('move'),
  path: z.array(CellSchema).min(3).max(64),
  /** Секунда матча, на которой сделан ход. */
  t: z.number().min(0).max(DUEL_SECONDS + 5),
});

export const DuelLeaveSchema = z.object({ type: z.literal('leave') });

export const DuelClientMessageSchema = z.discriminatedUnion('type', [
  DuelJoinSchema,
  DuelMoveSchema,
  DuelLeaveSchema,
]);

export type DuelClientMessage = z.infer<typeof DuelClientMessageSchema>;

export interface DuelOpponent {
  name: string;
  score: number;
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
  grid: DuelDot[][];
  score: number;
  opponentScore: number;
  opponent: string;
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
      /** Сколько секунд осталось до конца матча на момент старта. */
      duration: number;
      opponent: string;
      /** Матч против записанной попытки: соперник офлайн. */
      ghost: boolean;
      /** Код соперника — по нему его можно добавить в друзья. */
      opponentCode?: string;
    }
  /** Ход принят: сервер подтверждает начисленные очки. */
  | { type: 'accepted'; score: number; points: number }
  /** Ход отклонён — клиент рассинхронизировался, поле стоит перечитать. */
  | { type: 'rejected'; reason: string }
  | { type: 'opponent'; score: number }
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
