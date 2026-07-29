import { DEFAULT_CONFIG, type Cell } from '@doton/core';
import type { LeaderboardResponse, MoveLog, RatingLeaderboardResponse } from '@doton/protocol';
import type { DuelServerMessage } from '@doton/protocol';
import {
  apiAvailable,
  ensureAuth,
  getMe,
  getRatingBoard,
  getDaily,
  getLeaderboard,
  hasAuth,
  isTelegram,
  localDailySeed,
  localToday,
  resetAuth,
  savedName,
  submitDaily,
  ApiError,
} from './api';
import { DuelConnection, inviteLink, makeRoomCode, roomFromLocation } from './duel';
import { FEEL } from './game/feel';
import { ChainInput } from './game/input';
import { Renderer } from './game/renderer';
import { Session, SPRINT_SECONDS, type Mode } from './game/session';
import { mascotSvg } from './mascot';
import { applyTheme, loadThemeName, THEMES, type Theme } from './theme';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

const canvas = el<HTMLCanvasElement>('game');
const scoreEl = el<HTMLSpanElement>('score');
const timeEl = el<HTMLSpanElement>('time');
const timeFill = el<HTMLElement>('time-fill');
const seedEl = el<HTMLSpanElement>('seed');
const overlay = el<HTMLDivElement>('game-over');
const overTitleEl = el<HTMLHeadingElement>('over-title');
const overNoteEl = el<HTMLParagraphElement>('over-note');
const finalScoreEl = el<HTMLSpanElement>('final-score');
const dailyBoardEl = el<HTMLOListElement>('daily-board');
const restartBtn = el<HTMLButtonElement>('restart');
const phaseEl = el<HTMLDivElement>('phase');
const phaseTextEl = el<HTMLSpanElement>('phase-text');
const mascotEl = el<HTMLSpanElement>('mascot');
const streakEl = el<HTMLSpanElement>('streak');
const versusEl = el<HTMLDivElement>('versus');
const vsNameEl = el<HTMLSpanElement>('vs-name');
const vsScoreEl = el<HTMLSpanElement>('vs-score');
const vsGapEl = el<HTMLSpanElement>('vs-gap');
const duelRecordEl = el<HTMLSpanElement>('duel-record');
const rankChipEl = el<HTMLButtonElement>('rank-chip');
const ratingLineEl = el<HTMLDivElement>('rating-line');
const roomBoxEl = el<HTMLDivElement>('room-box');
const roomCodeEl = el<HTMLSpanElement>('room-code');
const copyLinkBtn = el<HTMLButtonElement>('copy-link');
const overMascotEl = el<HTMLDivElement>('over-mascot');
const boardWrap = canvas.parentElement as HTMLElement;

// ---------- Заппо ----------

mascotEl.innerHTML = mascotSvg({ size: 38 });
let winkTimer = 0;

/** Заппо подмигивает и подпрыгивает — реакция на яркий момент. */
function winkMascot(): void {
  mascotEl.innerHTML = mascotSvg({ size: 38, wink: true });
  mascotEl.classList.remove('bounce');
  void mascotEl.offsetWidth; // перезапуск CSS-анимации
  mascotEl.classList.add('bounce');
  clearTimeout(winkTimer);
  winkTimer = window.setTimeout(() => {
    mascotEl.innerHTML = mascotSvg({ size: 38 });
  }, 900);
}

// ---------- Состояние ----------

let themeName = loadThemeName();
let theme: Theme = applyTheme(themeName);
let mode: Mode = 'sprint';

/** Активный забег ежедневного вызова: дата и лог ходов для сервера. */
let dailyRun: { date: string; moves: MoveLog[] } | null = null;
let dailyStarting = false;

/**
 * Идёт ли сейчас дуэль и сколько она длится (сервер сообщает при старте).
 * Объявлено до первой сессии: newSession() читает длительность.
 */
let inDuel = false;
let duelDuration = 90;

