import {
  applyMove,
  createBoard,
  phaseColorAt,
  seedRng,
  DEFAULT_CONFIG,
  type Board,
} from '@doton/core';
import type { ComboMove } from '@doton/protocol';

/** Минимальный интервал между ходами: человек физически не жмёт чаще. */
const MIN_MOVE_GAP = 0.1;

export type ComboError = 'bad-timing' | 'invalid-move';

/**
 * Переигрывает заход бесконечного режима и возвращает наибольшее
 * увеличение, которого игрок добился.
 *
 * Комбо — это серия линз подряд, а она зависит от состояния поля, поэтому
 * проверить рекорд можно только переиграв заход целиком от сида. Числу
 * клиента сервер не верит вовсе: в таблицу идёт то, что насчитало ядро на
 * присланных ходах.
 */
export function replayCombo(seed: number, moves: ComboMove[]): { combo: number } | ComboError {
  const cfg = DEFAULT_CONFIG;
  let board: Board = createBoard(seedRng(seed), cfg);
  let prevT = -Infinity;
  // Увеличение без линз — ×1: заход без единой линзы даёт именно его.
  let combo = 1;

  for (const move of moves) {
    if (move.t < prevT + MIN_MOVE_GAP) return 'bad-timing';
    prevT = move.t;

    const result = applyMove(board, move.path, cfg, phaseColorAt(seed, move.t, cfg));
    if (typeof result === 'string') return 'invalid-move';
    board = result.board;
    combo = Math.max(combo, result.streak + 1);
  }

  return { combo };
}
