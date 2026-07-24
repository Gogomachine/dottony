/** Цвет точки: индекс в палитре темы, сами цвета — дело клиента. */
export type Color = 0 | 1 | 2 | 3;

export interface Cell {
  r: number;
  c: number;
}

/** Обычная точка; charged — несёт заряд перегрузки (взрыв 3×3 при сборе). */
export interface DotCell {
  kind: 'dot';
  color: Color;
  charged: boolean;
}

/** Изолятор: занимает клетку, в цепочки не входит, выжигается уроном рядом. */
export interface InsulatorCell {
  kind: 'insulator';
  hp: number;
}

export type CellContent = DotCell | InsulatorCell;

/** Поле ROWS×COLS, grid[r][c] — содержимое клетки. */
export type Grid = CellContent[][];

/**
 * Состояние генератора случайных чисел — явное и сериализуемое,
 * чтобы клиент и сервер могли воспроизводить одну и ту же партию по сиду.
 */
export type RngState = number;

export interface Board {
  grid: Grid;
  rng: RngState;
  /** Номер следующего хода (с нуля) — задаёт ритм спавна изоляторов. */
  moveCount: number;
}

export interface FeatureFlags {
  /** Изоляторы: блоки, занимающие клетки. */
  insulators: boolean;
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
  /** Изолятор появляется каждый N-й ход. */
  insulatorEveryMoves: number;
  /** Прочность нового изолятора (цепочка рядом снимает 1 за ход). */
  insulatorHp: number;
  /** Больше изоляторов на поле одновременно не появляется. */
  insulatorMax: number;
  /** Очки за выжженный изолятор. */
  insulatorBonus: number;
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
  features: { insulators: true, phases: true, surge: true },
  insulatorEveryMoves: 6,
  insulatorHp: 2,
  insulatorMax: 6,
  insulatorBonus: 50,
  surgeChainLength: 10,
  surgeDotValue: 10,
  phasePeriod: 20,
  phaseDuration: 8,
  phaseMultiplier: 2,
};

export interface MoveResult {
  board: Board;
  /** Точки цепочки в порядке пути. */
  removed: Cell[];
  /** Точки, снятые взрывом перегрузки. */
  exploded: Cell[];
  /** Изоляторы, получившие урон, но уцелевшие. */
  damaged: Cell[];
  /** Выжженные изоляторы. */
  destroyed: Cell[];
  /** Куда лёг новый заряд перегрузки (после падения), если лёг. */
  charged: Cell | null;
  points: number;
  color: Color;
  /** Сработал множитель фазы. */
  phased: boolean;
}

export type MoveError =
  | 'too-short'
  | 'out-of-bounds'
  | 'not-adjacent'
  | 'color-mismatch'
  | 'revisit';
