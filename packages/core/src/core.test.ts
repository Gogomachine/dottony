import { describe, expect, it } from 'vitest';
import { cellsOfColor, collapse, createBoard } from './board.js';
import { applyMove, areNeighbors, chainPoints, validatePath } from './move.js';
import { nextInt, seedRng } from './rng.js';
import { DEFAULT_CONFIG, type Board, type Cell, type Color, type Grid } from './types.js';

const cfg = DEFAULT_CONFIG;

function boardFrom(rows: string[], rng = seedRng(1)): Board {
  const grid: Grid = rows.map((row) => [...row].map((ch) => Number(ch) as Color));
  return { grid, rng };
}

describe('rng', () => {
  it('одинаковый сид даёт одинаковую последовательность', () => {
    let a = seedRng(42);
    let b = seedRng(42);
    for (let i = 0; i < 100; i++) {
      const ra = nextInt(a, 4);
      const rb = nextInt(b, 4);
      expect(ra.value).toBe(rb.value);
      a = ra.state;
      b = rb.state;
    }
  });

  it('разные сиды дают разные последовательности', () => {
    const seq = (seed: number) => {
      let s = seedRng(seed);
      const out: number[] = [];
      for (let i = 0; i < 20; i++) {
        const r = nextInt(s, 4);
        out.push(r.value);
        s = r.state;
      }
      return out.join('');
    };
    expect(seq(1)).not.toBe(seq(2));
  });
});

describe('createBoard', () => {
  it('строит поле нужного размера с допустимыми цветами', () => {
    const board = createBoard(seedRng(7), cfg);
    expect(board.grid).toHaveLength(cfg.rows);
    for (const row of board.grid) {
      expect(row).toHaveLength(cfg.cols);
      for (const color of row) {
        expect(color).toBeGreaterThanOrEqual(0);
        expect(color).toBeLessThan(cfg.colors);
      }
    }
  });

  it('детерминировано по сиду', () => {
    expect(createBoard(seedRng(7), cfg)).toEqual(createBoard(seedRng(7), cfg));
    expect(createBoard(seedRng(7), cfg)).not.toEqual(createBoard(seedRng(8), cfg));
  });
});

describe('areNeighbors', () => {
  it('соседство по 8 направлениям, без совпадения клеток', () => {
    const center: Cell = { r: 2, c: 2 };
    expect(areNeighbors(center, { r: 1, c: 1 })).toBe(true);
    expect(areNeighbors(center, { r: 2, c: 3 })).toBe(true);
    expect(areNeighbors(center, { r: 3, c: 2 })).toBe(true);
    expect(areNeighbors(center, { r: 2, c: 2 })).toBe(false);
    expect(areNeighbors(center, { r: 0, c: 2 })).toBe(false);
  });
});

describe('validatePath', () => {
  const board = boardFrom([
    '001123',
    '010223',
    '001233',
    '112233',
    '112233',
    '112233',
  ]);

  it('принимает цепочку из трёх соседних точек одного цвета', () => {
    const path: Cell[] = [
      { r: 0, c: 0 },
      { r: 0, c: 1 },
      { r: 1, c: 0 },
    ];
    const result = validatePath(board, path, cfg);
    expect(result).toEqual({ cells: path, ring: false });
  });

  it('отклоняет цепочку короче минимума', () => {
    expect(
      validatePath(board, [{ r: 0, c: 0 }, { r: 0, c: 1 }], cfg),
    ).toBe('too-short');
  });

  it('отклоняет разноцветный путь', () => {
    expect(
      validatePath(board, [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }], cfg),
    ).toBe('color-mismatch');
  });

  it('отклоняет разрыв соседства', () => {
    expect(
      validatePath(board, [{ r: 0, c: 0 }, { r: 2, c: 0 }, { r: 1, c: 0 }], cfg),
    ).toBe('not-adjacent');
  });

  it('отклоняет выход за поле', () => {
    expect(
      validatePath(board, [{ r: 0, c: 0 }, { r: -1, c: 0 }, { r: 0, c: 1 }], cfg),
    ).toBe('out-of-bounds');
  });

  it('распознаёт кольцо: квадрат 2×2 с возвратом в старт', () => {
    const square: Cell[] = [
      { r: 3, c: 0 },
      { r: 3, c: 1 },
      { r: 4, c: 1 },
      { r: 4, c: 0 },
      { r: 3, c: 0 },
    ];
    const result = validatePath(board, square, cfg);
    expect(result).toEqual({ cells: square.slice(0, -1), ring: true });
  });

  it('отклоняет повтор клетки в середине пути', () => {
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 3, c: 1 },
      { r: 3, c: 0 },
      { r: 4, c: 0 },
    ];
    expect(validatePath(board, path, cfg)).toBe('revisit-without-ring');
  });

  it('отклоняет петлю из двух клеток (A→B→A) — это не кольцо', () => {
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 3, c: 1 },
      { r: 4, c: 1 },
      { r: 3, c: 1 },
    ];
    expect(validatePath(board, path, cfg)).toBe('too-short');
  });

  it('отклоняет повтор той же клетки подряд (клетка сама себе не сосед)', () => {
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 3, c: 1 },
      { r: 3, c: 1 },
    ];
    expect(validatePath(board, path, cfg)).toBe('not-adjacent');
  });

  it('отклоняет «кольцо» из трёх уникальных клеток', () => {
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 3, c: 1 },
      { r: 4, c: 0 },
      { r: 3, c: 0 },
    ];
    expect(validatePath(board, path, cfg)).toBe('too-short');
  });

  it('отклоняет возврат на предпоследнюю клетку длинного пути — цикл из 2 точек', () => {
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 4, c: 0 },
      { r: 4, c: 1 },
      { r: 3, c: 1 },
      { r: 4, c: 1 },
    ];
    expect(validatePath(board, path, cfg)).toBe('too-short');
  });

  it('принимает кольцо с хвостом: цикл ≥4 в конце пути', () => {
    const path: Cell[] = [
      { r: 5, c: 0 },
      { r: 4, c: 0 },
      { r: 3, c: 0 },
      { r: 3, c: 1 },
      { r: 4, c: 1 },
      { r: 4, c: 0 },
    ];
    const result = validatePath(board, path, cfg);
    expect(result).toEqual({ cells: path.slice(0, -1), ring: true });
  });
});

