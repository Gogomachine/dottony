import { DEFAULT_CONFIG, type Cell } from '@doton/core';
import type {
  ComboLeaderboardResponse,
  ComboMove,
  LeaderboardResponse,
  MoveLog,
  RatingLeaderboardResponse,
} from '@doton/protocol';
import type { DuelServerMessage } from '@doton/protocol';
import {
  addFriend,
  apiAvailable,
  ensureAuth,
  getConfig,
  getComboBoard,
  getRatingBoard,
  getReplay,
  getDaily,
  getLeaderboard,
  hasAuth,
  inviteFriend,
  isTelegram,
  postScore,
  syncTelegramTheme,
  localDailySeed,
  localToday,
  resetAuth,
  savedName,
  submitCombo,
  submitDaily,
  ApiError,
} from './api';
import { Cabinet } from './cabinet';
import { DuelConnection, makeRoomCode } from './duel';
import { FEEL } from './game/feel';
import { ChainInput } from './game/input';
import { Renderer } from './game/renderer';
import { Session, SPRINT_SECONDS, type Mode } from './game/session';
import { emblemSvg } from './emblem';
import { applyTheme, loadMarks, loadThemeName, saveMarks, SCOPE } from './theme';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

const canvas = el<HTMLCanvasElement>('game');
const scoreEl = el<HTMLSpanElement>('score');
const gainEl = el<HTMLSpanElement>('gain');
const timeEl = el<HTMLSpanElement>('time');
const timeFieldEl = el<HTMLSpanElement>('time-field');
const timeLabelEl = el<HTMLSpanElement>('time-label');
const ticksEl = el<HTMLDivElement>('ticks');
const statEl = el<HTMLDivElement>('stat');
const chainCountEl = el<HTMLDivElement>('chain-count');
const seedEl = el<HTMLSpanElement>('seed');
const overlay = el<HTMLDivElement>('game-over');
const overTitleEl = el<HTMLHeadingElement>('over-title');
const overNoteEl = el<HTMLParagraphElement>('over-note');
const finalScoreEl = el<HTMLSpanElement>('final-score');
const dailyBoardEl = el<HTMLOListElement>('daily-board');
const modalBtn = el<HTMLButtonElement>('modal-action');
const miniLedEl = el<HTMLElement>('mini-led');
const miniTextEl = el<HTMLSpanElement>('mini-text');
const miniCdEl = el<HTMLSpanElement>('mini-cd');
const miniBarEl = el<HTMLElement>('mini-bar');
const vsFieldEl = el<HTMLSpanElement>('vs-field');
const vsNameEl = el<HTMLSpanElement>('vs-name');
const vsScoreEl = el<HTMLSpanElement>('vs-score');
const ratingLineEl = el<HTMLDivElement>('rating-line');
const menuEl = el<HTMLDivElement>('menu');
const resultEl = el<HTMLDivElement>('result');
const resultCapEl = el<HTMLSpanElement>('result-cap');
const resultBigEl = el<HTMLSpanElement>('result-big');
const resultSubEl = el<HTMLSpanElement>('result-sub');
const goKey = el<HTMLDivElement>('key-go');
const duelSheet = el<HTMLDivElement>('duel-sheet');
const rulesSheet = el<HTMLDivElement>('rules-sheet');
const addOpponentBtn = el<HTMLButtonElement>('add-opponent');
const replayBarEl = el<HTMLDivElement>('replay-bar');
const replayTextEl = el<HTMLSpanElement>('replay-text');
const roomBoxEl = el<HTMLDivElement>('room-box');
const roomCodeEl = el<HTMLSpanElement>('room-code');
const overEmblemEl = el<HTMLDivElement>('over-emblem');
const boardWrap = canvas.parentElement as HTMLElement;

/** Шкала времени: полоска делений вдоль верхнего края окуляра. */
const TICKS = 32;
const tickEls: HTMLElement[] = [];
for (let i = 0; i < TICKS; i++) {
  const tick = document.createElement('i');
  tick.className = 'tick on';
  ticksEl.appendChild(tick);
  tickEls.push(tick);
}

// ---------- Состояние ----------

let themeName = loadThemeName();
applyTheme(themeName);
let mode: Mode = 'sprint';

/** Активный забег ежедневного вызова: дата и лог ходов для сервера. */
let dailyRun: { date: string; moves: MoveLog[] } | null = null;
let dailyStarting = false;

/**
 * Челлендж бесконечного режима — максимальное увеличение за заход.
 *
 * Серия линз зависит от состояния поля, поэтому доказать рекорд можно
 * только журналом ходов: сервер переигрывает заход от сида и считает
 * комбо сам. Журнал ограничен — с какого-то момента заход перестаёт быть
 * доказуемым, и это честнее, чем принимать число на слово.
 */
let comboRun:
  | { seed: number; moves: ComboMove[]; best: number; sent: number; full: boolean }
  | null = null;
let comboTimer = 0;

/**
 * Потолок журнала захода. Значение то же, что в схеме протокола, но
 * значением его оттуда не берём: любой не-type импорт из @doton/protocol
 * затащил бы в бандл клиента ещё и zod.
 */
const COMBO_MOVE_LIMIT = 1200;

/** Не чаще раза в столько секунд отправляем заход на проверку. */
const COMBO_SEND_GAP = 20_000;

/**
 * Идёт ли сейчас дуэль и сколько она длится (сервер сообщает при старте).
 * Объявлено до первой сессии: newSession() читает длительность.
 */
let inDuel = false;
let duelDuration = 90;

let session = newSession();
const renderer = new Renderer(canvas, DEFAULT_CONFIG, SCOPE);

const DAILY_PLAYED_KEY = 'doton-daily-played';

function newSession(seed?: number): Session {
  return new Session(
    seed ?? Math.floor(Math.random() * 0xffffffff),
    mode,
    DEFAULT_CONFIG,
    duelDuration,
  );
}

