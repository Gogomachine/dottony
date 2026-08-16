import {
  cleanMarks,
  markById,
  DEFAULT_CONFIG,
  type Cell,
  type Color,
  type GameConfig,
} from '@doton/core';
import type {
  BoardPeriod,
  InviteInfo,
  MoveLog,
  OrderLeaderboardResponse,
  OrderMove,
  RatingLeaderboardResponse,
  SprintLeaderboardResponse,
} from '@doton/protocol';
import type { DuelServerMessage } from '@doton/protocol';
import {
  addFriend,
  apiAvailable,
  ensureAuth,
  getConfig,
  getOrderBoard,
  getInvites,
  dropInvite,
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
  startParam,
  submitOrder,
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
import { Sound } from './game/sound';
import { Tutorial } from './tutorial';
import { brandLockup } from './brand';
import { emblemSvg } from './emblem';
import { markChip, loadPlate, savePlate, showPlate } from './plate';
import {
  applyTheme,
  loadMarks,
  loadSound,
  loadThemeName,
  saveMarks,
  saveSound,
  SCOPE,
} from './theme';

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
const inviteBarEl = el<HTMLDivElement>('invite-bar');
const inviteTextEl = el<HTMLSpanElement>('invite-text');
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
const plateMarksEl = el<HTMLSpanElement>('plate-marks');
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
 * Голос прибора. Контекст рождается только с первого касания экрана —
 * до него система звук всё равно не пустит, — поэтому здесь заводится
 * лишь сам объект и память о том, включён он или выключен.
 */
const sound = new Sound({ muted: !loadSound() });

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
 * Журнал захода заказов. Ход здесь — одно касание, и по журналу сервер
 * переигрывает заход ядром: в таблицу идёт только пересчитанный им счёт.
 *
 * Журнал ограничен: с какого-то момента заход перестаёт быть доказуемым,
 * и это честнее, чем принимать число на слово.
 */
let orderRun: { seed: number; moves: OrderMove[]; full: boolean } | null = null;

/**
 * Потолок журнала захода. Значение то же, что в схеме протокола, но
 * значением его оттуда не берём: любой не-type импорт из @doton/protocol
 * затащил бы в бандл клиента ещё и zod.
 */
const ORDER_MOVE_LIMIT = 1200;

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
  // Способ хода ставим до партии: сессия, ввод и рендер читают один конфиг,
  // и режим заказов меняет его для себя.
  syncTap();
  session = newSession(seed);
  // Новый образец снимает запрет ввода: партия другая, запрет от старой не её.
  if (!replay) input.enabled = true;
  // Заказы пишутся целиком: заход кончается сбоями, и тогда журнал уходит
  // на проверку одним куском.
  orderRun = session.mode === 'order' ? { seed: session.seed, moves: [], full: false } : null;
  // Спринт пишется весь: без журнала рекорд нечем подтвердить.
  sprintRun =
    session.mode === 'sprint' && !replay ? { seed: session.seed, moves: [] } : null;
  renderer.resetAnims();
  updateStreak(0);
  // Третье поле приборной строки занимают дуэль и заказы; заказы поднимут
  // его сами при первом же обновлении.
  vsFieldEl.hidden = !inDuel;
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

/**
 * Имя игрока в чужой таблице: перед ним — его шильдик, если корпус помечен.
 * Строку собираем из узлов, а не из разметки: имя пришло с сервера.
 */
function nameWithMark(host: HTMLElement, name: string, mark: string | null): void {
  host.textContent = '';
  const badge = mark === null ? undefined : markById(mark);
  if (badge) host.appendChild(markChip(badge));
  host.appendChild(document.createTextNode(name));
}

/** «1 заказ», «4 заказа», «7 заказов» — число решает окончание. */
function orderWord(count: number): string {
  const teens = count % 100;
  const last = count % 10;
  if (teens >= 11 && teens <= 14) return `${count} заказов`;
  if (last === 1) return `${count} заказ`;
  if (last >= 2 && last <= 4) return `${count} заказа`;
  return `${count} заказов`;
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
    showFails();
    timeLabelEl.textContent = 'Заказы';
    timeEl.textContent = String((session.run?.orders ?? 0));
    const lit = Math.round((order.remaining / session.cfg.orderWindow) * TICKS);
    // Последние секунды окна шкала краснеет — это видно боковым зрением.
    const warn = order.remaining <= 5;
    timeFieldEl.className = `field right${warn ? ' warn' : ''}`;
    tickEls.forEach((tick, i) => {
      tick.className = `tick${i < lit ? (warn ? ' warn' : ' on') : ''}`;
    });
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
  if (order && session.over) {
    if (miniCache === 'dead') return;
    miniCache = 'dead';
    showMini({ text: 'Резонанс · <b>сбой</b>', cd: '--', color: null, fill: 0 });
    tintScope(null);
    return;
  }
  if (order) {
    const key = `o${order.color}:${Math.ceil(order.remaining)}`;
    if (key === miniCache) return;
    miniCache = key;
    showMini(orderMini(order, session.cfg));
    tintScope(SCOPE.dots[order.color]!);
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
  sound.claim(mine);
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
    }
    // Молчать нельзя: партия сыграна, а места в таблице нет — игрок должен
    // видеть, что дело в отправке, а не в его счёте.
    resultSubEl.textContent = 'Заход не дошёл до таблицы';
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
      `<span class="rank">${entry.rank}</span><span class="who-line"></span><span class="pts"></span>`;
    nameWithMark(item.children[1] as HTMLElement, entry.name, entry.mark);
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
let openBoard: 'sprint' | 'order' | null = null;

function showBoardTabs(board: 'sprint' | 'order'): void {
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
  else void showOrderBoard(period);
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
  // Код комнаты — аварийный выход, а не обычный путь: он появляется, только
  // когда приглашение не дошло.
  roomBoxEl.hidden = options.room === undefined || !showCode;
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

/**
 * Запас сбоев — третьим полем приборной строки, как счёт соперника в
 * дуэли. Место одно: в заказах соперника нет, а в дуэли нет сбоев.
 */
function showFails(): void {
  const left = Math.max(0, session.cfg.orderLives - (session.run?.fails ?? 0));
  vsFieldEl.hidden = false;
  vsNameEl.textContent = 'Запас';
  vsScoreEl.textContent = `${left} / ${session.cfg.orderLives}`;
  // Последний сбой красим: заход держится на одном окне.
  vsFieldEl.className = `field${left <= 1 ? ' warn' : ''}`;
}

/** Счёт соперника — третьим полем приборной строки, только в дуэли. */
function showVersus(name: string, opponentScore: number): void {
  vsFieldEl.hidden = false;
  // Когда корпус занят соперником, имя стоит там же, рядом с его
  // шильдиками: повторять их обоих над счётом — двоение.
  vsNameEl.textContent = plateHasOpponent ? 'Соперник' : name;
  vsScoreEl.textContent = String(opponentScore);
  // Кто впереди, видно по цвету: отставание горит акцентом.
  vsFieldEl.className = `field${session.score < opponentScore ? ' warn' : ''}`;
}

let opponentName = 'Соперник';
/** Шильдики соперника — единственное, чем он помечен на твоём приборе. */
let opponentMarks: (string | null)[] = [];

/**
 * Что написано на корпусе. Свои шильдики игрок и так знает наизусть,
 * поэтому на время матча корпус занимает соперник: его набор — всё, что
 * о нём вообще видно, и смотреть на него интереснее, чем на свой.
 *
 * Пустой корпус соперника не занимает: голая полоса выглядит поломкой, а
 * не сообщением, — в этом случае на месте остаются свои шильдики.
 */
function updatePlate(): void {
  plateHasOpponent = inDuel && opponentMarks.some((id) => id !== null);
  if (plateHasOpponent) showPlate(plateMarksEl, opponentMarks, opponentName);
  else showPlate(plateMarksEl, loadPlate());
}

/** Занят ли корпус соперником — тогда его имя стоит на корпусе, а не над счётом. */
let plateHasOpponent = false;
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
              note: inviteNote ?? 'Зовём друга — как только он откроет приглашение, матч начнётся.',
              room: message.room,
              waiting: true,
            }
          : { title: 'Дуэль', note: 'Ищем живого соперника…', waiting: true },
      );
      // Ожидание не должно выглядеть зависанием. В открытом подборе через
      // несколько секунд сервер подставит запись — так и говорим. В комнате
      // подставлять некого: там ждут конкретного человека, и если он не
      // пришёл, честнее сказать это, чем крутить многоточие дальше.
      clearTimeout(searchHint);
      searchHint = window.setTimeout(
        () => {
          if (!waitingForOpponent) return;
          overNoteEl.textContent = message.room
            ? 'Друг ещё не открыл приглашение. Можно подождать или отменить и сыграть быстрый матч.'
            : 'Никого рядом — подбираю запись чужого матча…';
        },
        message.room ? 20_000 : 6000,
      );
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
      // Сервер мог быть старее клиента: поля может не быть вовсе.
      opponentMarks = cleanMarks(message.opponentMarks ?? []);
      updatePlate();
      opponentScore = 0;
      // Матч начался — звать больше некуда.
      showInvite(null);
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
      // Сервер мог быть старее клиента: поля может не быть вовсе.
      opponentMarks = cleanMarks(message.opponentMarks ?? []);
      updatePlate();
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
      // Второй «finished» с рейтингом приходит следом: звучим один раз.
      if (inDuel) sound.over(message.outcome === 'win');
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
  // Соперник ушёл — корпус возвращается хозяину.
  opponentMarks = [];
  updatePlate();
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
    nameWithMark(who.children[0] as HTMLElement, entry.name, entry.mark);
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
  // Вернулись в игру — спрашиваем про приглашения сразу, не дожидаясь
  // очередного опроса: минуту назад позвать могли, а окно было свёрнуто.
  if (document.visibilityState !== 'hidden') {
    void pollInvites();
    return;
  }
  void flushScore();
});