describe('chainPoints', () => {
  it('растёт сверхлинейно: 3→30, 4→60, 5→100', () => {
    expect(chainPoints(3, cfg)).toBe(30);
    expect(chainPoints(4, cfg)).toBe(60);
    expect(chainPoints(5, cfg)).toBe(100);
    expect(chainPoints(10, cfg)).toBe(450);
  });
});

describe('applyMove', () => {
  it('снимает цепочку, начисляет очки, роняет и досыпает точки', () => {
    const board = boardFrom([
      '001123',
      '010223',
      '001233',
      '112233',
      '112233',
      '112233',
    ]);
    const result = applyMove(
      board,
      [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }],
      cfg,
    );
    if (typeof result === 'string') throw new Error(result);
    expect(result.points).toBe(30);
    expect(result.ring).toBe(false);
    expect(result.removed).toHaveLength(3);
    // Поле осталось полным.
    expect(result.board.grid).toHaveLength(cfg.rows);
    for (const row of result.board.grid) expect(row).toHaveLength(cfg.cols);
    // Уцелевшая точка (2,0)=0 упала не ниже своего столбца и цвет сохранился.
    const col0 = result.board.grid.map((row) => row[0]);
    expect(col0.slice(2)).toEqual(board.grid.map((row) => row[0]).slice(2)); // нижние не тронуты
  });

  it('кольцо снимает все точки цвета и считает по ringDotValue', () => {
    const board = boardFrom([
      '001123',
      '010223',
      '001233',
      '112233',
      '112233',
      '112233',
    ]);
    const zeros = cellsOfColor(board.grid, 0).length;
    const square: Cell[] = [
      { r: 3, c: 0 },
      { r: 3, c: 1 },
      { r: 4, c: 1 },
      { r: 4, c: 0 },
      { r: 3, c: 0 },
    ];
    const ones = cellsOfColor(board.grid, 1).length;
    const result = applyMove(board, square, cfg);
    if (typeof result === 'string') throw new Error(result);
    expect(result.ring).toBe(true);
    expect(result.removed).toHaveLength(ones);
    expect(result.points).toBe(cfg.ringDotValue * ones);
    // Точек цвета 0 не убавилось.
    expect(cellsOfColor(board.grid, 0)).toHaveLength(zeros);
  });

  it('детерминирован: одинаковый ход на одинаковом поле даёт одинаковый результат', () => {
    const a = createBoard(seedRng(99), cfg);
    const b = createBoard(seedRng(99), cfg);
    // Найдём любую валидную тройку перебором.
    const path = findAnyChain(a);
    const ra = applyMove(a, path, cfg);
    const rb = applyMove(b, path, cfg);
    expect(ra).toEqual(rb);
  });
});

describe('collapse', () => {
  it('в столбце без удалений ничего не меняется', () => {
    const board = createBoard(seedRng(5), cfg);
    const result = collapse(board, [{ r: 0, c: 0 }, { r: 1, c: 0 }, { r: 2, c: 0 }], cfg);
    for (let c = 1; c < cfg.cols; c++) {
      for (let r = 0; r < cfg.rows; r++) {
        expect(result.grid[r]![c]).toBe(board.grid[r]![c]);
      }
    }
  });
});

/** Ищет первую попавшуюся валидную цепочку из трёх — для теста детерминизма. */
function findAnyChain(board: Board): Cell[] {
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      const color = board.grid[r]![c];
      if (c + 2 < cfg.cols && board.grid[r]![c + 1] === color && board.grid[r]![c + 2] === color) {
        return [{ r, c }, { r, c: c + 1 }, { r, c: c + 2 }];
      }
      if (r + 2 < cfg.rows && board.grid[r + 1]![c] === color && board.grid[r + 2]![c] === color) {
        return [{ r, c }, { r: r + 1, c }, { r: r + 2, c }];
      }
    }
  }
  throw new Error('no chain found on board');
}