function startGame(seed?: number): void {
  void sendCombo();
  session = newSession(seed);
  // Новый образец снимает стоп-кадр: партия другая, запрет от старой не её.
  if (!replay) input.enabled = true;
  // Челлендж живёт только в бесконечном режиме: в остальных заход кончается
  // сам, и мерить в них рекорд серии — другая игра.
  comboRun =
    session.mode === 'free'
      ? { seed: session.seed, moves: [], best: 1, sent: 0, full: false }
      : null;
  renderer.resetAnims();
  updateStreak(0);
  overlay.hidden = true;
  resultEl.hidden = true;
  menuEl.hidden = true;
  setStat('Готов к наблюдению');
  seedEl.textContent = `образец #${session.seed.toString(16)}`;
  updateHud();
  updateGoKey();
}

/** Текущее увеличение: следующая линза умножит отсчёты на столько. */
function updateStreak(streak: number): void {
  const active = streak > 0;
  gainEl.hidden = !active;
  if (active) gainEl.textContent = ` ×${streak + 1}`;
}

/** Строка состояния в окуляре: что прибор делает прямо сейчас. */
function setStat(text: string, kind: '' | 'live' | 'warn' = ''): void {
  statEl.textContent = text;
  statEl.className = `stat ${kind}`;
}

function updateHud(): void {
  scoreEl.textContent = String(session.score);
  if (!session.timed) {
    // В бесконечном режиме таймера нет, и его место занимает челлендж:
    // рекорд увеличения за заход. Делений не зажигаем — запаса не бывает.
    timeLabelEl.textContent = comboRun ? 'Комбо' : 'Остаток';
    timeEl.textContent = comboRun ? `×${comboRun.best}` : '∞';
    timeFieldEl.className = 'field right';
    for (const tick of tickEls) tick.className = 'tick';
    return;
  }

  timeLabelEl.textContent = 'Остаток';
  const total = Math.ceil(session.timeLeft);
  timeEl.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  const full = session.mode === 'duel' ? duelDuration : SPRINT_SECONDS;
  const lit = Math.round((session.timeLeft / full) * TICKS);
  // Последние десять секунд шкала краснеет — это видно боковым зрением.
  const warn = session.timeLeft <= 10;
  timeFieldEl.className = `field right${warn ? ' warn' : ''}`;
  tickEls.forEach((tick, i) => {
    tick.className = `tick${i < lit ? (warn ? ' warn' : ' on') : ''}`;
  });
}

// ---------- Мини-экран резонанса ----------

let miniCache = '';

/**
 * Служебный экранчик над окуляром: идёт ли резонанс, с каким цветом и
 * сколько ему осталось. Имён у цветов нет — светится сам цвет.
 */
function updateMini(): void {
  const { active, remaining, nextColor, nextIn } = session.phase();
  const key = `${active ?? 'x'}:${Math.ceil(active !== null ? remaining : nextIn)}`;
  if (key === miniCache) return;
  miniCache = key;

  if (active !== null) {
    const color = SCOPE.dots[active]!;
    miniLedEl.style.background = color;
    miniLedEl.style.boxShadow = `0 0 7px ${color}`;
    miniTextEl.innerHTML = `Резонанс · <b>×${session.cfg.phaseMultiplier}</b>`;
    miniCdEl.textContent = String(Math.ceil(remaining)).padStart(2, '0');
    miniBarEl.style.background = color;
    miniBarEl.style.width = `${(remaining / session.cfg.phaseDuration) * 100}%`;
    return;
  }

  miniLedEl.style.background = '';
  miniLedEl.style.boxShadow = '';
  miniBarEl.style.background = '';
  miniBarEl.style.width = '0%';
  if (nextIn <= 5) {
    const color = SCOPE.dots[nextColor]!;
    miniLedEl.style.background = color;
    miniTextEl.textContent = 'Резонанс · настройка';
    miniCdEl.textContent = String(Math.ceil(nextIn)).padStart(2, '0');
  } else {
    miniTextEl.textContent = session.started ? 'Резонанс · сигнал ровный' : 'Резонанс · ожидание';
    miniCdEl.textContent = '--';
  }
}

// ---------- Ежедневный вызов ----------

function guestName(): string {
  const existing = savedName();
  if (existing) return existing;
  const answer = prompt('Имя для таблиц:', 'Игрок') ?? 'Игрок';
  return answer.trim().slice(0, 24) || 'Игрок';
}

function playedDate(): string | null {
  return localStorage.getItem(DAILY_PLAYED_KEY);
}

async function startDaily(): Promise<void> {
  if (dailyStarting) return;
  dailyStarting = true;
  // Бесплатный сервер после простоя просыпается до минуты — показываем,
  // что игра не зависла, а ждёт ответа.
  const waking = apiAvailable
    ? window.setTimeout(() => {
        showOverModal({
          title: 'Вызов дня',
          note: 'Бужу сервер — это занимает до минуты после простоя…',
        });
      }, 1200)
    : 0;
  try {
    const info = apiAvailable
      ? await getDaily()
      : { date: localToday(), seed: localDailySeed(localToday()) };
    clearTimeout(waking);

    if (playedDate() === info.date) {
      // Одна попытка в день: вместо игры показываем таблицу.
      await showDailyLeaderboard(info.date);
      return;
    }

    if (apiAvailable) {
      try {
        await ensureAuth(guestName);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          resetAuth();
          await ensureAuth(guestName);
        } else {
          throw error;
        }
      }
    }

    mode = 'sprint';
    dailyRun = { date: info.date, moves: [] };
    startGame(info.seed);
    updateGoKey();
  } catch {
    showOverModal({
      title: 'Вызов дня',
      note: 'Сервер не ответил. Попробуй ещё раз через минуту.',
    });
  } finally {
    clearTimeout(waking);
    dailyStarting = false;
  }
}

