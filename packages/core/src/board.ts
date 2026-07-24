import { nextInt } from './rng.js';
import type { Board, Cell, Color, DotCell, GameConfig, Grid, RngState } from './types.js';

export function dot(color: Color, charged = false): DotCell {
  return { color, charged };
}

/** Новое поле, целиком высыпанное из сида. Заполнение — по строкам сверху вниз. */
export function createBoard(seed: RngState, cfg: GameConfig): Board {
  let rng = seed;
  const grid: Grid = [];
  for (let r = 0; r < cfg.rows; r++) {
    const row: DotCell[] = [];
    for (let c = 0; c < cfg.cols; c++) {
      const roll = nextInt(rng, cfg.colors);
      row.push(dot(roll.value as Color));
      rng = roll.state;
    }
    grid.push(row);
  }
  return { grid, rng, moveCount: 0 };
}

export function cellAt(grid: Grid, cell: Cell): DotCell | undefined {
  return grid[cell.r]?.[cell.c];
}

export interface CollapseResult {
  grid: Grid;
  rng: RngState;
}

/**
 * Убирает точки, роняет столбцы вниз и досыпает новые сверху из RNG.
 * Порядок обращений к RNG зафиксирован и менять его нельзя — сломается
 * совместимость реплеев: по столбцам слева направо, в столбце сверху вниз.
 */
export function collapse(board: Board, removed: Cell[], cfg: GameConfig): CollapseResult {
  const gone: boolean[][] = Array.from({ length: cfg.rows }, () =>
    Array<boolean>(cfg.cols).fill(false),
  );
  for (const cell of removed) {
    gone[cell.r]![cell.c] = true;
  }

  const grid: Grid = Array.from({ length: cfg.rows }, () => Array<DotCell>(cfg.cols));
  let rng = board.rng;

  for (let c = 0; c < cfg.cols; c++) {
    const survivors: DotCell[] = [];
    for (let r = 0; r < cfg.rows; r++) {
      // Копия, а не ссылка: результат хода не должен разделять объекты
      // со старым полем (пометка заряда не имеет права мутировать прошлое).
      if (!gone[r]![c]) survivors.push({ ...board.grid[r]![c]! });
    }
    const missing = cfg.rows - survivors.length;
    for (let r = 0; r < missing; r++) {
      const roll = nextInt(rng, cfg.colors);
      grid[r]![c] = dot(roll.value as Color);
      rng = roll.state;
    }
    for (let i = 0; i < survivors.length; i++) {
      grid[missing + i]![c] = survivors[i]!;
    }
  }

  return { grid, rng };
}
