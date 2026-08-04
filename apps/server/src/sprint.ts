import {
  applyMove,
  createBoard,
  phaseColorAt,
  seedRng,
  DEFAULT_CONFIG,
  type Board,
} from '@doton/core';
import type { MoveLog } from '@doton/protocol';

/** Длительность спринта, сек. */
export const SPRINT_SECONDS = 180;

/** Минимальный интервал между ходами: человек физически не жмёт чаще. */
const MIN_MOVE_GAP = 0.1;

export type ReplayError =
  | 'bad-timing'
  | 'invalid-move'
  | 'too-long';

/**
 * Прогоняет присланный лог ходов через ядро и возвращает честный счёт.
 * Клиентскому счёту сервер не верит никогда: в таблицу спринта идёт
 * только то, что насчитало ядро на присланных ходах.
 */
export function replaySprint(seed: number, moves: MoveLog[]): { score: number } | ReplayError {
  const cfg = DEFAULT_CONFIG;
  let board: Board = createBoard(seedRng(seed), cfg);
  let score = 0;
  let prevT = -Infinity;

  for (const move of moves) {
    if (move.t > SPRINT_SECONDS) return 'too-long';
    if (move.t < prevT + MIN_MOVE_GAP) return 'bad-timing';
    prevT = move.t;

    const phase = phaseColorAt(seed, move.t, cfg);
    const result = applyMove(board, move.path, cfg, phase);
    if (typeof result === 'string') return 'invalid-move';
    board = result.board;
    score += result.points;
  }

  return { score };
}