async function finishDaily(run: { date: string; moves: MoveLog[] }, score: number): Promise<void> {
  localStorage.setItem(DAILY_PLAYED_KEY, run.date);
  showOverModal({ title: `Вызов дня · ${run.date}`, score, note: 'Отправляю результат…' });

  if (!apiAvailable) {
    overNoteEl.textContent = 'Сервер не подключён: результат остался на этом устройстве.';
    return;
  }

  try {
    const result = await submitDaily(run.date, run.moves);
    const board = await getLeaderboard(run.date);
    overNoteEl.textContent = `Твоё место: ${result.rank}`;
    renderBoard(board);
  } catch (error) {
    overNoteEl.textContent =
      error instanceof ApiError && error.code === 'already-played'
        ? 'Сегодняшняя попытка уже была засчитана.'
        : 'Не удалось отправить результат. Таблица дня недоступна.';
  }
}

async function showDailyLeaderboard(date: string): Promise<void> {
  showOverModal({ title: `Вызов дня · ${date}`, note: 'Ты уже играл сегодня. Таблица дня:' });
  if (!apiAvailable) {
    overNoteEl.textContent = 'Ты уже играл сегодня. Новый вызов — завтра!';
    return;
  }
  try {
    renderBoard(await getLeaderboard(date));
  } catch {
    overNoteEl.textContent = 'Таблица дня недоступна. Попробуй позже.';
  }
}

function renderBoard(board: LeaderboardResponse): void {
  dailyBoardEl.hidden = false;
  dailyBoardEl.innerHTML = '';
  const top = board.entries.slice(0, 10);
  for (const entry of top) {
    const item = document.createElement('li');
    if (board.me && entry.rank === board.me.rank && entry.name === board.me.name) {
      item.className = 'me';
    }
    item.innerHTML = `<span class="rank">${entry.rank}</span><span></span><span class="pts"></span>`;
    (item.children[1] as HTMLElement).textContent = entry.name;
    (item.children[2] as HTMLElement).textContent = String(entry.score);
    dailyBoardEl.appendChild(item);
  }
  if (board.me && !top.some((entry) => entry.rank === board.me!.rank)) {
    const item = document.createElement('li');
    item.className = 'me';
    item.innerHTML = `<span class="rank">${board.me.rank}</span><span></span><span class="pts"></span>`;
    (item.children[1] as HTMLElement).textContent = board.me.name;
    (item.children[2] as HTMLElement).textContent = String(board.me.score);
    dailyBoardEl.appendChild(item);
  }
}

/** Изменение рейтинга за матч — как его присылает сервер. */
type RatingChange = NonNullable<Extract<DuelServerMessage, { type: 'finished' }>['rating']>;

/**
 * Строка «рейтинг после матча». Во время калибровки лигу не называем:
 * она ещё ничего не значит — вместо неё показываем, сколько матчей осталось.
 */
function showRatingChange(change: RatingChange): void {
  const delta = change.after - change.before;
  const sign = delta > 0 ? '+' : '';
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
  const caption = change.placement
    ? `Калибровка · ${change.placement.played} из ${change.placement.required}`
    : `${change.league} · ${change.after}`;
  ratingLineEl.hidden = false;
  ratingLineEl.innerHTML = `<span class="delta ${direction}"></span><span class="caption"></span>`;
  (ratingLineEl.children[0] as HTMLElement).textContent = `${sign}${delta}`;
  (ratingLineEl.children[1] as HTMLElement).textContent = caption;
}

function showOverModal(options: {
  title: string;
  score?: number;
  note?: string;
  /** Показать код комнаты — по нему друг заходит в матч. */
  room?: string;
  /** Идёт ожидание соперника: кнопка станет «Отменить». */
  waiting?: boolean;
  /** Как матч сдвинул рейтинг. */
  rating?: RatingChange;
  /** Просмотр таблицы поверх игры: кнопка просто закрывает окно. */
  viewing?: boolean;
  /** Показать кнопку «добавить соперника в друзья». */
  addFriend?: { name: string; code: string };
}): void {
  // В модалке финиша прибор наведён на резкость за вызов дня.
  overEmblemEl.innerHTML = emblemSvg({ size: 84, focused: options.title.startsWith('Вызов') });
  overTitleEl.textContent = options.title;
  roomBoxEl.hidden = options.room === undefined;
  if (options.room !== undefined) {
    roomCodeEl.textContent = options.room;
  }
  finalScoreEl.hidden = options.score === undefined;
  if (options.score !== undefined) finalScoreEl.textContent = String(options.score);
  overNoteEl.hidden = options.note === undefined;
  overNoteEl.textContent = options.note ?? '';
  dailyBoardEl.hidden = true;
  ratingLineEl.hidden = true;
  if (options.rating) showRatingChange(options.rating);
  // Добавить соперника проще всего сразу после матча — потом искать код.
  addOpponentBtn.hidden = options.addFriend === undefined;
  if (options.addFriend) {
    addOpponentBtn.textContent = `+ ${options.addFriend.name} в друзья`;
    pendingFriendCode = options.addFriend.code;
  }
  // Пока ждём соперника, единственное осмысленное действие — отменить поиск.
  waitingForOpponent = options.waiting ?? false;
  viewingOnly = options.viewing ?? false;
  modalBtn.textContent = waitingForOpponent
    ? 'Отменить'
    : viewingOnly || dailyRun || options.title.startsWith('Вызов')
      ? 'Закрыть'
      : 'Понятно';
  overlay.hidden = false;
}

// ---------- Дуэль ----------

const duel = new DuelConnection(handleDuelMessage, (state) => {
  // Матч на сервере продолжается — важно показать, что игра не сломалась.
  connectionLost = state === 'lost';
  if (connectionLost) {
    showOverModal({ title: 'Связь пропала', note: 'Возвращаю в матч… Время идёт.' });
  } else if (inDuel) {
    overlay.hidden = true;
  }
});

/** Связь с сервером потеряна: ходы не отправить, ввод блокируем. */
let connectionLost = false;

/** Счёт соперника — третьим полем приборной строки, только в дуэли. */
function showVersus(name: string, opponentScore: number): void {
  vsFieldEl.hidden = false;
  vsNameEl.textContent = name;
  vsScoreEl.textContent = String(opponentScore);
  // Кто впереди, видно по цвету: отставание горит акцентом.
  vsFieldEl.className = `field${session.score < opponentScore ? ' warn' : ''}`;
}

