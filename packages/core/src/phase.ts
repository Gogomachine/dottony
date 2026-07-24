import { nextInt, seedRng } from './rng.js';
import type { Color, GameConfig } from './types.js';

/**
 * «Нагрузка сети»: в начале каждого цикла phasePeriod на phaseDuration секунд
 * объявляется цвет-фаза, цепочки этого цвета дают ×phaseMultiplier.
 * Первый цикл (t < phasePeriod) — разминка без фазы.
 * Функция чистая: цвет фазы детерминирован сидом партии и номером цикла,
 * у обоих игроков дуэли фазы одинаковые.
 */

export interface PhaseState {
  /** Активный цвет фазы или null. */
  active: Color | null;
  /** Сколько секунд фаза ещё длится (0, если не активна). */
  remaining: number;
  /** Цвет следующей фазы. */
  nextColor: Color;
  /** Через сколько секунд она начнётся. */
  nextIn: number;
}

function phaseColorFor(seed: number, cycle: number, cfg: GameConfig): Color {
  const roll = nextInt(seedRng((seed ^ Math.imul(cycle, 0x9e3779b9)) >>> 0), cfg.colors);
  return roll.value as Color;
}

export function phaseColorAt(seed: number, timeSec: number, cfg: GameConfig): Color | null {
  if (!cfg.features.phases || timeSec < cfg.phasePeriod) return null;
  const cycle = Math.floor(timeSec / cfg.phasePeriod);
  const within = timeSec - cycle * cfg.phasePeriod;
  if (within >= cfg.phaseDuration) return null;
  return phaseColorFor(seed, cycle, cfg);
}

export function phaseStateAt(seed: number, timeSec: number, cfg: GameConfig): PhaseState {
  const cycle = Math.floor(timeSec / cfg.phasePeriod);
  const within = timeSec - cycle * cfg.phasePeriod;
  const active = phaseColorAt(seed, timeSec, cfg);
  const nextCycle = Math.max(cycle + 1, 1);
  return {
    active,
    remaining: active === null ? 0 : cfg.phaseDuration - within,
    nextColor: phaseColorFor(seed, nextCycle, cfg),
    nextIn: nextCycle * cfg.phasePeriod - timeSec,
  };
}
