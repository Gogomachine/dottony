import type { Cell } from '@doton/core';
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
const boardWrap = canvas.parentElement as HTMLElement;

let themeName = loadThemeName();
let theme: Theme = applyTheme(themeName);
let mode: Mode = 'sprint';
let session = newSession();
const renderer = new Renderer(canvas, session.cfg, theme);

function newSession(): Session {
  const seed = Math.floor(Math.random() * 0xffffffff);
  return new Session(seed, mode);
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

function showFloatingPoints(points: number, at: { x: number; y: number }): void {
  const label = document.createElement('span');
  label.className = 'float-label';
  label.textContent = `+${points} В`;
  label.style.left = `${at.x}px`;
  label.style.top = `${at.y}px`;
  boardWrap.appendChild(label);
  setTimeout(() => label.remove(), 900);
}

const input = new ChainInput(
  canvas,
  renderer,
  () => session.board,
  session.cfg,
  (path: Cell[]) => {
    const oldGrid = session.board.grid;
    const at = input.pointer ?? renderer.center(path[path.length - 1]!);
    const result = session.tryMove(path);
    if (typeof result === 'string') return;
    renderer.animateMove(oldGrid, result);
    showFloatingPoints(result.points, at);
    updateHud();
  },
  () => {
    if (navigator.vibrate) navigator.vibrate(4);
  },
);

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

let lastTime = performance.now();
function frame(now: number): void {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (session.tick(dt)) {
    finalScoreEl.textContent = String(session.score);
    overlay.hidden = false;
  }
  if (session.mode === 'sprint' && !session.over) updateHud();

  renderer.draw(dt, session.board.grid, input.chain, input.pointer);
  requestAnimationFrame(frame);
}

startGame();
requestAnimationFrame(frame);