let opponentName = 'Соперник';
let opponentScore = 0;
/** Код соперника по текущему матчу: по нему его добавляют в друзья. */
let opponentCode: string | null = null;
/** Код, который добавит кнопка на экране результата. */
let pendingFriendCode = '';
/** Таймер подсказки на экране ожидания. */
let searchHint = 0;
/** Чем закончилась попытка позвать друга сообщением в Telegram. */
let inviteNote: string | null = null;
/** Открыта модалка ожидания соперника. */
let waitingForOpponent = false;
/** Открыта справочная модалка (таблица рейтинга): партия под ней продолжается. */
let viewingOnly = false;

function handleDuelMessage(message: DuelServerMessage): void {
  switch (message.type) {
    case 'searching':
      showOverModal(
        message.room
          ? {
              title: 'Ждём друга',
              note:
                inviteNote ??
                'Продиктуй другу код комнаты. Он вводит его кнопкой «Ввести код» — и матч начнётся сам.',
              room: message.room,
              waiting: true,
            }
          : { title: 'Дуэль', note: 'Ищем живого соперника…', waiting: true },
      );
      // Ожидание не должно выглядеть зависанием: если живого соперника нет,
      // через несколько секунд сервер подставит запись — так и говорим.
      if (!message.room) {
        clearTimeout(searchHint);
        searchHint = window.setTimeout(() => {
          if (waitingForOpponent) {
            overNoteEl.textContent = 'Никого рядом — подбираю запись чужого матча…';
          }
        }, 6000);
      }
      break;

    case 'matched': {
      clearTimeout(searchHint);
      inviteNote = null;
      connectionLost = false;
      duel.markActive();
      inDuel = true;
      duelDuration = message.duration;
      updateGoKey();
      // Честно помечаем запись: игрок должен знать, что соперник не живой.
      opponentName = message.ghost ? `${message.opponent} · запись` : message.opponent;
      opponentScore = 0;
      opponentCode = message.opponentCode ?? null;
      mode = 'duel';
      dailyRun = null;
      startGame(message.seed);
      session.begin();
      showVersus(opponentName, 0);
      break;
    }

    case 'resumed': {
      // Сервер — источник истины: восстанавливаем его состояние целиком,
      // включая ходы, которые не дошли из-за обрыва.
      clearTimeout(searchHint);
      connectionLost = false;
      duel.markActive();
      inDuel = true;
      updateGoKey();
      duelDuration = Math.max(1, Math.round(message.remaining));
      opponentName = message.ghost ? `${message.opponent} · запись` : message.opponent;
      opponentScore = message.opponentScore;
      opponentCode = message.opponentCode ?? null;
      mode = 'duel';
          startGame(message.seed);
      session.begin();
      session.restore(message.grid, message.score, message.streak);
      session.syncRemaining(message.remaining);
      updateStreak(message.streak);
      updateHud();
      showVersus(opponentName, opponentScore);
      break;
    }

    case 'accepted':
      // Счёт ведёт сервер — синхронизируем свой, чтобы не разошлись.
      session.score = message.score;
      updateHud();
      showVersus(opponentName, opponentScore);
      break;

    case 'rejected':
      // Ход не принят сервером: расхождение состояний, честнее прервать матч.
      showOverModal({ title: 'Дуэль', note: 'Ход не принят сервером. Матч прерван.' });
      endDuel();
      break;

    case 'opponent':
      opponentScore = message.score;
      showVersus(opponentName, opponentScore);
      break;

    case 'finished': {
      const title =
        message.outcome === 'win'
          ? 'Победа!'
          : message.outcome === 'loss'
            ? 'Поражение'
            : 'Ничья';
      // Рейтинг приходит вторым «finished» — он лишь дополняет уже
      // показанный результат, поэтому экран просто перерисовывается.
      showOverModal({
        title,
        score: message.score,
        note: `${opponentName}: ${message.opponentScore}`,
        ...(message.rating ? { rating: message.rating } : {}),
        ...(opponentCode ? { addFriend: { name: opponentName, code: opponentCode } } : {}),
      });
      endDuel({ awaitRating: true });
      break;
    }

    case 'error':
      showOverModal({
        title: 'Дуэль',
        note:
          message.error === 'unauthorized'
            ? 'Нужен вход. Сыграй «Вызов дня» — он создаст профиль.'
            : 'Связь с сервером потеряна.',
      });
      endDuel();
      break;
  }
}

function endDuel(options: { awaitRating?: boolean } = {}): void {
  clearTimeout(searchHint);
  inviteNote = null;
  inDuel = false;
  vsFieldEl.hidden = true;
  updateGoKey();
  // Партия окончена вместе с матчем: иначе локальный таймер досчитает до
  // нуля и перепишет объявленный сервером результат на «Время вышло».
  session.over = true;
  if (options.awaitRating) duel.closeAfterResults();
  else duel.close();
}

async function startDuel(room?: string): Promise<void> {
  if (!apiAvailable) {
    showOverModal({ title: 'Дуэль', note: 'Дуэли доступны только с сервером.' });
    return;
  }
  showOverModal({
    title: room ? 'Ждём друга' : 'Дуэль',
    note: 'Подключаюсь — бесплатный сервер просыпается до минуты…',
    waiting: true,
    ...(room ? { room } : {}),
  });
  try {
    await ensureAuth(guestName);
  } catch {
    showOverModal({ title: 'Дуэль', note: 'Не удалось войти. Попробуй ещё раз.' });
    return;
  }
  duel.connect(room);
}

async function showRatingBoard(): Promise<void> {
  showOverModal({ title: 'Рейтинг', note: 'Загружаю таблицу…', viewing: true });
  try {
    const board = await getRatingBoard();
    if (board.entries.length === 0) {
      overNoteEl.textContent =
        'Таблица пока пуста: в неё попадают те, кто прошёл калибровку в дуэлях.';
      return;
    }
    overNoteEl.textContent = board.me
      ? `Ты на ${board.me.rank}-м месте · ${board.me.league}`
      : 'Пройди калибровку в дуэлях, чтобы попасть в таблицу.';
    renderRatingBoard(board);
  } catch {
    overNoteEl.textContent = 'Таблица рейтинга недоступна. Попробуй позже.';
  }
}

