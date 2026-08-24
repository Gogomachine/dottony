import type {
  AdminCard,
  AdminFindResponse,
  AdminLogResponse,
  AuthResponse,
  BoardPeriod,
  BuyResponse,
  OrderLeaderboardResponse,
  OrderMove,
  DuelHistoryResponse,
  FriendsResponse,
  InviteInfo,
  MeResponse,
  MoveLog,
  RatingLeaderboardResponse,
  ReplayResponse,
  SprintLeaderboardResponse,
  SubmitOrderResponse,
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
/**
 * Ключ наладки живёт в памяти вкладки, а не в localStorage: служебный режим
 * должен кончаться вместе с сеансом, а не оставаться на приборе навсегда.
 */
const SERVICE_KEY = 'doton-service';

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

function token(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Служебный ключ наладки. Приходит один раз — адресом `?service=КЛЮЧ` или
 * ссылкой в бота `service_КЛЮЧ`, — и дальше живёт до закрытия вкладки.
 *
 * Проверять его здесь нечем и не нужно: правильный он или выдуманный,
 * решает сервер, а без ключа на сервере он не открывает ничего вовсе.
 */
export function serviceKey(): string | null {
  try {
    const fromUrl = new URLSearchParams(location.search).get('service');
    const fromBot = startParam()?.startsWith('service_') === true ? startParam()!.slice(8) : null;
    // Ключ едет заголовком, а туда пускают только видимые знаки латиницы:
    // с буквой из кириллицы браузер не отправит запрос вовсе, и наладка
    // молчала бы непонятно почему. Такой ключ считаем не ключом.
    const given = fromUrl ?? fromBot;
    if (given !== null && /^[\x21-\x7e]+$/.test(given)) sessionStorage.setItem(SERVICE_KEY, given);
    return sessionStorage.getItem(SERVICE_KEY);
  } catch {
    // Приватный режим — наладка просто не включится.
    return null;
  }
}

/** Токен для WebSocket: браузерный WebSocket не умеет слать заголовки. */
export function authToken(): string | null {
  return token();
}

export function apiBase(): string {
  return BASE || location.origin;
}

/**
 * Ожидание ответа. Оно двухступенчатое, потому что первый запрос и все
 * последующие — разные истории: спящий инстанс просыпается до минуты, и
 * именно первое обращение за это платит. Дальше сервер уже на ногах, и
 * держать минуту на каждом запросе — значит на минуту вешать игру, если
 * связь пропала. Первый ответ — и таймаут становится коротким.
 *
 * На платном сервере, который не засыпает, длинным будет только самый
 * первый запрос сессии, а он и так уходит в фоне.
 */
const WAKE_TIMEOUT_MS = 70_000;
const REQUEST_TIMEOUT_MS = 12_000;

let awake = false;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Заголовок про тело ставим, только когда тело есть: Fastify отвечает на
  // «json» без содержимого отказом, а запросы без тела у нас бывают.
  const headers: Record<string, string> =
    init.body === undefined ? {} : { 'Content-Type': 'application/json' };
  const auth = token();
  if (auth) headers.Authorization = `Bearer ${auth}`;
  // Ключ наладки шлём только в служебные двери: в остальных он лишний, а
  // лишний секрет в заголовке — это лишний след в чужих логах.
  if (path.startsWith('/api/service/')) {
    const key = serviceKey();
    if (key) headers['x-service-key'] = key;
  }

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(awake ? REQUEST_TIMEOUT_MS : WAKE_TIMEOUT_MS),
    });
    awake = true;
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
  /** Полезная нагрузка ссылки `?startapp=…`, по которой открыли игру. */
  initDataUnsafe?: { start_param?: string };
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
 * С чем игру открыли по ссылке. Приглашение друга приходит именно так:
 * `duel_КОМНАТА` — и вместо диктовки кода друг просто жмёт кнопку.
 */
