import {
  applyMove,
  claimFrom,
  createBoard,
  longestChain,
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

/** Счёт захода и то, чем он себя выдаёт. */
export interface SprintReplay {
  score: number;
  /**
   * Острота: средняя доля от самой длинной цепочки, которая была на поле в
   * миг хода. Человек до лучшего почти не дотягивается, перебор берёт его
   * всегда — по этому и видно руку (см. `judge.ts` ядра).
   */
  sharp: number;
  /** Сколько ходов сыграно: на коротком заходе судить не о чем. */
  moves: number;
}

/**
 * Прогоняет присланный лог ходов через ядро и возвращает честный счёт.
 * Клиентскому счёту сервер не верит никогда: в таблицу спринта идёт
 * только то, что насчитало ядро на присланных ходах.
 *
 * Заодно меряет остроту: поле для этого уже развёрнуто, и второй раз
 * переигрывать заход было бы вдвое дороже на ровном месте.
 */
export function replaySprint(seed: number, moves: MoveLog[]): SprintReplay | ReplayError {
  const cfg = DEFAULT_CONFIG;
  let board: Board = createBoard(seedRng(seed), cfg);
  let score = 0;
  let prevT = -Infinity;
  // Заявки на цвет: в одиночном заходе их подаёт сам игрок, поэтому цвет
  // фазы восстанавливается из журнала ходов ровно как на клиенте.
  const claims: Claim[] = [];

  // Сумма долей «сыграно к доступному»: из неё получается острота.
  let sharpSum = 0;

  for (const move of moves) {
    if (move.t > SPRINT_SECONDS) return 'too-long';
    if (move.t < prevT + MIN_MOVE_GAP) return 'bad-timing';
    prevT = move.t;

    // Мерим до хода: важно, что было доступно, когда игрок выбирал.
    // Доля больше единицы означает, что перебор упёрся в свой потолок, —
    // такой ход считаем просто лучшим.
    const top = longestChain(board, cfg);
    if (top > 0) sharpSum += Math.min(1, move.path.length / top);

    const phase = phaseColorAt(seed, move.t, cfg, claims);
    const result = applyMove(board, move.path, cfg, phase);
    if (typeof result === 'string') return 'invalid-move';
    board = result.board;
    score += result.points;
    const claim = claimFrom(result.color, move.path.length, move.t, cfg);
    if (claim) claims.push(claim);
  }

  return { score, sharp: moves.length > 0 ? sharpSum / moves.length : 0, moves: moves.length };
}