// ---------- Заказы: журнал и рекорд ----------

/**
 * Записывает касание в журнал захода. Журнал не бесконечен, а хороший
 * заход — почти: когда он полон, заход перестаёт быть доказуемым, и
 * молчать об этом нельзя — рекорд просто не примут.
 */
function countOrder(cell: Cell, t: number): void {
  const run = orderRun;
  if (!run) return;
  if (run.moves.length >= ORDER_MOVE_LIMIT) {
    if (!run.full) {
      run.full = true;
      setStat('Журнал захода полон — этот заход в таблицу не пойдёт', 'warn');
    }
    return;
  }
  run.moves.push({ cell: { ...cell }, t: Number(t.toFixed(3)) });
}

/**
 * Конец захода: отдаём журнал на проверку и показываем место. Своего числа
 * не шлём вовсе — сервер переигрывает касания ядром и считает счёт сам,
 * так рекорд остаётся доказанным, а не заявленным.
 */
async function finishOrder(run: { seed: number; moves: OrderMove[]; full: boolean }): Promise<void> {
  if (!apiAvailable || run.full || run.moves.length === 0) return;
  // Рекорд идёт в общую таблицу, поэтому имя тут спросить уместно.
  if (!hasAuth()) {
    try {
      await ensureAuth(guestName);
    } catch {
      return;
    }
  }

  try {
    const result = await submitOrder(run.seed, run.moves);
    resultSubEl.textContent = result.record
      ? `Рекорд · ${result.rank}-е место`
      : `${result.rank}-е место · рекорд ${groupDigits(result.best)}`;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      resetAuth();
    }
    // Молчать нельзя: заход сыгран, а места в таблице нет — игрок должен
    // видеть, что дело в отправке, а не в его счёте.
    resultSubEl.textContent = 'Заход не дошёл до таблицы';
  }
}

