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
  /**
   * Заявка цвета: цвет резонанса не выводится из сида, а достаётся тому,
   * чья цепочка в окне перед фазой оказалась длиннее. В дуэли заявка
   * красит фазу обоим — это единственное место, где действие соперника
   * видно на твоём приборе.
   *
   * Флаг — точка отката: выключенный возвращает прежний резонанс из сида
   * целиком, вместе с окном и его показом.
   */
  claim: boolean;
  /**
   * Ход одним касанием: игрок не ведёт палец по точкам, а нажимает на
   * одну, и снимается вся связная группа её цвета.
   *
   * Так играют заказы — и только они: там весь смысл в том, что размер
   * группы задаёт поле, а не игрок. Флаг меняет не баланс, а сам способ
   * играть, поэтому и живёт отдельно: одним значением переключаются и
   * ввод, и показ.
   */
  tap: boolean;
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
  /** Окно заявки — первые N секунд цикла; фаза идёт сразу за ним. */
  claimWindow: number;
  /** Цепочка от N точек в окне заявляет цвет. */
  claimChainLength: number;
  /** Сколько точек нужно снять одним касанием, чтобы закрыть заказ. */
  orderTarget: number;
  /** Награда за заказ ровно в цель; каждая точка сверх неё стоит столько же. */
  orderReward: number;
  /** Сколько длится окно заказа, сек. Окна идут подряд, без передышки. */
  orderWindow: number;
  /**
   * Сколько окон можно упустить за заход. Столько раз прибор простит
   * пустое окно — на следующем заход кончается.
   */
  orderLives: number;
  /**
   * Во сколько раз чаще прочих выпадает цвет заказа, пока окно открыто.
   * Это и делает цель достижимой: без притяжения пятно упирается в два
   * десятка точек и «ровно 25» превращается в лотерею расклада.
   */
  orderWeight: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  rows: 6,
  cols: 6,
  colors: 4,
  minChain: 3,
  chainStep: 10,
  features: { phases: true, surge: true, claim: true, tap: false },
  surgeChainLength: 10,
  surgeDotValue: 10,
  phasePeriod: 45,
  phaseDuration: 8,
  phaseMultiplier: 2,
  claimWindow: 8,
  claimChainLength: 5,
  orderTarget: 25,
  orderReward: 100,
  orderWindow: 18,
  orderLives: 3,
  orderWeight: 4,
};

/**
 * Длительность спринта, сек. Живёт здесь, а не у клиента: сервер по этому
 * же числу отсекает ходы, присланные «после конца» захода. Разъехались бы
 * копии — разъехались бы и правила приёма рекорда.
 */
export const SPRINT_SECONDS = 180;

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
