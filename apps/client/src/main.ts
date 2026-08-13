import {
  COMBO_CARRY_CHAIN,
  DEFAULT_CONFIG,
  type Cell,
  type Color,
  type GameConfig,
} from '@doton/core';
import type {
  BoardPeriod,
  ComboLeaderboardResponse,
  ComboMove,
  MoveLog,
  RatingLeaderboardResponse,
  SprintLeaderboardResponse,
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
  getSprintBoard,
  hasAuth,
  inviteFriend,
  isTelegram,
  postScore,
  syncTelegramTheme,
  resetAuth,
  savedName,
  submitCombo,
  submitSprint,
  ApiError,
} from './api';
import { Cabinet } from './cabinet';
import { DuelConnection, makeRoomCode } from './duel';
import { FEEL } from './game/feel';
import { ChainInput } from './game/input';
import { Renderer } from './game/renderer';
import { miniState, orderMini, type MiniState } from './game/mini';
import { Session, SPRINT_SECONDS, type Mode } from './game/session';
import { Tutorial } from './tutorial';
import { brandLockup } from './brand';
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
const boardListEl = el<HTMLOListElement>('board-list');
const boardTabsEl = el<HTMLDivElement>('board-tabs');
const modalBtn = el<HTMLButtonElement>('modal-action');
const scopeEl = el<HTMLDivElement>('scope');
const miniEl = el<HTMLDivElement>('mini');
const miniLedEl = el<HTMLElement>('mini-led');
const miniTextEl = el<HTMLSpanElement>('mini-text');
const miniCdEl = el<HTMLSpanElement>('mini-cd');
const miniBarEl = el<HTMLElement>('mini-bar');
const vsFieldEl = el<HTMLSpanElement>('vs-field');
const vsNameEl = el<HTMLSpanElement>('vs-name');
const vsScoreEl = el<HTMLSpanElement>('vs-score');
const ratingLineEl = el<HTMLDivElement>('rating-line');
const menuEl = el<HTMLDivElement>('menu');
const menuSeedEl = el<HTMLSpanElement>('menu-seed');
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
const keysEl = el<HTMLDivElement>('keys');
const tutEl = el<HTMLDivElement>('tut');
const tutStepEl = el<HTMLSpanElement>('tut-step');
const tutTitleEl = el<HTMLElement>('tut-title');
const tutTextEl = el<HTMLParagraphElement>('tut-text');
const fingerEl = el<HTMLElement>('finger');
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

/**
 * Правила этого прибора. Отличаются от заводских одним: ходом одним
 * касанием — его включает либо игрок в панели, либо сам режим заказов.
 *
 * Объект один на всех — рендер, ввод и сессия держат ссылку на него, —
 * поэтому переключатель меняет само поле `features.tap`, а не собирает
 * новый конфиг: иначе половина игры осталась бы со старым.
 */
const cfg: GameConfig = { ...DEFAULT_CONFIG, features: { ...DEFAULT_CONFIG.features } };

/**
 * Ставит способ хода по режиму. Касанием играют только заказы: там весь
 * смысл в том, что размер группы задаёт поле, а не игрок. Дай там вести
 * цепочку пальцем — и «25 за раз» отмерялось бы по счётчику, без ставки.
 */
function syncTap(): void {
  cfg.features.tap = mode === 'order';
}

/**
 * Активный спринт: сид и лог ходов. Спринт — соревновательный режим, и
 * его рекорд доказывается тем же способом, что и комбо: сервер
 * переигрывает заход от сида и считает счёт сам.
 */
let sprintRun: { seed: number; moves: MoveLog[] } | null = null;

/**
 * Челлендж бесконечного режима — лучший потенциал за один ход.
 *
 * Цена хода зависит от состояния поля, поэтому доказать рекорд можно
 * только журналом ходов: сервер переигрывает заход от сида и считает
 * комбо сам. Журнал ограничен — с какого-то момента заход перестаёт быть
 * доказуемым, и это честнее, чем принимать число на слово.
 */
let comboRun:
  | {
      seed: number;
      moves: ComboMove[];
      best: number;
      /** Потенциал хода, продлившего комбо; 0 — предыдущий ход его не продлевал. */
      carried: number;
      sent: number;
      full: boolean;
    }
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
const renderer = new Renderer(canvas, cfg, SCOPE);

function newSession(seed?: number): Session {
  return new Session(seed ?? Math.floor(Math.random() * 0xffffffff), mode, cfg, duelDuration);
}