async function showOrderBoard(period: BoardPeriod = boardPeriod): Promise<void> {
  boardPeriod = period;
  showOverModal({ title: 'Рекорды заказов', note: 'Загружаю таблицу…', viewing: true });
  showBoardTabs('order');
  try {
    const board = await getOrderBoard(period);
    if (board.entries.length === 0) {
      overNoteEl.hidden = false;
      overNoteEl.textContent =
        period === 'day'
          ? 'Сегодня заказов ещё никто не сдавал. Закрой хоть один — и ты первый.'
          : 'Таблица пока пуста. Считается счёт захода: 25 точек цвета окна за одно касание.';
      boardListEl.hidden = true;
      return;
    }
    overNoteEl.hidden = false;
    overNoteEl.textContent = board.me
      ? `${period === 'day' ? 'Сегодня' : 'Твой рекорд'} ${groupDigits(board.me.score)} · ${board.me.rank}-е место`
      : 'Сдай заход заказов, чтобы попасть в таблицу.';
    renderOrderBoard(board);
  } catch {
    overNoteEl.hidden = false;
    overNoteEl.textContent = 'Таблица заказов недоступна. Попробуй позже.';
    boardListEl.hidden = true;
  }
}

function renderOrderBoard(board: OrderLeaderboardResponse): void {
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
    nameWithMark(who.children[0] as HTMLElement, entry.name, entry.mark);
    // Заказы подписью под именем: по ним видно, из чего сложился счёт.
    (who.children[1] as HTMLElement).textContent = orderWord(entry.orders);
    (item.children[2] as HTMLElement).textContent = groupDigits(entry.score);
    boardListEl.appendChild(item);
  }
}

