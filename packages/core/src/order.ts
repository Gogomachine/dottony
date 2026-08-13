import { nextInt } from './rng.js';
import type { Color, GameConfig, MoveResult, RngState } from './types.js';

/**
 * Заказ: прибор просит снять ровно столько точек названного цвета.
 *
 * Смысл механики в слове «ровно». Точки снимаются группами, а размер
 * группы задаёт поле, а не игрок: под конец заказа остаётся взять четыре,
 * а на поле лежат шестёрки. Поэтому последние ходы — это работа на
 * будущее: разобрать чужие цвета так, чтобы нужная группа получилась
 * нужного размера. Перебор заказ срывает — в этом и интрига.
 *
 * Правило чистое и живёт в ядре: цвет заказа выводится из состояния RNG,
 * поэтому последовательность заказов воспроизводима по сиду, как и всё
 * остальное в игре.
 */

export interface Order {
  color: Color;
  /** Сколько точек этого цвета нужно снять — ровно столько. */
  target: number;
}

/**
 * Чем ход кончился для заказа:
 * - `idle` — ход был другого цвета, заказа не касается;
 * - `grows` — засчитан, до цели ещё есть чем добрать;
 * - `done` — набрано ровно, заказ закрыт;
 * - `over` — перебор, заказ сорван;
 * - `stuck` — недобор, которым уже не закрыться: остаток меньше цепочки,
 *   а группами меньше неё точки не снимаются.
 */
export type OrderStep = 'idle' | 'grows' | 'done' | 'over' | 'stuck';

export function nextOrder(rng: RngState, cfg: GameConfig): { order: Order; state: RngState } {
  const roll = nextInt(rng, cfg.colors);
  return {
    order: { color: roll.value as Color, target: cfg.orderTarget },
    state: roll.state,
  };
}

/**
 * Засчитывает ход в заказ. В счёт идут только точки самой группы: взрыв
 * заряда сносит что попало, и пускать его в заказ значило бы отдать
 * решающий ход лотерее.
 *
 * Заказ срывает не только перебор. Остаток меньше цепочки — тоже срыв:
 * группами короче `minChain` точки не снимаются, значит добрать нечем. Из
 * этого и растёт вся стратегия режима: оставляй себе или ровно ноль, или
 * не меньше цепочки.
 */
export function fillOrder(
  order: Order,
  taken: number,
  move: MoveResult,
  cfg: GameConfig,
): { taken: number; step: OrderStep } {
  if (move.color !== order.color) return { taken, step: 'idle' };

  const next = taken + move.removed.length;
  if (next === order.target) return { taken: next, step: 'done' };
  if (next > order.target) return { taken: next, step: 'over' };
  if (next > order.target - cfg.minChain) return { taken: next, step: 'stuck' };
  return { taken: next, step: 'grows' };
}
