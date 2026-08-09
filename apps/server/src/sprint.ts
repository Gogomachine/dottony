import {
  applyMove,
  claimFrom,
  createBoard,
  phaseColorAt,
  seedRng,
  DEFAULT_CONFIG,
  SPRINT_SECONDS,
  type Board,
  type Claim,
} from '@doton/core';
import type { MoveLog } from '@doton/protocol';
import { MIN_MOVE_GAP } from './limits.js';


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
  // Заявки на цвет: в одиночном заходе их подаёт сам игрок, поэтому цвет
  // фазы восстанавливается из журнала ходов ровно как на клиенте.
  const claims: Claim[] = [];

  for (const move of moves) {
    if (move.t > SPRINT_SECONDS) return 'too-long';
    if (move.t < prevT + MIN_MOVE_GAP) return 'bad-timing';
    prevT = move.t;

    const phase = phaseColorAt(seed, move.t, cfg, claims);
    const result = applyMove(board, move.path, cfg, phase);
    if (typeof result === 'string') return 'invalid-move';
    board = result.board;
    score += result.points;
    const claim = claimFrom(result.color, move.path.length, move.t, cfg);
    if (claim) claims.push(claim);
  }

  return { score };
}
