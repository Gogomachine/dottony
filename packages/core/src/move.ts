import { cellAt, cellsOfColor, collapse } from './board.js';
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
 * Путь хода — последовательность клеток, по которым провёл игрок.
 * Кольцо: последняя клетка пути повторяет одну из предыдущих (петля замкнулась).
 * Все остальные клетки должны быть уникальны.
 */
export interface ValidatedPath {
  /** Уникальные клетки пути (для кольца — без замыкающего повтора). */
  cells: Cell[];
  ring: boolean;
}

export function validatePath(
  board: Board,
  path: Cell[],
  cfg: GameConfig,
): ValidatedPath | MoveError {
  if (path.length === 0) return 'too-short';

  const first = path[0]!;
  const color = cellAt(board.grid, first);
  if (color === undefined) return 'out-of-bounds';

  const seen = new Set<string>([cellKey(first)]);
  let ring = false;

  for (let i = 1; i < path.length; i++) {
    const cell = path[i]!;
    if (cellAt(board.grid, cell) === undefined) return 'out-of-bounds';
    if (cellAt(board.grid, cell) !== color) return 'color-mismatch';
    if (!areNeighbors(path[i - 1]!, cell)) return 'not-adjacent';

    if (seen.has(cellKey(cell))) {
      // Повтор допустим только как замыкание кольца — последним шагом пути.
      // (Повтор клетки подряд сюда не дойдёт: он падает на проверке соседства.)
      if (i !== path.length - 1) return 'revisit-without-ring';
      ring = true;
    } else {
      seen.add(cellKey(cell));
    }
  }

  const cells = ring ? path.slice(0, -1) : path;
  if (cells.length < cfg.minChain) return 'too-short';
  if (ring) {
    // Кольцо — настоящий цикл: от клетки замыкания до конца пути
    // минимум 4 уникальные точки (минимальное кольцо — квадрат 2×2).
    const closing = cellKey(path[path.length - 1]!);
    const idx = cells.findIndex((cell) => cellKey(cell) === closing);
    if (cells.length - idx < 4) return 'too-short';
  }

  return { cells, ring };
}

/** Очки за обычную цепочку длиной n: n-я точка стоит chainStep × (n − 1). */
export function chainPoints(length: number, cfg: GameConfig): number {
  return (cfg.chainStep * length * (length - 1)) / 2;
}

/**
 * Применяет ход к полю. Кольцо (короткое замыкание) снимает все точки цвета.
 * Единственная точка входа для клиента и сервера — гарантия одинакового счёта.
 */
export function applyMove(board: Board, path: Cell[], cfg: GameConfig): MoveResult | MoveError {
  const validated = validatePath(board, path, cfg);
  if (typeof validated === 'string') return validated;

  const color = cellAt(board.grid, path[0]!)!;
  const removed = validated.ring ? cellsOfColor(board.grid, color) : validated.cells;
  const points = validated.ring
    ? cfg.ringDotValue * removed.length
    : chainPoints(removed.length, cfg);

  return {
    board: collapse(board, removed, cfg),
    removed,
    points,
    ring: validated.ring,
    color,
  };
}