function startGame(seed?: number): void {
  void sendCombo();
  // Способ хода ставим до партии: сессия, ввод и рендер читают один конфиг,
  // и режим заказов меняет его для себя.
  syncTap();
  session = newSession(seed);
  // Новый образец снимает стоп-кадр: партия другая, запрет от старой не её.
  if (!replay) input.enabled = true;
  // Челлендж живёт только в бесконечном режиме: в остальных заход кончается
  // сам, и мерить в них рекорд серии — другая игра.
  comboRun =
    session.mode === 'free'
      ? { seed: session.seed, moves: [], best: 0, carried: 0, sent: 0, full: false }
      : null;
  // Спринт пишется весь: без журнала рекорд нечем подтвердить.
  sprintRun =
    session.mode === 'sprint' && !replay ? { seed: session.seed, moves: [] } : null;
  renderer.resetAnims();
  updateStreak(0);
  // Новая партия — новые окна: показ прошлых не должен пережить сброс.
  shownWindow = -1;
  shownChain = '';
  miniCache = '';
  overlay.hidden = true;
  resultEl.hidden = true;
  menuEl.hidden = true;
  setStat('Готов к наблюдению');
  seedEl.textContent = `образец #${session.seed.toString(16)}`;
  menuSeedEl.textContent = `#${session.seed.toString(16)}`;
  updateHud();
  updateGoKey();
}

/** Текущее увеличение: следующая линза умножит потенциал на столько. */
function updateStreak(streak: number): void {
  const active = streak > 0;
  gainEl.hidden = !active;
  if (active) gainEl.textContent = ` ×${streak + 1}`;
}

/** «10 000» — крупные числа читаются только с разрядами. */
function groupDigits(value: number): string {
  return value.toLocaleString('ru-RU');
}

/** Строка состояния в окуляре: что прибор делает прямо сейчас. */
function setStat(text: string, kind: '' | 'live' | 'warn' = ''): void {
  statEl.textContent = text;
  statEl.className = `stat ${kind}`;
}