function renderRatingBoard(board: RatingLeaderboardResponse): void {
  dailyBoardEl.hidden = false;
  dailyBoardEl.innerHTML = '';
  const rows = [...board.entries];
  // Своя строка нужна всегда, даже если игрок не попал в верхушку таблицы.
  if (board.me && !rows.some((entry) => entry.rank === board.me!.rank)) rows.push(board.me);
  for (const entry of rows) {
    const item = document.createElement('li');
    if (board.me && entry.rank === board.me.rank) item.className = 'me';
    item.innerHTML =
      `<span class="rank">${entry.rank}</span>` +
      `<span class="who"><span class="who-name"></span><span class="who-league"></span></span>` +
      `<span class="pts"></span>`;
    const who = item.children[1] as HTMLElement;
    (who.children[0] as HTMLElement).textContent = entry.name;
    // Лига подписью под именем: на телефоне подсказки по наведению не работают.
    (who.children[1] as HTMLElement).textContent = entry.league;
    (item.children[2] as HTMLElement).textContent = String(entry.rating);
    dailyBoardEl.appendChild(item);
  }
}

// ---------- Наработка прибора ----------

/**
 * Отсчёты из режимов, у которых нет конца партии, копятся здесь и уходят
 * на сервер пачками. Слать каждый ход было бы расточительно, а копить до
 * конца партии нельзя — её попросту нет.
 *
 * Дуэли и вызов дня сюда не попадают: их очки сервер считает сам.
 */
let pendingScore = { points: 0, moves: 0 };
let flushTimer = 0;

function countScore(points: number): void {
  if (inDuel || dailyRun || replay) return;
  pendingScore.points += points;
  pendingScore.moves += 1;
  if (flushTimer !== 0) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    void flushScore();
  }, 15_000);
}

async function flushScore(): Promise<void> {
  if (!apiAvailable || !hasAuth()) return;
  const batch = pendingScore;
  if (batch.points === 0) return;
  // Обнуляем до отправки: неудачный досыл лучше потерять, чем зачесть дважды.
  pendingScore = { points: 0, moves: 0 };
  try {
    await postScore(batch.points, batch.moves);
  } catch {
    // Сеть подведёт — партия продолжается, накопим заново.
  }
}

// Сворачивание — последний надёжный момент досчитать наработку: на
// телефоне вкладку часто закрывают, не возвращаясь в неё.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  void flushScore();
  void sendCombo();
});

// ---------- Челлендж: максимальное комбо ----------

/**
 * Записывает ход в журнал захода и следит за рекордом серии.
 *
 * Журнал не бесконечен, а заход — бесконечен. Когда журнал полон, заход
 * перестаёт быть доказуемым: продолжать играть можно, но новые рекорды
 * уже не в счёт. Молчать об этом нельзя — игрок должен понимать, почему
 * его серия не попала в таблицу.
 */
function countCombo(path: Cell[], t: number, streak: number): void {
  const run = comboRun;
  if (!run) return;

  if (run.moves.length >= COMBO_MOVE_LIMIT) {
    if (!run.full) {
      run.full = true;
      void sendCombo();
      setStat('Журнал захода полон — новый образец для нового рекорда', 'warn');
    }
    return;
  }

  run.moves.push({ path: path.map((cell) => ({ ...cell })), t: Number(t.toFixed(3)) });
  const combo = streak + 1;
  if (combo <= run.best) return;

  run.best = combo;
  updateHud();
  setStat(`Комбо ×${combo} — рекорд захода`, 'live');
  scheduleCombo();
}

/**
 * Отправку рекорда придерживаем: серия линз идёт очередью, и каждый её
 * шаг — новый рекорд. Слать заход на каждый было бы расточительно, ведь
 * журнал уходит целиком.
 */
function scheduleCombo(): void {
  if (comboTimer !== 0) return;
  const run = comboRun;
  if (!run) return;
  const wait = Math.max(0, run.sent + COMBO_SEND_GAP - Date.now());
  comboTimer = window.setTimeout(() => {
    comboTimer = 0;
    void sendCombo();
  }, wait);
}

/**
 * Отдаёт заход на проверку. Своё число не шлём вовсе: сервер переигрывает
 * ходы ядром и сам решает, какое там комбо, — так рекорд остаётся
 * доказанным, а не заявленным.
 */
async function sendCombo(): Promise<void> {
  if (comboTimer !== 0) {
    clearTimeout(comboTimer);
    comboTimer = 0;
  }
  const run = comboRun;
  if (!run || run.best <= 1 || run.moves.length === 0) return;
  if (!apiAvailable) return;
  // Рекорд идёт в общую таблицу, поэтому имя тут спросить уместно: до
  // первой серии игрок мог ни разу не заходить на сервер.
  if (!hasAuth()) {
    try {
      await ensureAuth(guestName);
    } catch {
      return;
    }
  }

  run.sent = Date.now();
  try {
    const result = await submitCombo(run.seed, run.moves);
    if (result.record) setStat(`Комбо ×${result.combo} · ${result.rank}-е место`, 'live');
  } catch {
    // Не дошло — заход не потерян: журнал на месте, отправим со следующим
    // рекордом или при уходе из режима.
  }
}

async function showComboBoard(): Promise<void> {
  showOverModal({ title: 'Максимальное комбо', note: 'Загружаю таблицу…', viewing: true });
  try {
    const board = await getComboBoard();
    if (board.entries.length === 0) {
      overNoteEl.textContent =
        'Таблица пока пуста. Собирай линзы подряд в бесконечном режиме — серия и есть комбо.';
      return;
    }
    overNoteEl.textContent = board.me
      ? `Твой рекорд ×${board.me.combo} · ${board.me.rank}-е место`
      : 'Собери серию линз в бесконечном режиме, чтобы попасть в таблицу.';
    renderComboBoard(board);
  } catch {
    overNoteEl.textContent = 'Таблица комбо недоступна. Попробуй позже.';
  }
}

