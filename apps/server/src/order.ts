import { startOrder, tapOrder, tickOrder, DEFAULT_CONFIG, type OrderRun } from '@doton/core';
import type { OrderMove } from '@doton/protocol';
import { MIN_MOVE_GAP } from './limits.js';

export type OrderError = 'bad-timing' | 'invalid-move';

/**
 * Переигрывает заход режима заказов и возвращает его счёт.
 *
 * Считает то же ядро, что и клиент: окна, притянутый досыпкой цвет,
 * награду за заказ и запас сбоев. Числу клиента сервер не верит вовсе — в
 * таблицу идёт только то, что насчиталось на присланных ходах.
 *
 * Ходы после конца захода не ошибка, а расхождение на доли секунды у
 * границы окна: заход к этому моменту уже кончился, и считать в нём
 * нечего — просто останавливаемся.
 */
export function replayOrder(
  seed: number,
  moves: OrderMove[],
): { score: number; orders: number } | OrderError {
  const cfg = DEFAULT_CONFIG;
  let run: OrderRun = startOrder(seed, cfg);
  let prevT = -Infinity;

  for (const move of moves) {
    if (move.t < prevT + MIN_MOVE_GAP) return 'bad-timing';
    prevT = move.t;

    run = tickOrder(run, move.t, cfg);
    if (run.over) break;

    const out = tapOrder(run, move.cell, move.t, cfg);
    if (typeof out === 'string') return 'invalid-move';
    run = out.run;
  }

  return { score: run.score, orders: run.orders };
}
