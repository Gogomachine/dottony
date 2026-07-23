import type { RngState } from './types.js';

/**
 * Детерминированный PRNG (mulberry32) с явным состоянием.
 * Одинаковый сид даёт одинаковую последовательность на любой платформе —
 * фундамент честных дуэлей и реплеев.
 */

export function seedRng(seed: number): RngState {
  return seed >>> 0;
}

function step(state: RngState): { value: number; state: RngState } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: next };
}

/** Целое из [0, bound). */
export function nextInt(state: RngState, bound: number): { value: number; state: RngState } {
  const r = step(state);
  return { value: Math.floor(r.value * bound), state: r.state };
}
