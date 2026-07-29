import type {
  AuthResponse,
  DailyInfo,
  LeaderboardResponse,
  MeResponse,
  MoveLog,
  RatingLeaderboardResponse,
  SubmitDailyResponse,
} from '@doton/protocol';

/**
 * Тонкий клиент API. Без VITE_API_URL игра живёт в оффлайн-режиме:
 * ежедневный вызов играется на локальном сиде, таблицы дня нет.
 */

const BASE = import.meta.env.VITE_API_URL ?? '';

export const apiAvailable = BASE.length > 0;

const TOKEN_KEY = 'doton-token';
const NAME_KEY = 'doton-name';

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

function token(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** Токен для WebSocket: браузерный WebSocket не умеет слать заголовки. */
export function authToken(): string | null {
  return token();
}

export function apiBase(): string {
  return BASE || location.origin;
}

/**
 * Бесплатный инстанс сервера засыпает после простоя и просыпается
 * до минуты, поэтому таймаут щедрый.
 */
const REQUEST_TIMEOUT_MS = 70_000;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = token();
  if (auth) headers.Authorization = `Bearer ${auth}`;

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError('network', 0);
  }

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(String(body.error ?? 'unknown'), response.status);
  }
  return body as T;
}

interface TelegramWebApp {
  initData: string;
  ready(): void;
}

function telegramWebApp(): TelegramWebApp | null {
  const tg = (window as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
  return tg && tg.initData.length > 0 ? tg : null;
}

export function isTelegram(): boolean {
  return telegramWebApp() !== null;
}

export function savedName(): string | null {
  return localStorage.getItem(NAME_KEY);
}

/**
 * Гарантирует токен: в Telegram — по initData, иначе гостевой.
 * Имя гостя спрашивает вызывающая сторона (getGuestName) один раз.
 */
export async function ensureAuth(getGuestName: () => string): Promise<void> {
  if (token()) return;

  const tg = telegramWebApp();
  const auth = tg
    ? await request<AuthResponse>('/api/auth/telegram', {
        method: 'POST',
        body: JSON.stringify({ initData: tg.initData }),
      })
    : await request<AuthResponse>('/api/auth/guest', {
        method: 'POST',
        body: JSON.stringify({ name: getGuestName() }),
      });

  localStorage.setItem(TOKEN_KEY, auth.token);
  localStorage.setItem(NAME_KEY, auth.user.name);
}

/** Сброс токена — на случай протухшего JWT: следующий ensureAuth создаст новый. */
export function resetAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function getDaily(): Promise<DailyInfo> {
  return request<DailyInfo>('/api/daily');
}

export function submitDaily(date: string, moves: MoveLog[]): Promise<SubmitDailyResponse> {
  return request<SubmitDailyResponse>('/api/daily/run', {
    method: 'POST',
    body: JSON.stringify({ date, moves }),
  });
}

export function getLeaderboard(date?: string): Promise<LeaderboardResponse> {
  const query = date ? `?date=${date}` : '';
  return request<LeaderboardResponse>(`/api/daily/leaderboard${query}`);
}

/** Карточка игрока: рейтинг, лига, место, счёт дуэлей. Нужен токен. */
export function getMe(): Promise<MeResponse> {
  return request<MeResponse>('/api/me');
}

export function getRatingBoard(): Promise<RatingLeaderboardResponse> {
  return request<RatingLeaderboardResponse>('/api/rating');
}

/** Есть ли уже профиль: без токена рейтинг спрашивать бессмысленно. */
export function hasAuth(): boolean {
  return token() !== null;
}

// ---------- Оффлайн-режим ----------

export function localToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Локальный сид дня (FNV-1a) — все оффлайн-игроки видят одно поле. */
export function localDailySeed(date: string): number {
  let hash = 0x811c9dc5;
  for (const ch of `doton:${date}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const tg = telegramWebApp();
if (tg) tg.ready();