function updateHud(): void {
  scoreEl.textContent = groupDigits(session.score);
  const order = session.order();
  if (order) {
    // В заказах справа — счёт закрытых, а шкала делений отдана окну: она
    // и есть таймер, только не всей партии, а текущего резонанса.
    timeLabelEl.textContent = 'Заказы';
    timeEl.textContent = String(session.ordersDone);
    const full = order.open ? session.cfg.orderWindow : session.cfg.orderBreak;
    const lit = Math.round((order.remaining / full) * TICKS);
    const warn = order.open && order.remaining <= 8;
    timeFieldEl.className = `field right${warn ? ' warn' : ''}`;
    tickEls.forEach((tick, i) => {
      // Пауза показана пунктиром наоборот: деления не горят, а копятся к
      // началу окна — видно, что прибор ещё не звенит.
      const on = order.open ? i < lit : i >= TICKS - lit;
      tick.className = `tick${on ? (warn ? ' warn' : ' on') : ''}`;
    });
    return;
  }
  if (!session.timed) {
    // В бесконечном режиме таймера нет, и его место занимает челлендж:
    // лучший ход захода. Делений не зажигаем — запаса не бывает.
    timeLabelEl.textContent = comboRun ? 'Комбо' : 'Время';
    timeEl.textContent = comboRun ? groupDigits(comboRun.best) : '∞';
    timeFieldEl.className = 'field right';
    for (const tick of tickEls) tick.className = 'tick';
    return;
  }

  timeLabelEl.textContent = 'Время';
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

/** Кайма окуляра в цвете заявки; null — гасим. */
function tintScope(color: string | null): void {
  if (color === null) {
    scopeEl.classList.remove('claimed');
    return;
  }
  scopeEl.style.setProperty('--claim', color);
  scopeEl.classList.add('claimed');
}

/**
 * Служебный экранчик над окуляром: идёт ли резонанс, с каким цветом и
 * сколько ему осталось. Имён у цветов нет — светится сам цвет.
 *
 * Перед фазой то же место занимает окно заявки: чья цепочка длиннее, тот
 * и красит резонанс. Пока окно открыто, экранчик показывает лидера, а
 * кайма окуляра — цвет, которым фаза загорится.
 */
function showMini(state: MiniState): void {
  const color = state.color === null ? null : SCOPE.dots[state.color]!;
  miniLedEl.style.background = color ?? '';
  miniLedEl.style.boxShadow = color === null ? '' : `0 0 7px ${color}`;
  miniTextEl.innerHTML = state.text;
  miniCdEl.textContent = state.cd;
  miniBarEl.style.background = color ?? '';
  miniBarEl.style.width = `${Math.max(0, Math.min(1, state.fill)) * 100}%`;
}

function updateMini(): void {
  // В заказах экранчик занят окном резонанса: цвет, отсчёт и то, что нужно
  // снять за раз. Заявок в этом режиме нет — их место здесь и заняло окно.
  const order = session.order();
  if (order) {
    const key = `o${order.color}:${order.open ? 1 : 0}:${Math.ceil(order.remaining)}`;
    if (key === miniCache) return;
    miniCache = key;
    showMini(orderMini(order, session.cfg));
    tintScope(order.open ? SCOPE.dots[order.color]! : null);
    return;
  }

  const phase = session.phase();
  const window = session.claimWindow();
  const leader = window.open ? session.leader() : null;
  const key =
    phase.active !== null
      ? `p${phase.active}:${Math.ceil(phase.remaining)}`
      : window.open
        ? `c${leader ? `${leader.color}:${leader.length}:${leader.mine ? 1 : 0}` : 'free'}:${Math.ceil(window.remaining)}`
        : `w${Math.ceil(phase.nextIn)}`;
  if (key === miniCache) return;
  miniCache = key;

  const state = miniState(phase, window, leader, session.cfg, session.started);
  showMini(state);
  tintScope(state.color === null ? null : SCOPE.dots[state.color]!);
}

/**
 * Заявка объявлена. Своя — короткий отчёт, чужая — вспышка экранчика:
 * это тот самый момент, когда действие соперника видно на своём приборе.
 * Перебили — только если цвет забрали у тебя; на свободное окно это слово
 * было бы неправдой.
 */
function announceClaim(mine: boolean, length: number, outbid: boolean): void {
  miniCache = '';
  if (mine) {
    setStat(`Заявка · цепь ${length}`, 'live');
    return;
  }
  setStat(outbid ? `Заявку перебили · ${length}` : `Цвет заявлен · ${length}`, 'warn');
  flashMini();
  if (outbid && navigator.vibrate) navigator.vibrate(FEEL.hapticMax);
}

/** Вспышка экранчика — знак, что цвет ушёл к сопернику. */
function flashMini(): void {
  miniEl.classList.remove('flash');
  // Перезапуск анимации: без перерисовки класс вернётся тем же кадром.
  void miniEl.offsetWidth;
  miniEl.classList.add('flash');
}

// ---------- Обучение ----------

/**
 * Обучение пишет в те же приборы, что и партия: свой рендер и свои
 * подписи ему не нужны, иначе показ разошёлся бы с игрой.
 */
const tutorial = new Tutorial(renderer, {
  score: (value, streak) => {
    scoreEl.textContent = groupDigits(value);
    updateStreak(streak);
  },
  time: (label, value) => {
    timeLabelEl.textContent = label;
    timeEl.textContent = value;
    timeFieldEl.className = 'field right';
  },
  ticks: (left) => {
    const lit = Math.round(left * TICKS);
    tickEls.forEach((tick, i) => {
      tick.className = `tick${i < lit ? ' on' : ''}`;
    });
  },
  versus: (name, score) => showVersus(name, score),
  hideVersus: () => {
    vsFieldEl.hidden = true;
  },
  stat: (text, kind) => setStat(text, kind),
  mini: (state) => showMini(state),
  tint: (color) => tintScope(color === null ? null : SCOPE.dots[color]!),
  flash: () => flashMini(),
  chain: (length) => {
    shownChain = `Цепь ${length}`;
    chainCountEl.textContent = shownChain;
  },
  points: (points, multiplier, at) => showFloatingPoints(points, multiplier, at),
  finger: (at) => {
    fingerEl.hidden = at === null;
    if (!at) return;
    fingerEl.style.left = `${at.x + canvas.offsetLeft}px`;
    fingerEl.style.top = `${at.y + canvas.offsetTop}px`;
  },
  caption: (step, total, title, text) => {
    tutStepEl.textContent = `${step} / ${total}`;
    tutTitleEl.textContent = title;
    tutTextEl.textContent = text;
  },
  finish: () => stopTutorial(),
});

function startTutorial(): void {
  // Дуэль и реплей идут по чужим часам — их обучение прерывает целиком,
  // иначе показ вернулся бы в матч, который за это время кончился.
  if (inDuel) endDuel();
  stopReplay();
  menuEl.hidden = true;
  overlay.hidden = true;
  duelSheet.hidden = true;
  rulesSheet.hidden = true;
  // Показ ведут цепочкой: у него свои ходы, и рисоваться они должны линией.
  // Способ хода вернёт startGame() в конце показа.
  cfg.features.tap = false;
  // Партия под обучением не идёт: показ ведёт своё поле и свои часы.
  session.pause();
  input.enabled = false;
  keysEl.hidden = true;
  tutEl.hidden = false;
  miniCache = '';
  tutorial.start();
}

/** Возврат к прибору: показ кончился или его закрыли кнопкой. */
function stopTutorial(): void {
  tutorial.stop();
  tutEl.hidden = true;
  keysEl.hidden = false;
  fingerEl.hidden = true;
  vsFieldEl.hidden = !inDuel;
  miniCache = '';
  seenTutorial();
  // Обучение не тронуло партию, но поле показывало чужое — начинаем заново.
  startGame();
  session.resume();
  openMenu();
}

/** Обучение показывают один раз: дальше оно живёт в панели управления. */
const TUTORIAL_KEY = 'doton.tutorial.v1';

function seenTutorial(): void {
  try {
    localStorage.setItem(TUTORIAL_KEY, '1');
  } catch {
    // Приватный режим — просто покажем обучение ещё раз.
  }
}

function firstVisit(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_KEY) === null;
  } catch {
    return false;
  }
}

