import {
  applyMove,
  createBoard,
  longestChain,
  seedRng,
  PUZZLE_CONFIG,
  PUZZLE_MOVES,
  type Board,
} from '@doton/core';
import type { PuzzleMove } from '@doton/protocol';
import { MIN_MOVE_GAP } from './limits.js';
import type { ReplayError } from './sprint.js';

/**
 * Пересчёт захода пазла.
 *
 * Отличий от спринта два, и оба идут от того, что в пазле нет часов.
 *
 * Первое: кончается он ходами, а не секундами, — и потолок ходов проверяет
 * сервер, потому что «двадцать пять» это и есть вся игра. Второе: фаз и
 * заявки на цвет тут нет (см. `PUZZLE_CONFIG`), поэтому и восстанавливать
 * по журналу нечего — ход зависит только от поля.
 *
 * Секунды в журнале остаются и проверяются: в партии без часов они ни на
 * что не влияют, но по ним видно руку. Присланные двадцать пять ходов за
 * полсекунды — это не человек, кто бы их ни посчитал.
 */
export interface PuzzleReplay {
  score: number;
  /** Острота: средняя доля от лучшей цепочки на поле (см. `judge.ts` ядра). */
  sharp: number;
  moves: number;
}

export type PuzzleError = ReplayError | 'too-many';

export function replayPuzzle(seed: number, moves: PuzzleMove[]): PuzzleReplay | PuzzleError {
  if (moves.length > PUZZLE_MOVES) return 'too-many';
  const cfg = PUZZLE_CONFIG;
  let board: Board = createBoard(seedRng(seed), cfg);
  let score = 0;
  let prevT = -Infinity;
  let sharpSum = 0;

  for (const move of moves) {
    if (move.t < prevT + MIN_MOVE_GAP) return 'bad-timing';
    prevT = move.t;

    // Мерим до хода: важно, что было доступно, когда игрок выбирал.
    const top = longestChain(board, cfg);
    if (top > 0) sharpSum += Math.min(1, move.path.length / top);

    // Фазы выключены — цвет резонанса не спрашиваем вовсе.
    const result = applyMove(board, move.path, cfg, null);
    if (typeof result === 'string') return 'invalid-move';
    board = result.board;
    score += result.points;
  }

  return { score, sharp: moves.length > 0 ? sharpSum / moves.length : 0, moves: moves.length };
}