// ---------- Приглашения от друзей ----------

/**
 * Приглашение приходит прямо в прибор: пока игра открыта, она спрашивает
 * сервер, не зовёт ли кто. Ответ на этот же вопрос говорит серверу, что
 * игрок здесь, — и Telegram он тревожит, только когда игры нет.
 *
 * Опросом, а не постоянной связью: сокет у нас живёт ровно столько,
 * сколько идёт матч, и держать второй ради одной строчки было бы дорого.
 */
const INVITE_POLL_MS = 5000;
let invitePoll = 0;
/** Комната, чьё приглашение сейчас на экране; null — полоса скрыта. */
let inviteRoom: string | null = null;
/** Комнаты, от которых игрок отмахнулся: второй раз не показываем. */
const dismissed = new Set<string>();

function showInvite(invite: InviteInfo | null): void {
  inviteRoom = invite?.room ?? null;
  inviteBarEl.hidden = invite === null;
  if (!invite) return;
  nameWithMark(inviteTextEl, `${invite.from} зовёт в дуэль`, invite.mark);
}

async function pollInvites(): Promise<void> {
  // В матче, в реплее и под обучением звать некуда: игрок уже занят.
  if (!apiAvailable || !hasAuth() || inDuel || replay || tutorial.active) return;
  if (document.visibilityState === 'hidden') return;
  try {
    const { invites } = await getInvites();
    const fresh = invites.find((invite) => !dismissed.has(invite.room)) ?? null;
    // Перерисовываем, только если сменилась комната: полоса не должна
    // мигать на каждом опросе.
    if ((fresh?.room ?? null) !== inviteRoom) showInvite(fresh);
  } catch {
    // Сеть подвела — приглашение придёт следующим опросом.
  }
}

function watchInvites(): void {
  if (invitePoll !== 0) return;
  invitePoll = window.setInterval(() => void pollInvites(), INVITE_POLL_MS);
  void pollInvites();
}

el<HTMLButtonElement>('invite-accept').addEventListener('click', () => {
  const room = inviteRoom;
  if (room === null) return;
  showInvite(null);
  void dropInvite(room).catch(() => {
    // Не убралось на сервере — оно протухнет само через полторы минуты.
  });
  void startDuel(room);
});

el<HTMLButtonElement>('invite-drop').addEventListener('click', () => {
  const room = inviteRoom;
  if (room === null) return;
  dismissed.add(room);
  showInvite(null);
  void dropInvite(room).catch(() => {
    // То же самое: сервер сотрёт приглашение по сроку.
  });
});

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
    setStat(`Снято ${removed} · пятно растёт`);
  } else if (fire.reward > 0) {
    // Заказ закрыт — окно вместе с ним: цвет уже сменился, и говорить об
    // этом отдельной строкой не нужно, серия дописывается сюда же.
    const run = (session.run?.streak ?? 0) > 1 ? ` · серия ${(session.run?.streak ?? 0)}` : '';
    setStat(`Заказ · ${fire.size} точек · +${groupDigits(fire.reward)}${run}`, 'live');
    sound.order(fire.size, fire.reward);
    if (navigator.vibrate) navigator.vibrate(FEEL.hapticMax);
  } else {
    setStat(`${fire.size} — не хватило до ${session.cfg.orderTarget}`, 'warn');
    sound.order(fire.size, 0);
    if (navigator.vibrate) navigator.vibrate([FEEL.hapticMax, 40, FEEL.hapticMax]);
  }
  updateHud();
  return true;
}