// ---------- Спринт ----------

function guestName(): string {
  const existing = savedName();
  if (existing) return existing;
  const answer = prompt('Имя для таблиц:', 'Игрок') ?? 'Игрок';
  return answer.trim().slice(0, 24) || 'Игрок';
}

/**
 * Конец спринта: отдаём заход на проверку и показываем место. Счёт на
 * экране — свой, но в таблицу идёт только пересчитанный сервером.
 */
async function finishSprint(run: { seed: number; moves: MoveLog[] }, score: number): Promise<void> {
  showResult('Наблюдение завершено', score);
  if (!apiAvailable || run.moves.length === 0) return;

  // Рекорд идёт в общую таблицу, поэтому имя тут спросить уместно.
  if (!hasAuth()) {
    try {
      await ensureAuth(guestName);
    } catch {
      return;
    }
  }

  try {
    const result = await submitSprint(run.seed, run.moves);
    resultSubEl.textContent = result.record
      ? `Рекорд · ${result.rank}-е место`
      : `${result.rank}-е место · рекорд ${groupDigits(result.best)}`;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      resetAuth();
      return;
    }
    // Сеть подвела — партия сыграна, просто без места в таблице.
  }
}

async function showSprintBoard(period: BoardPeriod = boardPeriod): Promise<void> {
  boardPeriod = period;
  showOverModal({ title: 'Рекорды спринта', note: 'Загружаю таблицу…', viewing: true });
  showBoardTabs('sprint');
  try {
    const board = await getSprintBoard(period);
    if (board.entries.length === 0) {
      overNoteEl.hidden = false;
      overNoteEl.textContent =
        period === 'day'
          ? 'Сегодня ещё никто не заходил. Три минуты на максимум потенциала — и ты первый.'
          : 'Таблица пока пуста. Три минуты на максимум потенциала — и ты в ней.';
      boardListEl.hidden = true;
      return;
    }
    overNoteEl.hidden = false;
    overNoteEl.textContent = board.me
      ? `${period === 'day' ? 'Сегодня' : 'Твой рекорд'} ${groupDigits(board.me.score)} · ${board.me.rank}-е место`
      : 'Сыграй спринт, чтобы попасть в таблицу.';
    renderSprintBoard(board);
  } catch {
    overNoteEl.hidden = false;
    overNoteEl.textContent = 'Таблица спринта недоступна. Попробуй позже.';
    boardListEl.hidden = true;
  }
}

function renderSprintBoard(board: SprintLeaderboardResponse): void {
  boardListEl.hidden = false;
  boardListEl.innerHTML = '';
  const rows = [...board.entries];
  // Своя строка нужна всегда, даже если игрок не попал в верхушку таблицы.
  if (board.me && !rows.some((entry) => entry.rank === board.me!.rank)) rows.push(board.me);
  for (const entry of rows) {
    const item = document.createElement('li');
    if (board.me && entry.rank === board.me.rank) item.className = 'me';
    item.innerHTML =
      `<span class="rank">${entry.rank}</span><span></span><span class="pts"></span>`;
    (item.children[1] as HTMLElement).textContent = entry.name;
    (item.children[2] as HTMLElement).textContent = groupDigits(entry.score);
    boardListEl.appendChild(item);
  }
}