export function startParam(): string | null {
  const value = telegramWebApp()?.initDataUnsafe?.start_param;
  return value !== undefined && value.length > 0 ? value : null;
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

/** Шильдики корпуса: сервер хранит их, чтобы показать сопернику. */
export function setMarks(marks: (string | null)[]): Promise<{ marks: (string | null)[] }> {
  return request<{ marks: (string | null)[] }>('/api/me/marks', {
    method: 'PUT',
    body: JSON.stringify({ marks }),
  });
}

/**
 * Покупает наклейку или оправу за жетоны. Цену не шлём — её знает сервер;
 * отсюда уходит только номер из каталога.
 */
export function buy(id: string): Promise<BuyResponse> {
  return request<BuyResponse>('/api/me/buy', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

/**
 * Ставит нарисованное на пропуск. Сервер держит рисунок у себя не ради
 * сохранности: его видит соперник, и с нового телефона он должен приехать
 * вместе с остальным пропуском.
 */
export function setArt(art: string): Promise<{ art: string }> {
  return request<{ art: string }>('/api/me/art', {
    method: 'PUT',
    body: JSON.stringify({ art }),
  });
}

/**
 * Наладка: выдать всё, снять всё, поставить числа. Дверей этих на сервере
 * без ключа не существует, поэтому промах отвечает «нет такой страницы» —
 * и служебный режим со стороны неотличим от опечатки в адресе.
 */
export function serviceAll(): Promise<BuyResponse> {
  return request<BuyResponse>('/api/service/all', { method: 'POST' });
}

export function serviceNone(): Promise<BuyResponse> {
  return request<BuyResponse>('/api/service/none', { method: 'POST' });
}

export function serviceSet(values: {
  tokens?: number;
  rating?: number;
  games?: number;
}): Promise<BuyResponse> {
  return request<BuyResponse>('/api/service/set', {
    method: 'POST',
    body: JSON.stringify(values),
  });
}

/**
 * Служба: поиск, карточка, действия, журнал. Дверей этих не существует ни
 * для кого, кроме служащих, — посторонним сервер отвечает «нет такой
 * страницы», и по ответу не видно, что пульт вообще бывает.
 */
export function adminFind(query: string): Promise<AdminFindResponse> {
  return request<AdminFindResponse>(`/api/admin/find?q=${encodeURIComponent(query)}`);
}

export function adminCard(id: string): Promise<AdminCard> {
  return request<AdminCard>(`/api/admin/card?id=${encodeURIComponent(id)}`);
}

export function adminTokens(userId: string, tokens: number, reason: string): Promise<unknown> {
  return request('/api/admin/tokens', {
    method: 'POST',
    body: JSON.stringify({ userId, tokens, reason }),
  });
}

export function adminClearArt(userId: string, reason: string): Promise<unknown> {
  return request('/api/admin/art/clear', {
    method: 'POST',
    body: JSON.stringify({ userId, reason }),
  });
}

export function adminName(userId: string, name: string, reason: string): Promise<unknown> {
  return request('/api/admin/name', {
    method: 'POST',
    body: JSON.stringify({ userId, name, reason }),
  });
}

export function adminLog(): Promise<AdminLogResponse> {
  return request<AdminLogResponse>('/api/admin/log');
}

/** Надевает оправу полосы шильдиков; null — снимает. */
export function setFrame(frame: string | null): Promise<{ frame: string | null }> {
  return request<{ frame: string | null }>('/api/me/frame', {
    method: 'PUT',
    body: JSON.stringify({ frame }),
  });
}

export function getRatingBoard(
  kind: 'chain' | 'order' = 'chain',
): Promise<RatingLeaderboardResponse> {
  // Таблиц рейтинга две — по одной на механику дуэли.
  return request<RatingLeaderboardResponse>(
    kind === 'order' ? '/api/rating?kind=order' : '/api/rating',
  );
}

/**
 * Отправляет заход заказов на проверку. Счёт считает сервер: он
 * переигрывает касания ядром, поэтому своё число слать незачем.
 */
export function submitOrder(seed: number, moves: OrderMove[]): Promise<SubmitOrderResponse> {
  return request<SubmitOrderResponse>('/api/order', {
    method: 'POST',
    body: JSON.stringify({ seed, moves }),
  });
}

export function getOrderBoard(period: BoardPeriod = 'all'): Promise<OrderLeaderboardResponse> {
  return request<OrderLeaderboardResponse>(`/api/order/leaderboard?period=${period}`);
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
/** Приглашения, ждущие игрока в приборе. Этот же вызов говорит серверу, что игра открыта. */
export function getInvites(): Promise<{ invites: InviteInfo[] }> {
  return request<{ invites: InviteInfo[] }>('/api/me/invites');
}

/** Приглашение отработало: принято или отброшено. */
export function dropInvite(room: string): Promise<void> {
  return request(`/api/me/invites/${encodeURIComponent(room)}`, { method: 'DELETE' });
}

export function inviteFriend(
  code: string,
  room: string,
): Promise<{ ok: boolean; where: 'game' | 'telegram' }> {
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
