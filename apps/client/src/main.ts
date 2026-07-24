import { DEFAULT_CONFIG, type Cell } from '@doton/core';
import { ChainInput } from './game/input';
import { Renderer } from './game/renderer';
import { Session, SPRINT_SECONDS, type Mode } from './game/session';
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
const finalScoreEl = el<HTMLSpanElement>('final-score');
const phaseEl = el<HTMLDivElement>('phase');
const phaseTextEl = el<HTMLSpanElement>('phase-text');
const boardWrap = canvas.parentElement as HTMLElement;

// ---------- Состояние ----------

let themeName = loadThemeName();
let theme: Theme = applyTheme(themeName);
let mode: Mode = 'sprint';
let session = newSession();
const renderer = new Renderer(canvas, DEFAULT_CONFIG, theme);

function newSession(): Session {
  const seed = Math.floor(Math.random() * 0xffffffff);
  return new Session(seed, mode, DEFAULT_CONFIG);
}

function startGame(): void {
  session = newSession();
  renderer.resetAnims();
  overlay.hidden = true;
  seedEl.textContent = `#${session.seed.toString(16)}`;
  updateHud();
}

function updateHud(): void {
  scoreEl.textContent = String(session.score);
  if (session.mode === 'sprint') {
    const total = Math.ceil(session.timeLeft);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    timeEl.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
    timeFill.style.width = `${(session.timeLeft / SPRINT_SECONDS) * 100}%`;
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
  let bannerClass: string;

  if (!session.cfg.features.phases) {
    html = '&nbsp;';
    bannerClass = '';
  } else if (active !== null) {
    const color = theme.dots[active]!;
    html = `<span class="swatch" style="--swatch:#fff"></span> Нагрузка сети ×${session.cfg.phaseMultiplier} — ${Math.ceil(remaining)} с`;
    bannerClass = 'active';
    phaseEl.style.setProperty('--phase-bg', color);
  } else if (nextIn <= 5) {
    const color = theme.dots[nextColor]!;
    html = `<span class="swatch" style="--swatch:${color}"></span> Нагрузка через ${Math.ceil(nextIn)} с`;
    bannerClass = '';
  } else {
    html = 'Сеть стабильна';
    bannerClass = '';
  }

  const cacheKey = bannerClass + html;
  if (cacheKey === phaseBannerCache) return;
  phaseBannerCache = cacheKey;
  phaseTextEl.innerHTML = html;
  phaseEl.className = `phase ${bannerClass}`;
}

// ---------- Ходы ----------

function showFloatingPoints(points: number, phased: boolean, at: { x: number; y: number }): void {
  const label = document.createElement('span');
  label.className = 'float-label';
  label.textContent = phased ? `+${points} В ×${session.cfg.phaseMultiplier}` : `+${points} В`;
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
    const result = session.tryMove(path);
    if (typeof result === 'string') return;
    renderer.animateMove(oldGrid, result);
    showFloatingPoints(result.points, result.phased, at);
    updateHud();
  },
  () => {
    if (navigator.vibrate) navigator.vibrate(4);
  },
);

// ---------- Управление ----------

el<HTMLButtonElement>('theme-toggle').addEventListener('click', () => {
  themeName = themeName === 'draft' ? 'graphite' : 'draft';
  theme = applyTheme(themeName);
  renderer.setTheme(THEMES[themeName]);
});

const sprintBtn = el<HTMLButtonElement>('mode-sprint');
const freeBtn = el<HTMLButtonElement>('mode-free');

function setMode(next: Mode): void {
  mode = next;
  sprintBtn.classList.toggle('active', next === 'sprint');
  freeBtn.classList.toggle('active', next === 'free');
  startGame();
}

sprintBtn.addEventListener('click', () => setMode('sprint'));
freeBtn.addEventListener('click', () => setMode('free'));
el<HTMLButtonElement>('new-board').addEventListener('click', startGame);
el<HTMLButtonElement>('restart').addEventListener('click', startGame);

new ResizeObserver(() => renderer.resize()).observe(canvas);

// ---------- Игровой цикл ----------

let lastTime = performance.now();
function frame(now: number): void {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (session.tick(dt)) {
    finalScoreEl.textContent = String(session.score);
    overlay.hidden = false;
  }
  if (session.mode === 'sprint' && !session.over) updateHud();
  updatePhaseBanner();

  renderer.draw(dt, session.board.grid, input.chain, input.pointer, session.phase().active);
  requestAnimationFrame(frame);
}

startGame();
requestAnimationFrame(frame);

// Read-only доступ к состоянию для e2e-тестов и отладки в консоли.
declare global {
  interface Window {
    __doton?: { session: () => Session };
  }
}
window.__doton = { session: () => session };