let session = newSession();
const renderer = new Renderer(canvas, DEFAULT_CONFIG, theme);

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
  session = newSession(seed);
  renderer.resetAnims();
  updateStreak(0);
  overlay.hidden = true;
  seedEl.textContent = `#${session.seed.toString(16)}`;
  updateHud();
}

/** Показывает текущую серию зарядов: следующий заряд даст такой множитель. */
function updateStreak(streak: number): void {
  const active = streak > 0;
  streakEl.hidden = !active;
  if (!active) return;
  streakEl.textContent = `×${streak + 1}`;
  // Перезапуск анимации, чтобы каждый новый заряд «выстреливал».
  streakEl.style.animation = 'none';
  void streakEl.offsetWidth;
  streakEl.style.animation = '';
}

function updateHud(): void {
  scoreEl.textContent = String(session.score);
  if (session.timed) {
    const total = Math.ceil(session.timeLeft);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    timeEl.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
    const full = session.mode === 'duel' ? duelDuration : SPRINT_SECONDS;
    timeFill.style.width = `${(session.timeLeft / full) * 100}%`;
  } else {
    timeEl.textContent = '∞';
    timeFill.style.width = '100%';
  }
}

// ---------- Баннер фазы ----------

let phaseBannerCache = '';

function updatePhaseBanner(): void {
  const { active, remaining, nextColor, nextIn } = session.phase();
  let html: string;
  let bannerClass = '';

  if (active !== null) {
    html = `<span class="swatch" style="--swatch:#fff"></span> Нагрузка сети ×${session.cfg.phaseMultiplier} — ${Math.ceil(remaining)} с`;
    bannerClass = 'active';
    phaseEl.style.setProperty('--phase-bg', theme.dots[active]!);
  } else if (nextIn <= 5) {
    const color = theme.dots[nextColor]!;
    html = `<span class="swatch" style="--swatch:${color}"></span> Нагрузка через ${Math.ceil(nextIn)} с`;
  } else {
    html = 'Сеть стабильна';
  }

  const cacheKey = bannerClass + html;
  if (cacheKey === phaseBannerCache) return;
  phaseBannerCache = cacheKey;
  phaseTextEl.innerHTML = html;
  phaseEl.className = `phase ${bannerClass}`;
}

// ---------- Ежедневный вызов ----------

