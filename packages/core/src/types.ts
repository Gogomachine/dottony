/** Цвет точки: индекс в палитре темы, сами цвета — дело клиента. */
export type Color = 0 | 1 | 2 | 3;

export interface Cell {
  r: number;
  c: number;
}

/** Поле ROWS×COLS, grid[r][c] — цвет точки. */
export type Grid = Color[][];

/**
 * Состояние генератора случайных чисел — явное и сериализуемое,
 * чтобы клиент и сервер могли воспроизводить одну и ту же партию по сиду.
 */
export type RngState = number;

export interface Board {
  grid: Grid;
  rng: RngState;
}

export interface GameConfig {
  rows: number;
  cols: number;
  colors: number;
  /** Минимальная длина обычной цепочки. */
  minChain: number;
  /** Очки за n-ю точку цепочки: chainStep * (n - 1). */
  chainStep: number;
  /** Очки за каждую точку, снятую коротким замыканием (кольцом). */
  ringDotValue: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  rows: 6,
  cols: 6,
  colors: 4,
  minChain: 3,
  chainStep: 10,
  ringDotValue: 20,
};

export interface MoveResult {
  board: Board;
  /** Снятые с поля точки (в порядке: для цепочки — порядок пути, для кольца — скан поля). */
  removed: Cell[];
  points: number;
  /** Ход замкнул кольцо — короткое замыкание цвета. */
  ring: boolean;
  color: Color;
}

export type MoveError =
  | 'too-short'
  | 'out-of-bounds'
  | 'not-adjacent'
  | 'color-mismatch'
  | 'revisit-without-ring';