function renderComboBoard(board: ComboLeaderboardResponse): void {
  dailyBoardEl.hidden = false;
  dailyBoardEl.innerHTML = '';
  const rows = [...board.entries];
  // Своя строка нужна всегда, даже если игрок не попал в верхушку таблицы.
  if (board.me && !rows.some((entry) => entry.rank === board.me!.rank)) rows.push(board.me);
  for (const entry of rows) {
    const item = document.createElement('li');
    if (board.me && entry.rank === board.me.rank) item.className = 'me';
    item.innerHTML =
      `<span class="rank">${entry.rank}</span><span></span><span class="pts"></span>`;
    (item.children[1] as HTMLElement).textContent = entry.name;
    (item.children[2] as HTMLElement).textContent = `×${entry.combo}`;
    dailyBoardEl.appendChild(item);
  }
}

// ---------- Реплей ----------

/**
 * Прокрутка сохранённой партии. Ходы применяются тем же ядром и в тот же
 * момент партии, что и вживую, поэтому картинка и очки совпадают с
 * настоящими — иначе реплей не был бы доказательством результата.
 */
let replay: { handles: number[] } | null = null;

function stopReplay(): void {
  if (!replay) return;
  for (const handle of replay.handles) clearTimeout(handle);
  replay = null;
  replayBarEl.hidden = true;
  input.enabled = true;
}

async function startReplay(duelId: string): Promise<void> {
  stopReplay();
  if (inDuel) endDuel();
  showOverModal({ title: 'Реплей', note: 'Загружаю запись…', viewing: true });

  let data;
  try {
    data = await getReplay(duelId);
  } catch {
    showOverModal({ title: 'Реплей', note: 'Записи этой партии нет.', viewing: true });
    return;
  }

  overlay.hidden = true;
  viewingOnly = false;
  dailyRun = null;
  mode = 'duel';
  menuEl.hidden = true;
  resultEl.hidden = true;
  session = new Session(data.seed, 'duel', DEFAULT_CONFIG, duelDuration);
  session.begin();
  renderer.resetAnims();
  updateStreak(0);
  seedEl.textContent = `#${session.seed.toString(16)}`;
  updateHud();

  input.enabled = false;
  replayBarEl.hidden = false;
  replayTextEl.textContent = data.opponent ? `Реплей · ${data.opponent}` : 'Реплей';

  const handles = data.moves.map((move) =>
    window.setTimeout(() => {
      // Время партии задаёт запись: от него зависит фаза, а значит и очки.
      session.seek(move.t);
      const oldGrid = session.board.grid;
      const result = session.tryMove(move.path);
      if (typeof result === 'string') return;
      renderer.animateMove(oldGrid, result);
      showFloatingPoints(result.points, result.multiplier, renderer.center(move.path[0]!));
      updateStreak(result.streak);
      updateHud();
    }, move.t * 1000),
  );

  const last = data.moves[data.moves.length - 1]?.t ?? 0;
  handles.push(
    window.setTimeout(() => {
      stopReplay();
      session.over = true;
      showOverModal({
        title: 'Реплей окончен',
        score: data.score,
        ...(data.opponent ? { note: `Соперник: ${data.opponent}` } : {}),
      });
    }, (last + 1.5) * 1000),
  );
  replay = { handles };
}

// ---------- Ходы ----------

function showFloatingPoints(points: number, multiplier: number, at: { x: number; y: number }): void {
  const label = document.createElement('span');
  label.className = 'float-label';
  label.textContent = multiplier > 1 ? `+${points} ×${multiplier}` : `+${points}`;
  // Координаты приходят от доски, а подпись висит на окуляре: доска в нём
  // висит по центру, так что без сдвига цифра оторвалась бы от хода.
  label.style.left = `${at.x + canvas.offsetLeft}px`;
  label.style.top = `${at.y + canvas.offsetTop}px`;
  boardWrap.appendChild(label);
  setTimeout(() => label.remove(), 900);
}

const input = new ChainInput(
  canvas,
  renderer,
  () => session.board,
  DEFAULT_CONFIG,
  (path: Cell[]) => {
    const oldGrid = session.board.grid;
    const at = input.pointer ?? renderer.center(path[path.length - 1]!);
    const elapsed = session.elapsed;
    // Часы пускает первый ход: до него игрок разглядывает образец.
    session.begin();
    const result = session.tryMove(path);
    if (typeof result === 'string') return;
    if (dailyRun) {
      dailyRun.moves.push({ path: path.map((cell) => ({ ...cell })), t: Number(elapsed.toFixed(3)) });
    }
    countCombo(path, elapsed, result.streak);
    if (inDuel) duel.move(path, elapsed);
    countScore(result.points);
    renderer.animateMove(oldGrid, result);
    showFloatingPoints(result.points, result.multiplier, at);
    updateStreak(result.streak);
    // Снятое показываем строкой состояния — это и есть отчёт прибора.
    const gain = result.multiplier > 1 ? ` ×${result.multiplier}` : '';
    setStat(`Снято ${result.removed.length + result.exploded.length} · +${result.points}${gain}`, 'live');
    updateGoKey();
    updateHud();
  },
  (length: number) => {
    // Чем длиннее цепочка, тем ощутимее отклик — рука чувствует прогресс.
    if (!navigator.vibrate) return;
    const ms = Math.min(FEEL.hapticBase + length * FEEL.hapticPerDot, FEEL.hapticMax);
    navigator.vibrate(Math.round(ms));
  },
);

// ---------- Управление ----------

/**
 * Держит системные полосы Telegram в цвете корпуса: он занимает весь
 * экран, и полосы должны быть его продолжением, а не рамкой поверх.
 */
function syncChrome(): void {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--case').trim();
  syncTelegramTheme(color);
}

