import { cellAt, collapse } from './board.js';
import type { Board, Cell, GameConfig, MoveError, MoveResult } from './types.js';

/** Соседство по 8 направлениям. */
export function areNeighbors(a: Cell, b: Cell): boolean {
  const dr = Math.abs(a.r - b.r);
  const dc = Math.abs(a.c - b.c);
  return dr <= 1 && dc <= 1 && dr + dc > 0;
}

function cellKey(cell: Cell): string {
  return `${cell.r},${cell.c}`;
}

/**
 * Путь хода — последовательность клеток, по которым провёл игрок:
 * соседние, одного цвета, без повторов, не короче минимума.
 */
export function validatePath(board: Board, path: Cell[], cfg: GameConfig): Cell[] | MoveError {
  if (path.length === 0) return 'too-short';

  const first = path[0]!;
  const color = cellAt(board.grid, first);
  if (color === undefined) return 'out-of-bounds';

  const seen = new Set<string>([cellKey(first)]);

  for (let i = 1; i < path.length; i++) {
    const cell = path[i]!;
    if (cellAt(board.grid, cell) === undefined) return 'out-of-bounds';
    if (cellAt(board.grid, cell) !== color) return 'color-mismatch';
    if (!areNeighbors(path[i - 1]!, cell)) return 'not-adjacent';
    if (seen.has(cellKey(cell))) return 'revisit';
    seen.add(cellKey(cell));
  }

  if (path.length < cfg.minChain) return 'too-short';
  return path;
}

/** Очки за цепочку длиной n: n-я точка стоит chainStep × (n − 1). */
export function chainPoints(length: number, cfg: GameConfig): number {
  return (cfg.chainStep * length * (length - 1)) / 2;
}

/**
 * Применяет ход к полю.
 * Единственная точка входа для клиента и сервера — гарантия одинакового счёта.
 */
export function applyMove(board: Board, path: Cell[], cfg: GameConfig): MoveResult | MoveError {
  const validated = validatePath(board, path, cfg);
  if (typeof validated === 'string') return validated;

  const color = cellAt(board.grid, path[0]!)!;
  return {
    board: collapse(board, validated, cfg),
    removed: validated,
    points: chainPoints(validated.length, cfg),
    color,
  };
}
