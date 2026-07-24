import { nextInt } from './rng.js';
import type {
  Board,
  Cell,
  CellContent,
  Color,
  DotCell,
  GameConfig,
  Grid,
  RngState,
} from './types.js';

export function dot(color: Color, charged = false): DotCell {
  return { kind: 'dot', color, charged };
}

/** Новое поле, целиком высыпанное из сида. Заполнение — по строкам сверху вниз. */
export function createBoard(seed: RngState, cfg: GameConfig): Board {
  let rng = seed;
  const grid: Grid = [];
  for (let r = 0; r < cfg.rows; r++) {
    const row: CellContent[] = [];
    for (let c = 0; c < cfg.cols; c++) {
      const roll = nextInt(rng, cfg.colors);
      row.push(dot(roll.value as Color));
      rng = roll.state;
    }
    grid.push(row);
  }
  return { grid, rng, moveCount: 0 };
}

export function cellAt(grid: Grid, cell: Cell): CellContent | undefined {
  return grid[cell.r]?.[cell.c];
}

export function countInsulators(grid: Grid): number {
  let count = 0;
  for (const row of grid) {
    for (const content of row) {
      if (content.kind === 'insulator') count++;
    }
  }
  return count;
}

export interface CollapseResult {
  grid: Grid;
  rng: RngState;
}

/**
 * Убирает клетки, роняет столбцы вниз (изоляторы падают вместе с точками)
 * и досыпает новые точки сверху из RNG.
 * Порядок обращений к RNG зафиксирован и менять его нельзя — сломается
 * совместимость реплеев: сначала выбор столбца для изолятора (если он
 * спавнится), затем досыпка по столбцам слева направо, сверху вниз.
 */
export function collapse(
  board: Board,
  removed: Cell[],
  cfg: GameConfig,
  spawnInsulator: boolean,
): CollapseResult {
  const gone: boolean[][] = Array.from({ length: cfg.rows }, () =>
    Array<boolean>(cfg.cols).fill(false),
  );
  for (const cell of removed) {
    gone[cell.r]![cell.c] = true;
  }

  const missingByCol: number[] = [];
  for (let c = 0; c < cfg.cols; c++) {
    let missing = 0;
    for (let r = 0; r < cfg.rows; r++) {
      if (gone[r]![c]) missing++;
    }
    missingByCol.push(missing);
  }

  let rng = board.rng;

  // Изолятор занимает верхний досыпаемый слот случайного столбца из тех, где есть досыпка.
  let insulatorCol = -1;
  if (spawnInsulator) {
    const refillCols = [];
    for (let c = 0; c < cfg.cols; c++) {
      if (missingByCol[c]! > 0) refillCols.push(c);
    }
    if (refillCols.length > 0) {
      const roll = nextInt(rng, refillCols.length);
      insulatorCol = refillCols[roll.value]!;
      rng = roll.state;
    }
  }

  const grid: Grid = Array.from({ length: cfg.rows }, () => Array<CellContent>(cfg.cols));

  for (let c = 0; c < cfg.cols; c++) {
    const survivors: CellContent[] = [];
    for (let r = 0; r < cfg.rows; r++) {
      if (!gone[r]![c]) survivors.push(board.grid[r]![c]!);
    }
    const missing = missingByCol[c]!;
    for (let r = 0; r < missing; r++) {
      if (c === insulatorCol && r === 0) {
        grid[r]![c] = { kind: 'insulator', hp: cfg.insulatorHp };
        continue;
      }
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
