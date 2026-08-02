/** Цвет точки: индекс в палитре темы, сами цвета — дело клиента. */
export type Color = 0 | 1 | 2 | 3;

export interface Cell {
  r: number;
  c: number;
}

/** Точка поля; charged — несёт заряд перегрузки (взрыв 3×3 при сборе). */
export interface DotCell {
  color: Color;
  charged: boolean;
}

/** Поле ROWS×COLS, grid[r][c] — точка. */
export type Grid = DotCell[][];

/**
 * Состояние генератора случайных чисел — явное и сериализуемое,
 * чтобы клиент и сервер могли воспроизводить одну и ту же партию по сиду.
 */
export type RngState = number;

export interface Board {
  grid: Grid;
  rng: RngState;
  /** Номер следующего хода (с нуля). */
  moveCount: number;
  /**
   * Сколько зарядов собрано подряд: каждый следующий поднимает множитель
   * очков (1 заряд — ×2, 2 — ×3, …). Цепочка без заряда обнуляет серию.
   */
  surgeStreak: number;
}

export interface FeatureFlags {
  /** Нагрузка сети: периодические цветовые фазы с множителем очков. */
  phases: boolean;
  /** Перегрузка: длинная цепочка оставляет заряд, взрывающий 3×3. */
  surge: boolean;
}

export interface GameConfig {
  rows: number;
  cols: number;
  colors: number;
  /** Минимальная длина цепочки. */
  minChain: number;
  /** Очки за n-ю точку цепочки: chainStep * (n - 1). */
  chainStep: number;
  features: FeatureFlags;
  /** Цепочка от N точек оставляет заряд перегрузки. */
  surgeChainLength: number;
  /** Очки за точку, снятую взрывом перегрузки. */
  surgeDotValue: number;
  /** Длина цикла фаз, сек. */
  phasePeriod: number;
  /** Фаза активна первые N секунд цикла. */
  phaseDuration: number;
  /** Множитель очков цепочки цвета фазы. */
  phaseMultiplier: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  rows: 6,
  cols: 6,
  colors: 4,
  minChain: 3,
  chainStep: 10,
  features: { phases: true, surge: true },
  surgeChainLength: 10,
  surgeDotValue: 10,
  phasePeriod: 45,
  phaseDuration: 8,
  phaseMultiplier: 2,
};

/**
 * Челлендж бесконечного режима: цепочка такой длины продлевает комбо на
 * один следующий ход — его отсчёты складываются с отсчётами этой цепочки.
 *
 * Правил игры это не меняет, только счёт челленджа, поэтому живёт рядом с
 * конфигом, а не в нём: и клиент, и сервер должны считать по одному числу.
 */
export const COMBO_CARRY_CHAIN = 25;

export interface MoveResult {
  board: Board;
  /** Точки цепочки в порядке пути. */
  removed: Cell[];
  /** Точки, снятые взрывом перегрузки. */
  exploded: Cell[];
  /** Куда лёг новый заряд перегрузки (после падения), если лёг. */
  charged: Cell | null;
  points: number;
  color: Color;
  /** Сработал множитель фазы. */
  phased: boolean;
  /** Сколько зарядов сработало в этом ходу. */
  surges: number;
  /** Итоговый множитель хода: фаза × серия зарядов. */
  multiplier: number;
  /** Серия зарядов после хода (0 — оборвалась). */
  streak: number;
}

export type MoveError =
  | 'too-short'
  | 'out-of-bounds'
  | 'not-adjacent'
  | 'color-mismatch'
  | 'revisit';
