import type {
  AuthResponse,
  BoardPeriod,
  ComboLeaderboardResponse,
  ComboMove,
  DuelHistoryResponse,
  FriendsResponse,
  MeResponse,
  MoveLog,
  RatingLeaderboardResponse,
  ReplayResponse,
  SprintLeaderboardResponse,
  SubmitComboResponse,
  SubmitSprintResponse,
} from '@doton/protocol';

/**
 * Тонкий клиент API. Без VITE_API_URL игра живёт офлайн: партии играются,
 * но рекорды никуда не уходят и таблиц нет.
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
  expand?(): void;
  /** Запрет вертикальных свайпов (Bot API 7.7+). */
  disableVerticalSwipes?(): void;
  /** Полный экран (Bot API 8.0+). */
  requestFullscreen?(): void;
  setBackgroundColor?(color: string): void;
  setHeaderColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  openTelegramLink?(url: string): void;
}

function telegramWebApp(): TelegramWebApp | null {
  const tg = (window as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
  return tg && tg.initData.length > 0 ? tg : null;
}

export function isTelegram(): boolean {
  return telegramWebApp() !== null;
}

/**
 * Открывает ссылку внутри Telegram. Обычный переход по t.me из мини-
 * приложения выбрасывает во внешний браузер, где нет ни аккаунта, ни
 * initData, — поэтому просим сам Telegram.
 */
export function openInTelegram(url: string): boolean {
  const tg = telegramWebApp();
  if (!tg?.openTelegramLink) return false;
  tg.openTelegramLink(url);
  return true;
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

/**
 * Отправляет спринт на проверку. Счёт считает сервер: он переигрывает ходы
 * ядром, поэтому своё число слать незачем.
 */
export function submitSprint(seed: number, moves: MoveLog[]): Promise<SubmitSprintResponse> {
  return request<SubmitSprintResponse>('/api/sprint', {
    method: 'POST',
    body: JSON.stringify({ seed, moves }),
  });
}

export function getSprintBoard(period: BoardPeriod = 'all'): Promise<SprintLeaderboardResponse> {
  return request<SprintLeaderboardResponse>(`/api/sprint/leaderboard?period=${period}`);
}

/** Карточка игрока: рейтинг, лига, место, счёт дуэлей. Нужен токен. */
export function getMe(): Promise<MeResponse> {
  return request<MeResponse>('/api/me');
}

export function getRatingBoard(): Promise<RatingLeaderboardResponse> {
  return request<RatingLeaderboardResponse>('/api/rating');
}

/**
 * Отправляет заход бесконечного режима на проверку. Комбо считает сервер:
 * он переигрывает ходы ядром, поэтому своё число слать незачем.
 */
export function submitCombo(seed: number, moves: ComboMove[]): Promise<SubmitComboResponse> {
  return request<SubmitComboResponse>('/api/combo', {
    method: 'POST',
    body: JSON.stringify({ seed, moves }),
  });
}

export function getComboBoard(period: BoardPeriod = 'all'): Promise<ComboLeaderboardResponse> {
  return request<ComboLeaderboardResponse>(`/api/combo/leaderboard?period=${period}`);
}

/**
 * Досылает набранное в режимах без конца партии. keepalive нужен, чтобы
 * запрос ушёл даже если вкладку закрывают прямо сейчас.
 */
export async function postScore(points: number, moves: number): Promise<void> {
  const auth = token();
  if (!auth || BASE.length === 0) return;
  await fetch(`${BASE}/api/me/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify({ points, moves }),
    keepalive: true,
  });
}

export function getHistory(): Promise<DuelHistoryResponse> {
  return request<DuelHistoryResponse>('/api/me/history');
}

/** Что сервер знает про бота: из этого строятся ссылки в Telegram. */
export function getConfig(): Promise<{ bot: string | null; miniApp: string | null }> {
  return request<{ bot: string | null; miniApp: string | null }>('/api/config');
}

/** Ссылка на бота, по которой Telegram привяжется к текущему аккаунту. */
export function telegramLinkUrl(): Promise<{ url: string }> {
  return request<{ url: string }>('/api/me/link/telegram', { method: 'POST' });
}

/** Зовёт друга в комнату сообщением в Telegram. */
export function inviteFriend(code: string, room: string): Promise<void> {
  return request(`/api/friends/${encodeURIComponent(code)}/invite`, {
    method: 'POST',
    body: JSON.stringify({ room }),
  });
}

/** Ставит смайлик на пропуск. Сервер проверяет, что это правда смайлик. */
export function setAvatar(avatar: string): Promise<{ avatar: string }> {
  return request<{ avatar: string }>('/api/me/avatar', {
    method: 'POST',
    body: JSON.stringify({ avatar }),
  });
}

export function getFriends(): Promise<FriendsResponse> {
  return request<FriendsResponse>('/api/me/friends');
}

export function addFriend(code: string): Promise<{ name: string; code: string }> {
  return request<{ name: string; code: string }>('/api/friends', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export function removeFriend(code: string): Promise<void> {
  return request(`/api/friends/${encodeURIComponent(code)}`, { method: 'DELETE' });
}

export function getReplay(duelId: string): Promise<ReplayResponse> {
  return request<ReplayResponse>(`/api/me/history/${encodeURIComponent(duelId)}/replay`);
}

/** Переименование: сервер выдаёт новый токен, старый несёт прежнее имя. */
export async function rename(name: string): Promise<string> {
  const auth = await request<AuthResponse>('/api/me/name', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  localStorage.setItem(TOKEN_KEY, auth.token);
  localStorage.setItem(NAME_KEY, auth.user.name);
  return auth.user.name;
}

/** Есть ли уже профиль: без токена рейтинг спрашивать бессмысленно. */
export function hasAuth(): boolean {
  return token() !== null;
}

/**
 * Методы окна появлялись в разных версиях Bot API, и старый клиент на
 * незнакомый вызов бросает исключение — даже когда сама функция в скрипте
 * есть. Поэтому каждый вызов необязательный: не поддержали — не беда.
 */
function tryCall(action: () => void): void {
  try {
    action();
  } catch {
    // Старый Telegram: обойдёмся без этой возможности.
  }
}

/** Готовит окно мини-приложения: во весь экран и без случайного сворачивания. */
export function setupTelegramViewport(): void {
  const tg = telegramWebApp();
  if (!tg) return;
  tryCall(() => tg.ready());
  // Мини-приложение открывается в половину экрана: поле игры туда не влезает.
  tryCall(() => tg.expand?.());
  // Игрок ведёт цепочку пальцем, и движение вниз сворачивало бы игру
  // прямо посреди хода.
  tryCall(() => tg.disableVerticalSwipes?.());
  tryCall(() => tg.requestFullscreen?.());
}

/** Красит системные полосы Telegram в цвет темы игры. */
export function syncTelegramTheme(color: string): void {
  const tg = telegramWebApp();
  if (!tg || color.length === 0) return;
  tryCall(() => tg.setBackgroundColor?.(color));
  tryCall(() => tg.setHeaderColor?.(color));
  tryCall(() => tg.setBottomBarColor?.(color));
}

setupTelegramViewport();