/**
 * Какой период таблиц смотрят сейчас. День — по умолчанию: он живой и
 * начинается заново каждые сутки, вечная таблица нужна реже.
 */
let boardPeriod: BoardPeriod = 'day';
/** Какую таблицу перерисовывать при переключении периода. */
let openBoard: 'sprint' | 'combo' | null = null;

function showBoardTabs(board: 'sprint' | 'combo'): void {
  openBoard = board;
  boardTabsEl.hidden = false;
  for (const button of boardTabsEl.querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset.period === boardPeriod);
  }
}

boardTabsEl.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button');
  const period = button?.dataset.period;
  if (period !== 'day' && period !== 'all') return;
  if (period === boardPeriod || openBoard === null) return;
  if (openBoard === 'sprint') void showSprintBoard(period);
  else void showComboBoard(period);
});

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
  overEmblemEl.innerHTML = emblemSvg({ size: 84 });
  overTitleEl.textContent = options.title;
  roomBoxEl.hidden = options.room === undefined;
  if (options.room !== undefined) {
    roomCodeEl.textContent = options.room;
  }
  finalScoreEl.hidden = options.score === undefined;
  if (options.score !== undefined) finalScoreEl.textContent = String(options.score);
  overNoteEl.hidden = options.note === undefined;
  overNoteEl.textContent = options.note ?? '';
  boardListEl.hidden = true;
  // Переключатель периода принадлежит таблице: её показ его и поднимет.
  boardTabsEl.hidden = true;
  openBoard = null;
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
    : viewingOnly
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
      // Заявки матча общие: вернувшийся должен увидеть тот же цвет фазы.
      session.setClaims(
        message.claims.map((claim) => ({ ...claim, color: claim.color as Color })),
      );
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

    case 'claim': {
      // Заявки в дуэли объявляет сервер — и свои тоже: окно решают его
      // часы, а ход у самой границы окна иначе разошёлся бы с ним.
      const before = session.leader();
      const { cycle, color, length, t } = message;
      session.addClaim({ cycle, color: color as Color, length, t }, message.mine);
      const after = session.leader();
      // Молчим, если заявка проиграла: на приборе ничего не изменилось.
      if (after !== null && after !== before) {
        announceClaim(message.mine, length, !message.mine && before?.mine === true);
      }
      break;
    }

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
            ? 'Нужен вход. Сыграй спринт — он создаст профиль.'
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
  boardListEl.hidden = false;
  boardListEl.innerHTML = '';
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
    boardListEl.appendChild(item);
  }
}

// ---------- Наработка прибора ----------

/**
 * Потенциал из режимов, у которых нет конца партии, копится здесь и уходит
 * на сервер пачками. Слать каждый ход было бы расточительно, а копить до
 * конца партии нельзя — её попросту нет.
 *
 * Дуэли сюда не попадают: их очки сервер считает сам.
 */
let pendingScore = { points: 0, moves: 0 };
let flushTimer = 0;