/**
 * Смена окна. Про закрытый заказ уже сказал отчёт о ходе — здесь остаётся
 * упущенное окно: его обрыв серии игрок иначе увидит только по счётчику.
 */
let shownWindow = -1;
function watchWindow(): void {
  const order = session.order();
  if (!order || session.over || order.cycle === shownWindow) return;
  const first = shownWindow < 0;
  shownWindow = order.cycle;
  // Новое окно прибор объявляет сам — это его сигнал, а не наша подпись.
  if (!first && session.started) sound.window();
  if (first || !session.started || session.run?.lastWindow !== 'missed') return;
  const left = session.cfg.orderLives - (session.run?.fails ?? 0);
  setStat(
    left === 1
      ? 'Окно упущено · остался последний запас'
      : `Окно упущено · сбой ${(session.run?.fails ?? 0)} из ${session.cfg.orderLives}`,
    'warn',
  );
  flashMini();
  sound.miss();
  if (navigator.vibrate) navigator.vibrate([FEEL.hapticMax, 40, FEEL.hapticMax]);
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
    // Голос хода: в заказах он свой, там говорит отчёт о заказе.
    if (!cfg.features.tap) {
      sound.chain(result.removed.length, result.multiplier);
      if (result.charged !== null) sound.lens();
    }
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
    // Заказы пишем последними: в журнал идёт то же касание, что и в ход.
    countOrder(path[0]!, elapsed);
  },
  (length: number) => {
    // Чем длиннее цепочка, тем ощутимее отклик — рука чувствует прогресс,
    // а ухо слышит: каждая следующая точка звучит ступенью выше.
    sound.step(length - 1);
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

el<HTMLButtonElement>('sound-toggle').addEventListener('click', function () {
  const on = sound.muted;
  sound.setMuted(!on);
  saveSound(on);
  this.classList.toggle('on', on);
  // Нажатие — тоже касание: на нём звук и просыпается, и сразу отвечает.
  if (on) {
    sound.wake();
    sound.claim(true);
  }
});

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

// Позвать друга — значит выбрать его в списке: кода никто не диктует, а
// приглашение уходит ему в бота кнопкой прямо в комнату.
el<HTMLButtonElement>('invite').addEventListener('click', () => {
  duelSheet.hidden = true;
  menuEl.hidden = true;
  void cabinet.show('friends');
});

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
  onOrderBoard: () => void showOrderBoard(),
  onInvite: (friendCode) => void inviteToRoom(friendCode),
  onMarks: (marks) => {
    savePlate(marks);
    updatePlate();
  },
});

/**
 * Зовёт друга в комнату. Приглашение уходит ему в бота ссылкой прямо в
 * эту комнату — диктовать нечего.
 *
 * Дойти оно может не всегда: бот не пишет тому, кто его не запускал. Тогда
 * — и только тогда — на экране появляется код комнаты: это последний
 * способ позвать, и прятать его в такой момент было бы вредным изяществом.
 */
async function inviteToRoom(friendCode: string): Promise<void> {
  const room = makeRoomCode();
  showRoomCode(false);
  await startDuel(room);
  try {
    const { where } = await inviteFriend(friendCode, room);
    // Говорим, куда именно позвали: «в игре» и «в Telegram» — разные
    // обещания по времени ответа, и путать их не стоит.
    inviteNote =
      where === 'game'
        ? 'Друг в игре — приглашение у него на экране.'
        : 'Позвали в Telegram — ждём, пока откроет.';
    showRoomCode(false);
  } catch {
    inviteNote = 'Позвать не вышло — продиктуй другу код комнаты.';
    showRoomCode(true);
  }
  // Ответ сервера о поиске может прийти и раньше, и позже нашего — поэтому
  // заметку не пишем напрямую, а держим и подставляем при перерисовке.
  if (waitingForOpponent) overNoteEl.textContent = inviteNote;
}