function guestName(): string {
  const existing = savedName();
  if (existing) return existing;
  const answer = prompt('Имя для таблицы дня:', 'Игрок') ?? 'Игрок';
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
    setActiveModeButton('daily');
    dailyRun = { date: info.date, moves: [] };
    startGame(info.seed);
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
  /** Показать код комнаты и кнопку копирования ссылки. */
  room?: string;
  /** Идёт ожидание соперника: кнопка станет «Отменить». */
  waiting?: boolean;
  /** Как матч сдвинул рейтинг. */
  rating?: RatingChange;
  /** Просмотр таблицы поверх игры: кнопка просто закрывает окно. */
  viewing?: boolean;
}): void {
  // В модалке финиша Заппо подмигивает за вызов дня, в остальных — просто рад.
  overMascotEl.innerHTML = mascotSvg({ size: 84, wink: options.title.startsWith('Вызов') });
  overTitleEl.textContent = options.title;
  roomBoxEl.hidden = options.room === undefined;
  if (options.room !== undefined) {
    roomCodeEl.textContent = options.room;
    currentRoom = options.room;
    copyLinkBtn.textContent = 'Скопировать ссылку';
  }
  finalScoreEl.hidden = options.score === undefined;
  if (options.score !== undefined) finalScoreEl.textContent = String(options.score);
  overNoteEl.hidden = options.note === undefined;
  overNoteEl.textContent = options.note ?? '';
  dailyBoardEl.hidden = true;
  ratingLineEl.hidden = true;
  if (options.rating) showRatingChange(options.rating);
  // Пока ждём соперника, единственное осмысленное действие — отменить поиск.
  waitingForOpponent = options.waiting ?? false;
  viewingOnly = options.viewing ?? false;
  restartBtn.textContent = waitingForOpponent
    ? 'Отменить'
    : viewingOnly || dailyRun || options.title.startsWith('Вызов')
      ? 'Закрыть'
      : 'Ещё раз';
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

function showVersus(name: string, opponentScore: number): void {
  versusEl.hidden = false;
  vsNameEl.textContent = name;
  vsScoreEl.textContent = String(opponentScore);
  const gap = session.score - opponentScore;
  vsGapEl.textContent = gap === 0 ? 'вровень' : gap > 0 ? `+${gap}` : String(gap);
  vsGapEl.className = `vs-gap mono ${gap > 0 ? 'ahead' : gap < 0 ? 'behind' : ''}`;
}

let opponentName = 'Соперник';
let opponentScore = 0;
/** Таймер подсказки на экране ожидания. */
let searchHint = 0;
/** Код комнаты, показанный в модалке, — для кнопки копирования ссылки. */
let currentRoom = '';
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
              note: 'Продиктуй другу код или пришли ссылку. Он вводит код кнопкой «Ввести код» — и матч начнётся сам.',
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
      connectionLost = false;
      duel.markActive();
      inDuel = true;
      duelDuration = message.duration;
      // Честно помечаем запись: игрок должен знать, что соперник не живой.
      opponentName = message.ghost ? `${message.opponent} · запись` : message.opponent;
      opponentScore = 0;
      mode = 'duel';
      dailyRun = null;
      setActiveModeButton('duel');
      startGame(message.seed);
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
      duelDuration = Math.max(1, Math.round(message.remaining));
      opponentName = message.ghost ? `${message.opponent} · запись` : message.opponent;
      opponentScore = message.opponentScore;
      mode = 'duel';
      setActiveModeButton('duel');
      startGame(message.seed);
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
      });
      endDuel({ awaitRating: true });
      void refreshProfile();
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
  inDuel = false;
  versusEl.hidden = true;
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
  // Профиль мог только что появиться — покажем лигу, не дожидаясь конца матча.
  void refreshProfile();
  duel.connect(room);
}

