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
 * Переигрывает заход бесконечного режима и возвращает лучшие отсчёты за
 * один ход — цену самой дорогой цепочки захода.
 *
 * Цена хода зависит от состояния поля: и от длины цепочки, и от зарядов
 * под ней, и от серии линз с резонансом, которые её множат. Проверить
 * рекорд поэтому можно только переиграв заход целиком от сида. Числу
 * клиента сервер не верит вовсе: в таблицу идёт то, что насчитало ядро на
 * присланных ходах.
 */
export function replayCombo(seed: number, moves: ComboMove[]): { combo: number } | ComboError {
  const cfg = DEFAULT_CONFIG;
  let board: Board = createBoard(seedRng(seed), cfg);
  let prevT = -Infinity;
  let combo = 0;

  for (const move of moves) {
    if (move.t < prevT + MIN_MOVE_GAP) return 'bad-timing';
    prevT = move.t;

    const result = applyMove(board, move.path, cfg, phaseColorAt(seed, move.t, cfg));
    if (typeof result === 'string') return 'invalid-move';
    board = result.board;
    combo = Math.max(combo, result.points);
  }

  return { combo };
}
