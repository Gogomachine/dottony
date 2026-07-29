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

export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

export const SubmitDailyRequestSchema = z.object({
  date: DateSchema,
  moves: z.array(MoveLogSchema).max(400),
});

export const GuestAuthRequestSchema = z.object({
  name: z.string().trim().min(1).max(24),
});

export const TelegramAuthRequestSchema = z.object({
  initData: z.string().min(1).max(8192),
});

export type Cell = z.infer<typeof CellSchema>;
export type MoveLog = z.infer<typeof MoveLogSchema>;
export type SubmitDailyRequest = z.infer<typeof SubmitDailyRequestSchema>;
export type GuestAuthRequest = z.infer<typeof GuestAuthRequestSchema>;
export type TelegramAuthRequest = z.infer<typeof TelegramAuthRequestSchema>;

export interface AuthResponse {
  token: string;
  user: { id: string; name: string };
}

export interface DailyInfo {
  date: string;
  seed: number;
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  score: number;
}

export interface LeaderboardResponse {
  date: string;
  entries: LeaderboardEntry[];
  /** Строка текущего игрока, если он в таблице. */
  me: LeaderboardEntry | null;
}

export interface SubmitDailyResponse {
  score: number;
  rank: number;
}

export interface RatingEntry {
  rank: number;
  name: string;
  rating: number;
  league: string;
}

export interface MeResponse {
  name: string;
  rating: number;
  deviation: number;
  league: string;
  /** Следующая лига и сколько очков до неё; null — уже на вершине. */
  next: { league: string; gap: number } | null;
  /** Место в таблице; null, пока игрок не прошёл калибровку. */
  rank: number | null;
  /** Сколько рейтинговых матчей сыграно и сколько нужно; null — калибровка пройдена. */
  placement: { played: number; required: number } | null;
  duels: { played: number; won: number };
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
  /** Сколько секунд матча осталось. */
  remaining: number;
  /** Серия зарядов, чтобы множитель не сбросился. */
  streak: number;
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
    }
  /** Ход принят: сервер подтверждает начисленные очки. */
  | { type: 'accepted'; score: number; points: number }
  /** Ход отклонён — клиент рассинхронизировался, поле стоит перечитать. */
  | { type: 'rejected'; reason: string }
  | { type: 'opponent'; score: number }
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