el<HTMLButtonElement>('theme-toggle').addEventListener('click', function () {
  themeName = themeName === 'draft' ? 'graphite' : 'draft';
  applyTheme(themeName);
  this.classList.toggle('on', themeName === 'graphite');
  syncChrome();
});

/** Итог соло-партии — крупным числом внутри окуляра. */
function showResult(cap: string, score: number): void {
  resultCapEl.textContent = cap;
  resultBigEl.textContent = String(score);
  resultSubEl.textContent = `образец #${session.seed.toString(16)}`;
  menuEl.hidden = true;
  resultEl.hidden = false;
  setStat('Наблюдение завершено');
}

// ---------- Меню и клавиши ----------

/**
 * Меню открывается прямо в окуляре: прибор не переключает экраны, он
 * просто закрывает стекло заслонкой. Партия под ней остаётся на месте.
 */
function openMenu(): void {
  if (canPause()) freeze();
  resultEl.hidden = true;
  menuEl.hidden = false;
  // Подпись должна говорить правду: партии может уже не быть, а в дуэли
  // и вызове дня часы за заслонкой продолжают идти.
  setStat('Панель управления');
}

function closeMenu(): void {
  menuEl.hidden = true;
  unfreeze();
  if (!session.over) setStat(session.started ? 'Наблюдение идёт' : 'Готов к наблюдению', session.started ? 'live' : '');
}

function setMode(next: Mode): void {
  if (inDuel) endDuel();
  stopReplay();
  void flushScore();
  mode = next;
  dailyRun = null;
  startGame();
}

/**
 * Главная клавиша: пока идёт партия — начать заново, после конца —
 * повторить. В дуэли и вызове дня нового образца не выдаём: там он общий.
 */
function updateGoKey(): void {
  const locked = inDuel || dailyRun !== null || replay !== null;
  goKey.toggleAttribute('disabled', locked);
  const label = session.over ? 'Повторить' : session.started ? 'Сброс' : 'Наблюдать';
  goKey.firstChild!.nodeValue = locked ? 'Наблюдать' : label;
}

const MENU_ACTIONS: Record<string, () => void> = {
  resume: () => closeMenu(),
  profile: () => void cabinet.show('history'),
  friends: () => void cabinet.show('friends'),
  daily: () => {
    menuEl.hidden = true;
    void startDaily();
  },
  sprint: () => {
    menuEl.hidden = true;
    setMode('sprint');
  },
  free: () => {
    menuEl.hidden = true;
    setMode('free');
  },
  duel: () => {
    duelSheet.hidden = false;
  },
  rules: () => {
    rulesSheet.hidden = false;
  },
};

el<HTMLUListElement>('menu-list').addEventListener('click', (event) => {
  const item = (event.target as HTMLElement).closest('li');
  const action = item ? MENU_ACTIONS[item.dataset.go ?? ''] : undefined;
  if (action) action();
});

el<HTMLButtonElement>('rules-close').addEventListener('click', () => {
  rulesSheet.hidden = true;
});
el<HTMLButtonElement>('duel-cancel').addEventListener('click', () => {
  duelSheet.hidden = true;
});
el<HTMLButtonElement>('duel-quick').addEventListener('click', () => {
  duelSheet.hidden = true;
  menuEl.hidden = true;
  void startDuel();
});

el<HTMLButtonElement>('invite').addEventListener('click', () => {
  duelSheet.hidden = true;
  menuEl.hidden = true;
  // Код придумываем сразу, чтобы показать его ещё до ответа сервера.
  void startDuel(makeRoomCode());
});

el<HTMLButtonElement>('join-code').addEventListener('click', () => {
  const answer = prompt('Код комнаты от друга:');
  if (!answer) return;
  const room = answer.trim().toUpperCase();
  if (room.length < 4) {
    showOverModal({ title: 'Дуэль', note: 'Код слишком короткий — проверь и введи ещё раз.' });
    return;
  }
  duelSheet.hidden = true;
  menuEl.hidden = true;
  void startDuel(room);
});

/**
 * Останавливать время можно не везде: в дуэли оно общее с соперником, а в
 * вызове дня остановка дала бы фору перед остальными.
 */
function canPause(): boolean {
  return !inDuel && dailyRun === null && replay === null && !session.over && session.started;
}

/**
 * Стоп-кадр замораживает партию целиком: часы стоят и стекло закрыто.
 * Одних часов мало — на замершем поле цепочки собирались бы дальше.
 */
function freeze(): void {
  session.pause();
  input.enabled = false;
}

function unfreeze(): void {
  session.resume();
  // В реплее поле не игрока: запрет там снимает только stopReplay().
  if (!replay) input.enabled = true;
}

/**
 * Закрывает открытое окно прибора, какое бы это ни было. Возвращает true,
 * если что-то закрыла: клавише этого достаточно, чтобы считать нажатие
 * потраченным. Окна лежат внутри окуляра и накрывают меню, поэтому без
 * такого выхода клавиши переключали бы панель вслепую — за окном.
 */
function closeWindows(): boolean {
  let closed = false;
  for (const sheet of [duelSheet, rulesSheet]) {
    if (sheet.hidden) continue;
    sheet.hidden = true;
    closed = true;
  }
  if (cabinet.visible) {
    cabinet.hide();
    closed = true;
  }
  if (!overlay.hidden) {
    // Поиск соперника без своего окна шёл бы вслепую — обрываем вместе с ним.
    if (waitingForOpponent) endDuel();
    // Итог вызова дня закрыт — попытка засчитана, держать её незачем.
    else if (session.over) dailyRun = null;
    viewingOnly = false;
    overlay.hidden = true;
    closed = true;
  }
  return closed;
}

el<HTMLDivElement>('key-pause').addEventListener('click', () => {
  // Открытое окно клавиша сперва убирает: под ним не видно, что она делает.
  if (closeWindows()) return;
  if (!menuEl.hidden) {
    closeMenu();
    return;
  }
  if (session.paused) {
    unfreeze();
    setStat('Наблюдение идёт', 'live');
    return;
  }
  if (!canPause()) {
    setStat(inDuel ? 'Матч идёт — стоп-кадр недоступен' : 'Время идёт', 'warn');
    return;
  }
  freeze();
  setStat('Стоп-кадр');
});

