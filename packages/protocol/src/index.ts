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

export interface ApiError {
  error: string;
}
