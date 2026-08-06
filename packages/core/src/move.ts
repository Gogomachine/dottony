import { cellAt, collapse } from './board.js';
import type { Board, Cell, Color, GameConfig, MoveError, MoveResult } from './types.js';

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
 * соседние точки одного цвета, без повторов, не короче минимума.
 */
export function validatePath(board: Board, path: Cell[], cfg: GameConfig): Cell[] | MoveError {
  if (path.length === 0) return 'too-short';

  const first = cellAt(board.grid, path[0]!);
  if (first === undefined) return 'out-of-bounds';
  // Цвет цепочки задаёт первая точка — и только она. С бомбы не начинают:
  // цвета у неё нет, и продолжать было бы нечем.
  if (cfg.features.wildBomb && first.charged) return 'bomb-start';
  const color = first.color;

  const seen = new Set<string>([cellKey(path[0]!)]);

  for (let i = 1; i < path.length; i++) {
    const cell = path[i]!;
    const content = cellAt(board.grid, cell);
    if (content === undefined) return 'out-of-bounds';
    // Бомба входит в цепочку любого цвета, но цвет цепочки остаётся
    // прежним: перескочить через неё на другой цвет нельзя.
    const wild = cfg.features.wildBomb && content.charged;
    if (!wild && content.color !== color) return 'color-mismatch';
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

function neighborhood(center: Cell, cfg: GameConfig): Cell[] {
  const cells: Cell[] = [];
  for (let r = center.r - 1; r <= center.r + 1; r++) {
    for (let c = center.c - 1; c <= center.c + 1; c++) {
      if (r < 0 || r >= cfg.rows || c < 0 || c >= cfg.cols) continue;
      if (r === center.r && c === center.c) continue;
      cells.push({ r, c });
    }
  }
  return cells;
}

/**
 * Применяет ход к полю. Помимо цепочки:
 * - перегрузка: заряженные точки в цепочке взрывают 3×3 вокруг себя;
 * - цепочка от surgeChainLength точек оставляет заряд на месте последней точки;
 * - phaseColor — активная фаза «нагрузки сети»: цепочка её цвета даёт ×множитель.
 * Единственная точка входа для клиента и сервера — гарантия одинакового счёта.
 */
export function applyMove(
  board: Board,
  path: Cell[],
  cfg: GameConfig,
  phaseColor: Color | null = null,
): MoveResult | MoveError {
  const validated = validatePath(board, path, cfg);
  if (typeof validated === 'string') return validated;

  const color = cellAt(board.grid, path[0]!)!.color;
  const removedSet = new Set(validated.map(cellKey));

  // Взрывы перегрузки: 3×3 вокруг каждой заряженной точки цепочки.
  const exploded: Cell[] = [];
  let surges = 0;
  if (cfg.features.surge) {
    for (const cell of validated) {
      if (!cellAt(board.grid, cell)!.charged) continue;
      surges++;
      for (const near of neighborhood(cell, cfg)) {
        if (!removedSet.has(cellKey(near))) {
          removedSet.add(cellKey(near));
          exploded.push(near);
        }
      }
    }
  }

  /**
   * Серия зарядов: каждый собранный подряд заряд поднимает множитель
   * на единицу (первый — ×2, второй — ×3…). Ход без заряда её обрывает,
   * поэтому выгодно планировать цепочки так, чтобы заряды шли один за другим.
   */
  const streak = surges > 0 ? board.surgeStreak + surges : 0;
  const surgeMultiplier = streak > 0 ? streak + 1 : 1;

  const phased = cfg.features.phases && phaseColor !== null && phaseColor === color;
  const multiplier = (phased ? cfg.phaseMultiplier : 1) * surgeMultiplier;
  const points =
    (chainPoints(validated.length, cfg) + exploded.length * cfg.surgeDotValue) * multiplier;

  const allRemoved = [...validated, ...exploded];
  const collapsed = collapse(board, allRemoved, cfg);

  // Заряд перегрузки ложится туда, где кончилась длинная цепочка.
  let charged: Cell | null = null;
  if (cfg.features.surge && validated.length >= cfg.surgeChainLength) {
    const target = validated[validated.length - 1]!;
    collapsed.grid[target.r]![target.c]!.charged = true;
    charged = target;
  }

  return {
    board: {
      grid: collapsed.grid,
      rng: collapsed.rng,
      moveCount: board.moveCount + 1,
      surgeStreak: streak,
    },
    removed: validated,
    exploded,
    charged,
    points,
    color,
    phased,
    surges,
    multiplier,
    streak,
  };
}
