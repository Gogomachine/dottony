import { nextInt, seedRng } from './rng.js';
import type { Color, GameConfig } from './types.js';

/**
 * «Нагрузка сети»: в начале каждого цикла phasePeriod на phaseDuration секунд
 * объявляется цвет-фаза, цепочки этого цвета дают ×phaseMultiplier.
 * Первый цикл (t < phasePeriod) — разминка без фазы.
 *
 * Цвет фазы берётся из сида — но только если его никто не заявил. Заявка
 * (claim) собирается в окне перед фазой и цвет перебивает; в дуэли она
 * красит фазу обоим игрокам. Всё остаётся чистой функцией: цвет выводится
 * из сида, номера цикла и списка заявок, поэтому и клиент, и сервер, и
 * реплей приходят к одному ответу.
 */

export interface PhaseState {
  /** Активный цвет фазы или null. */
  active: Color | null;
  /** Сколько секунд фаза ещё длится (0, если не активна). */
  remaining: number;
  /** Цвет следующей фазы — с учётом уже поданных заявок. */
  nextColor: Color;
  /** Через сколько секунд она начнётся. */
  nextIn: number;
}

/**
 * Заявка на цвет: цепочка, собранная в окне перед фазой. Меряются заявки
 * длиной цепочки, а не временем подачи, — иначе побеждал бы тот, кто
 * быстрее сыплет тройками.
 */
export interface Claim {
  /** Цикл, чью фазу красит заявка. */
  cycle: number;
  color: Color;
  /** Длина цепочки. */
  length: number;
  /** Секунда заявки: при равной длине побеждает ранняя. */
  t: number;
}

/** Окно заявки — последние claimWindow секунд цикла перед фазой. */
export interface ClaimWindow {
  /** Цикл, чью фазу решает окно. */
  cycle: number;
  open: boolean;
  /** Сколько секунд окна осталось; 0, если оно закрыто. */
  remaining: number;
}

function phaseColorFor(seed: number, cycle: number, cfg: GameConfig): Color {
  const roll = nextInt(seedRng((seed ^ Math.imul(cycle, 0x9e3779b9)) >>> 0), cfg.colors);
  return roll.value as Color;
}

export function claimWindowAt(timeSec: number, cfg: GameConfig): ClaimWindow {
  const cycle = Math.floor(timeSec / cfg.phasePeriod);
  const untilNext = (cycle + 1) * cfg.phasePeriod - timeSec;
  const open = cfg.features.phases && cfg.features.claim && untilNext <= cfg.claimWindow;
  return { cycle: cycle + 1, open, remaining: open ? untilNext : 0 };
}

/** Ход становится заявкой, если попал в окно и цепочка достаточно длинная. */
export function claimFrom(
  color: Color,
  length: number,
  timeSec: number,
  cfg: GameConfig,
): Claim | null {
  const window = claimWindowAt(timeSec, cfg);
  if (!window.open || length < cfg.claimChainLength) return null;
  return { cycle: window.cycle, color, length, t: timeSec };
}

/**
 * Победившая заявка цикла: длиннее, при равной длине — ранняя.
 * Тип заявки обобщён: вызывающая сторона может носить в ней и своё поле
 * (чья заявка), а правило от этого не зависит.
 */
export function bestClaim<T extends Claim>(claims: readonly T[], cycle: number): T | null {
  let best: T | null = null;
  for (const claim of claims) {
    if (claim.cycle !== cycle) continue;
    if (best === null || claim.length > best.length) {
      best = claim;
      continue;
    }
    if (claim.length === best.length && claim.t < best.t) best = claim;
  }
  return best;
}

/** Цвет фазы цикла: заявка, если она есть, иначе сид. */
function colorOfCycle(
  seed: number,
  cycle: number,
  cfg: GameConfig,
  claims: readonly Claim[],
): Color {
  const won = cfg.features.claim ? bestClaim(claims, cycle) : null;
  return won === null ? phaseColorFor(seed, cycle, cfg) : won.color;
}

export function phaseColorAt(
  seed: number,
  timeSec: number,
  cfg: GameConfig,
  claims: readonly Claim[] = [],
): Color | null {
  if (!cfg.features.phases || timeSec < cfg.phasePeriod) return null;
  const cycle = Math.floor(timeSec / cfg.phasePeriod);
  const within = timeSec - cycle * cfg.phasePeriod;
  if (within >= cfg.phaseDuration) return null;
  return colorOfCycle(seed, cycle, cfg, claims);
}

export function phaseStateAt(
  seed: number,
  timeSec: number,
  cfg: GameConfig,
  claims: readonly Claim[] = [],
): PhaseState {
  const cycle = Math.floor(timeSec / cfg.phasePeriod);
  const within = timeSec - cycle * cfg.phasePeriod;
  const active = phaseColorAt(seed, timeSec, cfg, claims);
  const nextCycle = Math.max(cycle + 1, 1);
  return {
    active,
    remaining: active === null ? 0 : cfg.phaseDuration - within,
    nextColor: colorOfCycle(seed, nextCycle, cfg, claims),
    nextIn: nextCycle * cfg.phasePeriod - timeSec,
  };
}