/** Показывать ли код комнаты на экране ожидания. */
let showCode = false;
function showRoomCode(show: boolean): void {
  showCode = show;
  roomBoxEl.hidden = !show;
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
/** Секунда, на которой прибор уже отщёлкал. */
let shownSecond = -1;

/**
 * Последние десять секунд партии прибор отсчитывает вслух: на глаз
 * оставшееся время в разгаре хода никто не смотрит, а щелчок слышно.
 */
function countdown(): void {
  if (!session.timed || session.over || !session.started) {
    shownSecond = -1;
    return;
  }
  const left = Math.ceil(session.timeLeft);
  if (left > 10 || left <= 0 || left === shownSecond) return;
  const first = shownSecond < 0;
  shownSecond = left;
  // Не щёлкаем на входе в партию, начатую с середины (возврат в матч).
  if (!first) sound.tick();
}
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
    } else if (session.mode === 'order') {
      // Заказы кончаются не временем, а запасом: об этом и говорим. Запас
      // дорисовываем сам: обычное обновление приборной строки мёртвый
      // заход уже не трогает, и на нём остался бы последний живой отсчёт.
      showFails();
      sound.over(false);
      showResult(`Прибор сбоит · ${orderWord(session.run?.orders ?? 0)}`, session.score);
      setStat('Запас сбоев исчерпан — заход окончен', 'warn');
      // Заход кончился — его и отдаём на проверку: счёт в таблицу ставит
      // сервер, переиграв присланные касания.
      if (orderRun) void finishOrder(orderRun);
    } else {
      // Соло-итог показываем прямо в окуляре — как показание прибора.
      sound.over(false);
      showResult('Наблюдение завершено', session.score);
    }
    updateGoKey();
  }
  const order = session.order();
  if ((session.timed || order) && !session.over) updateHud();
  updateMini();
  watchWindow();
  countdown();

  // В заказах длину группы под пальцем не показываем: не знать её до
  // касания — и есть вся ставка режима. Вместо счётчика — напоминание.
  const corner = order ? `Нужно ${session.cfg.orderTarget}+` : `Цепь ${input.chain.length}`;
  if (corner !== shownChain) {
    shownChain = corner;
    chainCountEl.textContent = corner;
  }

  // Ореолы на поле — по цвету резонанса: в заказах его задаёт окно.
  const glow = order ? order.color : session.phase().active;
  renderer.draw(dt, session.board.grid, input.chain, input.pointer, glow);
  requestAnimationFrame(frame);
}

startGame();
requestAnimationFrame(frame);

/**
 * Комната из ссылки-приглашения: друг нажал кнопку в боте, и игра должна
 * открыться прямо в матче, а не в меню. Кода он при этом не видел вовсе.
 */
function invitedRoom(): string | null {
  const param = startParam();
  return param !== null && param.startsWith('duel_') ? param.slice(5) : null;
}

const invited = invitedRoom();
if (invited !== null) {
  // Показ и панель подождут: человека позвали в матч, он идёт в матч.
  seenTutorial();
  inviteNote = 'Подключаюсь к другу…';
  void startDuel(invited);
} else if (firstVisit()) {
  // Первый запуск встречает показом, а не пустой панелью: правила проще
  // увидеть, чем прочитать. Дальше обучение живёт пунктом меню.
  startTutorial();
} else {
  openMenu();
}
el<HTMLSpanElement>('brand').innerHTML = brandLockup(88);
el<HTMLSpanElement>('menu-brand').innerHTML = brandLockup(96);
renderer.setMarks(loadMarks());
// Корпус помечен ещё до всякого входа: выбор лежит и у нас, и на сервере.
updatePlate();
el<HTMLButtonElement>('sound-toggle').classList.toggle('on', !sound.muted);
el<HTMLButtonElement>('mark-toggle').classList.toggle('on', loadMarks());
el<HTMLButtonElement>('theme-toggle').classList.toggle('on', themeName === 'graphite');

if (isTelegram()) {
  document.documentElement.classList.add('in-telegram');
  syncChrome();
}

// Звук просыпается с первого касания: до него система держит его спящим.
addEventListener('pointerdown', () => sound.wake(), { once: true });

// Пока игра открыта, она слушает приглашения друзей — и этим же говорит
// серверу, что игрок здесь.
if (apiAvailable) watchInvites();

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
