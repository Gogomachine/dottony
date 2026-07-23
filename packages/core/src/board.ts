import { nextInt } from './rng.js';
import type { Board, Cell, Color, GameConfig, Grid, RngState } from './types.js';

/** Новое поле, целиком высыпанное из сида. Заполнение — по строкам сверху вниз. */
export function createBoard(seed: RngState, cfg: GameConfig): Board {
  let rng = seed;
  const grid: Grid = [];
  for (let r = 0; r < cfg.rows; r++) {
    const row: Color[] = [];
    for (let c = 0; c < cfg.cols; c++) {
      const roll = nextInt(rng, cfg.colors);
      row.push(roll.value as Color);
      rng = roll.state;
    }
    grid.push(row);
  }
  return { grid, rng };
}

export function cellAt(grid: Grid, cell: Cell): Color | undefined {
  return grid[cell.r]?.[cell.c];
}

/**
 * Убирает точки, роняет столбцы вниз и досыпает новые сверху из RNG.
 * Досыпка идёт по столбцам слева направо, в столбце — сверху вниз:
 * порядок зафиксирован, менять нельзя — сломается совместимость реплеев.
 */
export function collapse(board: Board, removed: Cell[], cfg: GameConfig): Board {
  const gone: boolean[][] = Array.from({ length: cfg.rows }, () =>
    Array<boolean>(cfg.cols).fill(false),
  );
  for (const cell of removed) {
    gone[cell.r]![cell.c] = true;
  }

  const grid: Grid = Array.from({ length: cfg.rows }, () => Array<Color>(cfg.cols).fill(0));
  let rng = board.rng;

  for (let c = 0; c < cfg.cols; c++) {
    // Уцелевшие точки столбца, сверху вниз.
    const survivors: Color[] = [];
    for (let r = 0; r < cfg.rows; r++) {
      if (!gone[r]![c]) survivors.push(board.grid[r]![c]!);
    }
    const missing = cfg.rows - survivors.length;
    for (let r = 0; r < missing; r++) {
      const roll = nextInt(rng, cfg.colors);
      grid[r]![c] = roll.value as Color;
      rng = roll.state;
    }
    for (let i = 0; i < survivors.length; i++) {
      grid[missing + i]![c] = survivors[i]!;
    }
  }

  return { grid, rng };
}

/** Все точки цвета color — порядок скана: по строкам, затем по столбцам. */
export function cellsOfColor(grid: Grid, color: Color): Cell[] {
  const cells: Cell[] = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]!;
    for (let c = 0; c < row.length; c++) {
      if (row[c] === color) cells.push({ r, c });
    }
  }
  return cells;
}
