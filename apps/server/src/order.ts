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
): { score: number; orders: number; streak: number; biggest: number } | OrderError {
  const cfg = DEFAULT_CONFIG;
  let run: OrderRun = startOrder(seed, cfg);
  let prevT = -Infinity;
  // Лучшее в заходе, а не итоговое: за это выдаются отметки, и серия к
  // концу захода всегда оборвана — иначе заход бы не кончился.
  let streak = 0;
  let biggest = 0;

  for (const move of moves) {
    if (move.t < prevT + MIN_MOVE_GAP) return 'bad-timing';
    prevT = move.t;

    run = tickOrder(run, move.t, cfg);
    if (run.over) break;

    const out = tapOrder(run, move.cell, move.t, cfg);
    if (typeof out === 'string') return 'invalid-move';
    run = out.run;
    streak = Math.max(streak, run.streak);
    if (out.fire !== null && out.fire.reward > 0) biggest = Math.max(biggest, out.fire.size);
  }

  return { score: run.score, orders: run.orders, streak, biggest };
}

/**
 * Темп записанного захода: в какие секунды он приносил очки. Из этого
 * получается призрак для дуэли на заказах — соперник, который «закрывает
 * заказы» тогда же, когда их закрыл живой игрок.
 *
 * Ходы переигрываются ядром, а не берутся на веру: в темп попадает только
 * то, что заход действительно набрал.
 */
export function orderTempo(seed: number, moves: OrderMove[]): { t: number; points: number }[] {
  const cfg = DEFAULT_CONFIG;
  let run: OrderRun = startOrder(seed, cfg);
  const tempo: { t: number; points: number }[] = [];
  let prevT = -Infinity;

  for (const move of moves) {
    if (move.t < prevT + MIN_MOVE_GAP) break;
    prevT = move.t;
    run = tickOrder(run, move.t, cfg);
    if (run.over) break;
    const out = tapOrder(run, move.cell, move.t, cfg);
    if (typeof out === 'string') break;
    const points = out.run.score - run.score;
    run = out.run;
    if (points > 0) tempo.push({ t: Number(move.t.toFixed(2)), points });
  }
  return tempo;
}