/** Обновляет чип лиги и сводку дуэлей. Без профиля чип просто скрыт. */
async function refreshProfile(): Promise<void> {
  if (!apiAvailable || !hasAuth()) return;
  try {
    const me = await getMe();
    duelRecordEl.textContent =
      me.duels.played > 0 ? `дуэли: ${me.duels.won} из ${me.duels.played}` : '';

    rankChipEl.hidden = false;
    rankChipEl.classList.toggle('provisional', me.placement !== null);
    if (me.placement) {
      // До калибровки лига не присвоена — показываем прогресс, а не звание.
      rankChipEl.textContent = `Калибровка ${me.placement.played}/${me.placement.required}`;
      rankChipEl.title = 'Сыграй рейтинговые дуэли, чтобы получить лигу';
      return;
    }
    rankChipEl.innerHTML = `<span></span><span class="rating"></span>`;
    (rankChipEl.children[0] as HTMLElement).textContent = me.league;
    (rankChipEl.children[1] as HTMLElement).textContent = String(me.rating);
    rankChipEl.title = me.next
      ? `${me.rank}-е место · до лиги «${me.next.league}» ${me.next.gap}`
      : `${me.rank}-е место · высшая лига`;
  } catch {
    // Статистика необязательна — молча пропускаем.
  }
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

// ---------- Ходы ----------

function showFloatingPoints(points: number, multiplier: number, at: { x: number; y: number }): void {
  const label = document.createElement('span');
  label.className = 'float-label';
  label.textContent = multiplier > 1 ? `+${points} В ×${multiplier}` : `+${points} В`;
  label.style.left = `${at.x}px`;
  label.style.top = `${at.y}px`;
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
    const result = session.tryMove(path);
    if (typeof result === 'string') return;
    if (dailyRun) {
      dailyRun.moves.push({ path: path.map((cell) => ({ ...cell })), t: Number(elapsed.toFixed(3)) });
    }
    if (inDuel) duel.move(path, elapsed);
    renderer.animateMove(oldGrid, result);
    showFloatingPoints(result.points, result.multiplier, at);
    updateStreak(result.streak);
    if (result.charged || result.exploded.length > 0) winkMascot();
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

el<HTMLButtonElement>('theme-toggle').addEventListener('click', () => {
  themeName = themeName === 'draft' ? 'graphite' : 'draft';
  theme = applyTheme(themeName);
  renderer.setTheme(THEMES[themeName]);
});

const modeButtons = {
  sprint: el<HTMLButtonElement>('mode-sprint'),
  free: el<HTMLButtonElement>('mode-free'),
  daily: el<HTMLButtonElement>('mode-daily'),
  duel: el<HTMLButtonElement>('mode-duel'),
};

function setActiveModeButton(active: keyof typeof modeButtons): void {
  for (const [key, button] of Object.entries(modeButtons)) {
    button.classList.toggle('active', key === active);
  }
}

function setMode(next: Mode): void {
  if (inDuel) endDuel();
  mode = next;
  dailyRun = null;
  setActiveModeButton(next);
  startGame();
}

modeButtons.sprint.addEventListener('click', () => setMode('sprint'));
modeButtons.free.addEventListener('click', () => setMode('free'));
modeButtons.daily.addEventListener('click', () => void startDaily());
modeButtons.duel.addEventListener('click', () => void startDuel());

el<HTMLButtonElement>('invite').addEventListener('click', () => {
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
  void startDuel(room);
});

rankChipEl.addEventListener('click', () => void showRatingBoard());

copyLinkBtn.addEventListener('click', () => {
  const link = inviteLink(currentRoom);
  navigator.clipboard
    ?.writeText(link)
    .then(() => {
      copyLinkBtn.textContent = 'Ссылка скопирована ✓';
    })
    .catch(() => {
      // Буфер обмена может быть недоступен — показываем ссылку, чтобы скопировать вручную.
      overNoteEl.textContent = link;
    });
});
el<HTMLButtonElement>('new-board').addEventListener('click', () => {
  dailyRun = null;
  setActiveModeButton(mode);
  startGame();
});
restartBtn.addEventListener('click', () => {
  if (viewingOnly) {
    // Смотрели таблицу — партия под окном не тронута.
    viewingOnly = false;
    overlay.hidden = true;
    return;
  }
  if (waitingForOpponent) {
    // Отменяем поиск и возвращаемся в обычный спринт.
    endDuel();
    setMode('sprint');
    return;
  }
  if (dailyRun) {
    // Попытка дня закончена — возвращаемся в обычный спринт.
    dailyRun = null;
    setActiveModeButton('sprint');
    startGame();
  } else {
    startGame();
  }
});

new ResizeObserver(() => renderer.resize()).observe(canvas);

// ---------- Игровой цикл ----------

let lastTime = performance.now();
function frame(now: number): void {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (session.tick(dt)) {
    if (dailyRun) {
      void finishDaily(dailyRun, session.score);
    } else if (inDuel) {
      // Итог объявляет сервер — ждём его сообщения, чтобы счёт сошёлся.
      showOverModal({ title: 'Дуэль', note: 'Время вышло, считаем результат…' });
    } else {
      showOverModal({ title: 'Время вышло', score: session.score });
    }
  }
  if (session.timed && !session.over) updateHud();
  updatePhaseBanner();

  renderer.draw(dt, session.board.grid, input.chain, input.pointer, session.phase().active);
  requestAnimationFrame(frame);
}

startGame();
requestAnimationFrame(frame);

if (isTelegram()) {
  document.documentElement.classList.add('in-telegram');
}

// Ссылка-приглашение сразу ведёт в комнату друга.
const invitedRoom = roomFromLocation();
if (invitedRoom) void startDuel(invitedRoom);
void refreshProfile();

// Уход со страницы во время матча — техническое поражение, а не зависший матч.
addEventListener('beforeunload', () => {
  if (inDuel) duel.close();
});

// Read-only доступ к состоянию для e2e-тестов и отладки в консоли.
declare global {
  interface Window {
    __doton?: { session: () => Session; chain: () => Cell[] };
  }
}
window.__doton = { session: () => session, chain: () => input.chain };