/**
 * «Меню» работает всегда и всегда приводит к панели управления: если
 * открыто окно — сперва закрывает его, а не переключает меню за ним.
 */
el<HTMLDivElement>('key-menu').addEventListener('click', () => {
  if (closeWindows()) {
    openMenu();
    return;
  }
  if (menuEl.hidden) openMenu();
  else closeMenu();
});

goKey.addEventListener('click', () => {
  if (goKey.hasAttribute('disabled')) return;
  menuEl.hidden = true;
  void flushScore();
  startGame();
});

el<HTMLButtonElement>('mark-toggle').addEventListener('click', function () {
  const on = !loadMarks();
  saveMarks(on);
  renderer.setMarks(on);
  this.classList.toggle('on', on);
});

const cabinet = new Cabinet({
  onReplay: (duelId) => void startReplay(duelId),
  onRatingBoard: () => void showRatingBoard(),
  onComboBoard: () => void showComboBoard(),
  onInvite: (friendCode) => void inviteToRoom(friendCode),
});

/**
 * Зовёт друга в комнату. Сообщение в Telegram доходит не всегда — бот не
 * пишет тому, кто его не запускал, — поэтому код комнаты остаётся на
 * экране в любом случае, его можно продиктовать.
 */
async function inviteToRoom(friendCode: string): Promise<void> {
  const room = makeRoomCode();
  await startDuel(room);
  try {
    await inviteFriend(friendCode, room);
    inviteNote = 'Позвал в Telegram — ждём друга.';
  } catch {
    inviteNote = 'В Telegram позвать не вышло — продиктуй другу код.';
  }
  // Ответ сервера о поиске может прийти и раньше, и позже нашего — поэтому
  // заметку не пишем напрямую, а держим и подставляем при перерисовке.
  if (waitingForOpponent) overNoteEl.textContent = inviteNote;
}

addOpponentBtn.addEventListener('click', () => {
  const code = pendingFriendCode;
  addOpponentBtn.disabled = true;
  void addFriend(code)
    .then(({ name }) => {
      addOpponentBtn.textContent = `${name} в друзьях ✓`;
    })
    .catch(() => {
      addOpponentBtn.textContent = 'Не удалось добавить';
    })
    .finally(() => {
      addOpponentBtn.disabled = false;
    });
});

el<HTMLButtonElement>('replay-stop').addEventListener('click', () => {
  stopReplay();
  openMenu();
});

modalBtn.addEventListener('click', () => {
  if (viewingOnly) {
    // Смотрели таблицу — партия под окном не тронута.
    viewingOnly = false;
    overlay.hidden = true;
    return;
  }
  if (waitingForOpponent) {
    // Отменяем поиск и открываем панель управления.
    endDuel();
    overlay.hidden = true;
    openMenu();
    return;
  }
  // Партия кончилась: закрываем окно и предлагаем панель управления —
  // оставаться на мёртвой доске незачем.
  dailyRun = null;
  overlay.hidden = true;
  openMenu();
});

/**
 * Держит доску квадратной и целиком внутри стекла. Ширины мало: окуляр
 * выше доски, но на низком экране он ужимается ниже неё — тогда размер
 * задаёт высота, иначе поле вылезло бы за край.
 */
function fitBoard(): void {
  const style = getComputedStyle(boardWrap);
  const room =
    boardWrap.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  canvas.style.maxWidth = `${Math.max(0, Math.round(room))}px`;
  renderer.resize();
}

new ResizeObserver(fitBoard).observe(boardWrap);

// ---------- Игровой цикл ----------

let lastTime = performance.now();
/** Длина цепочки, уже показанная в углу окуляра. */
let shownChain = 0;
function frame(now: number): void {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  // Во время реплея время партии задаёт запись, а не часы.
  if (!replay && session.tick(dt)) {
    if (dailyRun) {
      void finishDaily(dailyRun, session.score);
    } else if (inDuel) {
      // Итог объявляет сервер — ждём его сообщения, чтобы счёт сошёлся.
      showOverModal({ title: 'Дуэль', note: 'Время вышло, считаем результат…' });
    } else {
      // Соло-итог показываем прямо в окуляре — как показание прибора.
      showResult('Наблюдение завершено', session.score);
    }
    updateGoKey();
  }
  if (session.timed && !session.over) updateHud();
  updateMini();

  const chainLength = input.chain.length;
  if (chainLength !== shownChain) {
    shownChain = chainLength;
    chainCountEl.textContent = `Цепь ${chainLength}`;
  }

  renderer.draw(dt, session.board.grid, input.chain, input.pointer, session.phase().active);
  requestAnimationFrame(frame);
}

startGame();
requestAnimationFrame(frame);
openMenu();
renderer.setMarks(loadMarks());
el<HTMLButtonElement>('mark-toggle').classList.toggle('on', loadMarks());
el<HTMLButtonElement>('theme-toggle').classList.toggle('on', themeName === 'graphite');

if (isTelegram()) {
  document.documentElement.classList.add('in-telegram');
  syncChrome();
}

// Имя бота говорит кабинету, что привязка Telegram вообще возможна.
if (apiAvailable) {
  void getConfig()
    .then((config) => cabinet.setMiniApp(config.miniApp))
    .catch(() => {
      // Бот не настроен — привязку Telegram кабинет просто не покажет.
    });
}

// Уход со страницы во время матча — техническое поражение, а не зависший матч.
addEventListener('beforeunload', () => {
  void flushScore();
  if (inDuel) duel.close();
});

// Read-only доступ к состоянию для e2e-тестов и отладки в консоли.
declare global {
  interface Window {
    __doton?: { session: () => Session; chain: () => Cell[]; armed: () => boolean };
  }
}
window.__doton = { session: () => session, chain: () => input.chain, armed: () => input.enabled };