function countScore(points: number): void {
  // Заказы в наработку не идут: там счёт — награды за окна, и мешать их с
  // потенциалом, которым живёт весь остальной прибор, нельзя.
  if (inDuel || replay || mode === 'order') return;
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
function countCombo(path: Cell[], t: number, points: number, chain: number): void {
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

  // Длинная цепочка продлевает комбо ровно на один ход: его потенциал
  // сложится с этим. Продление одноразовое — дальше отсчёт с нуля.
  const combo = run.carried + points;
  const carries = chain >= COMBO_CARRY_CHAIN;
  run.carried = carries ? points : 0;

  if (combo > run.best) {
    run.best = combo;
    updateHud();
    setStat(`Комбо ${groupDigits(combo)} — рекорд захода`, 'live');
    scheduleCombo();
    return;
  }
  // Продление важнее отчёта о ходе: игрок должен знать, что следующая
  // цепочка ляжет в то же комбо.
  if (carries) setStat(`Цепь ${chain} — следующий ход идёт в это же комбо`, 'live');
}

/**
 * Отправку рекорда придерживаем: в разгоне рекорд обновляется ходом за
 * ходом. Слать заход на каждый было бы расточительно, ведь журнал уходит
 * целиком.
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
  if (!run || run.best <= 0 || run.moves.length === 0) return;
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
    if (result.record) {
      setStat(`Комбо ${groupDigits(result.combo)} · ${result.rank}-е место`, 'live');
    }
  } catch {
    // Не дошло — заход не потерян: журнал на месте, отправим со следующим
    // рекордом или при уходе из режима.
  }
}

async function showComboBoard(period: BoardPeriod = boardPeriod): Promise<void> {
  boardPeriod = period;
  showOverModal({ title: 'Максимальное комбо', note: 'Загружаю таблицу…', viewing: true });
  showBoardTabs('combo');
  try {
    const board = await getComboBoard(period);
    if (board.entries.length === 0) {
      overNoteEl.hidden = false;
      overNoteEl.textContent =
        period === 'day'
          ? 'Сегодня рекордов ещё нет. Считается потенциал одного хода в бесконечном режиме.'
          : 'Таблица пока пуста. Считается потенциал одного хода в бесконечном режиме.';
      boardListEl.hidden = true;
      return;
    }
    overNoteEl.hidden = false;
    overNoteEl.textContent = board.me
      ? `${period === 'day' ? 'Сегодня' : 'Твой рекорд'} ${groupDigits(board.me.combo)} · ${board.me.rank}-е место`
      : 'Сделай дорогой ход в бесконечном режиме, чтобы попасть в таблицу.';
    renderComboBoard(board);
  } catch {
    overNoteEl.hidden = false;
    overNoteEl.textContent = 'Таблица комбо недоступна. Попробуй позже.';
    boardListEl.hidden = true;
  }
}

function renderComboBoard(board: ComboLeaderboardResponse): void {
  boardListEl.hidden = false;
  boardListEl.innerHTML = '';
  const rows = [...board.entries];
  // Своя строка нужна всегда, даже если игрок не попал в верхушку таблицы.
  if (board.me && !rows.some((entry) => entry.rank === board.me!.rank)) rows.push(board.me);
  for (const entry of rows) {
    const item = document.createElement('li');
    if (board.me && entry.rank === board.me.rank) item.className = 'me';
    item.innerHTML =
      `<span class="rank">${entry.rank}</span><span></span><span class="pts"></span>`;
    (item.children[1] as HTMLElement).textContent = entry.name;
    (item.children[2] as HTMLElement).textContent = groupDigits(entry.combo);
    boardListEl.appendChild(item);
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
  mode = 'duel';
  menuEl.hidden = true;
  resultEl.hidden = true;
  session = new Session(data.seed, 'duel', cfg, duelDuration);
  // Цвет фаз решали оба игрока, а ходы в записи только свои: без заявок
  // реплей насчитал бы другие очки.
  session.setClaims(data.claims.map((claim) => ({ ...claim, color: claim.color as Color })));
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

/** Всплывающая подпись над местом хода. */
function showFloatingLabel(text: string, at: { x: number; y: number }): void {
  const label = document.createElement('span');
  label.className = 'float-label';
  label.textContent = text;
  // Координаты приходят от доски, а подпись висит на окуляре: доска в нём
  // висит по центру, так что без сдвига цифра оторвалась бы от хода.
  label.style.left = `${at.x + canvas.offsetLeft}px`;
  label.style.top = `${at.y + canvas.offsetTop}px`;
  boardWrap.appendChild(label);
  setTimeout(() => label.remove(), 900);
}

function showFloatingPoints(points: number, multiplier: number, at: { x: number; y: number }): void {
  showFloatingLabel(multiplier > 1 ? `+${points} ×${multiplier}` : `+${points}`, at);
}

/**
 * Отчёт по заказу вместо обычного отчёта о ходе. Возвращает false, если
 * режим не тот, — тогда прибор говорит как обычно.
 *
 * Размер группы называем только после хода: до касания игрок его не знает,
 * и в этом вся ставка. Зато после — знает точно, вплоть до «двадцать
 * четыре», ради которых стоило рискнуть ещё одним разбором.
 */
function reportOrder(removed: number): boolean {
  const order = session.order();
  if (!order) return false;
  const fire = session.lastFire;
  if (fire === null) {
    // Ход не цветом окна: заказу он не в счёт, зато растит пятно под него.
    setStat(order.open ? `Снято ${removed} · пятно растёт` : `Снято ${removed} · окно закрыто`);
  } else if (fire.reward > 0) {
    setStat(`Заказ · ${fire.size} точек · +${groupDigits(fire.reward)}`, 'live');
    if (navigator.vibrate) navigator.vibrate(FEEL.hapticMax);
  } else {
    setStat(`${fire.size} — не хватило до ${session.cfg.orderTarget}`, 'warn');
    if (navigator.vibrate) navigator.vibrate([FEEL.hapticMax, 40, FEEL.hapticMax]);
  }
  updateHud();
  return true;
}

/**
 * Смена окна: прибор объявляет новый цвет, а заодно и судьбу прошлого
 * окна. Пропущенное окно обрывает серию — сказать об этом должен прибор,
 * а не догадка игрока.
 */
let shownWindow = -1;
function watchWindow(): void {
  const order = session.order();
  if (!order || order.cycle === shownWindow) return;
  const first = shownWindow < 0;
  shownWindow = order.cycle;
  if (first || !session.started) return;
  if (session.lastWindow === 'missed') {
    setStat('Окно закрыто · заказ не собран, серия обнулена', 'warn');
    flashMini();
    return;
  }
  setStat(`Окно закрыто · серия ${session.orderStreak}`, 'live');
}

const input = new ChainInput(
  canvas,
  renderer,
  () => session.board,
  cfg,
  (path: Cell[]) => {
    const oldGrid = session.board.grid;
    const at = input.pointer ?? renderer.center(path[path.length - 1]!);
    const elapsed = session.elapsed;
    // Часы пускает первый ход: до него игрок разглядывает образец.
    session.begin();
    const claimBefore = session.leader();
    // В опыте наружу приходит группа, и первой в ней стоит нажатая точка:
    // ядру нужна она одна, остальное оно соберёт само.
    const result = cfg.features.tap ? session.tryTap(path[0]!) : session.tryMove(path);
    if (typeof result === 'string') return;
    if (sprintRun) {
      sprintRun.moves.push({ path: path.map((cell) => ({ ...cell })), t: Number(elapsed.toFixed(3)) });
    }
    if (inDuel) duel.move(path);
    countScore(result.points);
    renderer.animateMove(oldGrid, result);
    updateStreak(result.streak);
    // Снятое показываем строкой состояния — это и есть отчёт прибора. В
    // заказах отчёт другой: там важно не сколько снято вообще, а сколько
    // ушло в заказ, — и цифра над полем там тоже другая.
    if (reportOrder(result.removed.length)) {
      const fire = session.lastFire;
      if (fire) showFloatingLabel(fire.reward > 0 ? `${fire.size} · +${fire.reward}` : `${fire.size}`, at);
    } else {
      showFloatingPoints(result.points, result.multiplier, at);
      const gain = result.multiplier > 1 ? ` ×${result.multiplier}` : '';
      setStat(`Снято ${result.removed.length + result.exploded.length} · +${result.points}${gain}`, 'live');
    }
    updateGoKey();
    updateHud();
    // Своя заявка в одиночных режимах: в дуэли её объявит сервер.
    const claimAfter = session.leader();
    if (claimAfter !== null && claimAfter !== claimBefore) {
      announceClaim(true, claimAfter.length, false);
    }
    // Последним: рекорд и продление комбо должны перебивать отчёт о ходе.
    countCombo(path, elapsed, result.points, result.removed.length);
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
  // Игрок отошёл от доски — удобный момент досдать заход: в кабинете и
  // таблице он должен увидеть свой сегодняшний рекорд, а не прошлый.
  void sendCombo();
  resultEl.hidden = true;
  menuEl.hidden = false;
  // Текущий режим отмечаем, а не предлагаем заново: игрок уже в нём.
  for (const item of menuEl.querySelectorAll<HTMLElement>('.menu-list li')) {
    item.classList.toggle('on', item.dataset.go === mode);
  }
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
  startGame();
}

/**
 * Главная клавиша: пока идёт партия — начать заново, после конца —
 * повторить. В дуэли нового образца не выдаём: там он общий с соперником.
 */
function updateGoKey(): void {
  const locked = inDuel || replay !== null;
  goKey.toggleAttribute('disabled', locked);
  const label = session.over ? 'Повторить' : session.started ? 'Сброс' : 'Наблюдать';
  goKey.firstChild!.nodeValue = locked ? 'Наблюдать' : label;
}

// Пункта «Продолжить» здесь нет: заслонку убирает та же клавиша, что её
// открыла, и отдельная строка списка только повторяла бы её.
const MENU_ACTIONS: Record<string, () => void> = {
  sprint: () => {
    menuEl.hidden = true;
    setMode('sprint');
  },
  free: () => {
    menuEl.hidden = true;
    setMode('free');
  },
  order: () => {
    menuEl.hidden = true;
    setMode('order');
  },
  duel: () => {
    duelSheet.hidden = false;
  },
  rules: () => {
    rulesSheet.hidden = false;
  },
  tutorial: () => startTutorial(),
};

menuEl.addEventListener('click', (event) => {
  // Режимы — строки списка, обучение с правилами — клавиши рядом: обходим
  // и то и другое одним слушателем по data-go.
  const item = (event.target as HTMLElement).closest<HTMLElement>('[data-go]');
  const action = item ? MENU_ACTIONS[item.dataset.go ?? ''] : undefined;
  if (action) action();
});

el<HTMLButtonElement>('tut-skip').addEventListener('click', () => stopTutorial());

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
 * Стоп-кадр — только для режимов без часов. В дуэли время общее с
 * соперником, а спринт стал соревновательным: там остановка часов дала бы
 * фору — думай сколько хочешь, а таймер стоит. Где часов нет, отнимать
 * нечего: и комбо, и заказ считаются за ход, а не за секунду.
 */
function canPause(): boolean {
  return !session.timed && replay === null && !session.over && session.started;
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
    viewingOnly = false;
    overlay.hidden = true;
    closed = true;
  }
  return closed;
}

/**
 * «Профиль» — прямой путь к своим числам: рекорды, таблицы, друзья.
 * Повторное нажатие закрывает кабинет, как и любая другая клавиша.
 *
 * Отдельного стоп-кадра у прибора больше нет: партию замораживает само
 * открытие панели управления, и держать под это отдельную клавишу — значит
 * занимать треть клавиатуры тем, что уже делает соседняя.
 */
el<HTMLDivElement>('key-profile').addEventListener('click', () => {
  if (cabinet.visible) {
    cabinet.hide();
    return;
  }
  // Прочие окна сперва убираем: кабинет должен открыться поверх чистого поля.
  closeWindows();
  void openCabinet();
});

/**
 * Открывает кабинет, заводя профиль, если его ещё нет: игрок нажал
 * «Профиль» — значит, он и хочет его завести. Не вышло — кабинет всё
 * равно откроется и честно скажет, что данных нет.
 */
async function openCabinet(): Promise<void> {
  if (apiAvailable && !hasAuth()) {
    try {
      await ensureAuth(guestName);
    } catch {
      // Сервер молчит — кабинет покажет это сам.
    }
  }
  await cabinet.show('history');
}

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
  onSprintBoard: () => void showSprintBoard(),
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
/** Подпись, уже показанная в углу окуляра. */
let shownChain = '';
function frame(now: number): void {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  // Обучение забирает кадр целиком: у него своё поле, свои часы и свой
  // палец, а партия под ним стоит.
  if (tutorial.active) {
    tutorial.update(dt);
    renderer.draw(dt, tutorial.board.grid, tutorial.chain, tutorial.pointer, tutorial.phaseColor);
    requestAnimationFrame(frame);
    return;
  }

  // Во время реплея время партии задаёт запись, а не часы.
  if (!replay && session.tick(dt)) {
    if (sprintRun) {
      void finishSprint(sprintRun, session.score);
    } else if (inDuel) {
      // Итог объявляет сервер — ждём его сообщения, чтобы счёт сошёлся.
      showOverModal({ title: 'Дуэль', note: 'Время вышло, считаем результат…' });
    } else {
      // Соло-итог показываем прямо в окуляре — как показание прибора.
      showResult('Наблюдение завершено', session.score);
    }
    updateGoKey();
  }
  const order = session.order();
  if ((session.timed || order) && !session.over) updateHud();
  updateMini();
  watchWindow();

  // В заказах длину группы под пальцем не показываем: не знать её до
  // касания — и есть вся ставка режима. Вместо счётчика — напоминание.
  const corner = order ? `Нужно ${session.cfg.orderTarget}+` : `Цепь ${input.chain.length}`;
  if (corner !== shownChain) {
    shownChain = corner;
    chainCountEl.textContent = corner;
  }

  // Ореолы на поле — по цвету резонанса: в заказах его задаёт окно.
  const glow = order ? (order.open ? order.color : null) : session.phase().active;
  renderer.draw(dt, session.board.grid, input.chain, input.pointer, glow);
  requestAnimationFrame(frame);
}

startGame();
requestAnimationFrame(frame);
// Первый запуск встречает показом, а не пустой панелью: правила проще
// увидеть, чем прочитать. Дальше обучение живёт пунктом меню.
if (firstVisit()) startTutorial();
else openMenu();
el<HTMLSpanElement>('brand').innerHTML = brandLockup(88);
el<HTMLSpanElement>('menu-brand').innerHTML = brandLockup(96);
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
