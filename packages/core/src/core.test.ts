import { describe, expect, it } from 'vitest';
import { cellAt, countInsulators, collapse, createBoard, dot } from './board.js';
import { applyMove, areNeighbors, chainPoints, validatePath } from './move.js';
import { phaseColorAt, phaseStateAt } from './phase.js';
import { nextInt, seedRng } from './rng.js';
import {
  DEFAULT_CONFIG,
  type Board,
  type Cell,
  type Color,
  type GameConfig,
  type Grid,
  type MoveResult,
} from './types.js';

const cfg = DEFAULT_CONFIG;

/** Конфиг с выключенными фичами — для тестов чистых цепочек. */
const bare: GameConfig = {
  ...DEFAULT_CONFIG,
  features: { insulators: false, phases: false, surge: false },
};

interface BoardExtras {
  insulators?: { r: number; c: number; hp: number }[];
  charged?: Cell[];
}

function boardFrom(rows: string[], extras: BoardExtras = {}): Board {
  const grid: Grid = rows.map((row) => [...row].map((ch) => dot(Number(ch) as Color)));
  for (const { r, c, hp } of extras.insulators ?? []) {
    grid[r]![c] = { kind: 'insulator', hp };
  }
  for (const { r, c } of extras.charged ?? []) {
    grid[r]![c] = { ...(grid[r]![c] as { kind: 'dot'; color: Color; charged: boolean }), charged: true };
  }
  return { grid, rng: seedRng(1), moveCount: 0 };
}

function mustApply(board: Board, path: Cell[], config: GameConfig, phase: Color | null = null): MoveResult {
  const result = applyMove(board, path, config, phase);
  if (typeof result === 'string') throw new Error(result);
  return result;
}

const ROWS = [
  '001123',
  '010223',
  '001233',
  '112233',
  '112233',
  '112233',
];

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
  it('строит поле нужного размера из точек с допустимыми цветами', () => {
    const board = createBoard(seedRng(7), cfg);
    expect(board.grid).toHaveLength(cfg.rows);
    for (const row of board.grid) {
      expect(row).toHaveLength(cfg.cols);
      for (const content of row) {
        expect(content.kind).toBe('dot');
        if (content.kind === 'dot') {
          expect(content.color).toBeGreaterThanOrEqual(0);
          expect(content.color).toBeLessThan(cfg.colors);
        }
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
  const board = boardFrom(ROWS);

  it('принимает цепочку из трёх соседних точек одного цвета', () => {
    const path: Cell[] = [
      { r: 0, c: 0 },
      { r: 0, c: 1 },
      { r: 1, c: 0 },
    ];
    expect(validatePath(board, path, cfg)).toEqual(path);
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

  it('отклоняет путь через изолятор', () => {
    const withBlock = boardFrom(ROWS, { insulators: [{ r: 0, c: 1, hp: 2 }] });
    expect(
      validatePath(withBlock, [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }], cfg),
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

  it('отклоняет любой повтор клетки', () => {
    const midRepeat: Cell[] = [
      { r: 3, c: 0 },
      { r: 3, c: 1 },
      { r: 3, c: 0 },
      { r: 4, c: 0 },
    ];
    expect(validatePath(board, midRepeat, cfg)).toBe('revisit');
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

describe('applyMove: цепочки', () => {
  it('снимает цепочку, начисляет очки, роняет и досыпает точки', () => {
    const board = boardFrom(ROWS);
    const result = mustApply(
      board,
      [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }],
      bare,
    );
    expect(result.points).toBe(30);
    expect(result.removed).toHaveLength(3);
    expect(result.board.moveCount).toBe(1);
    expect(result.board.grid).toHaveLength(cfg.rows);
    // Нижние точки нетронутого хвоста столбца 0 не изменились.
    expect(result.board.grid[5]![0]).toEqual(board.grid[5]![0]);
  });

  it('детерминирован: одинаковый ход на одинаковом поле даёт одинаковый результат', () => {
    const a = createBoard(seedRng(99), cfg);
    const b = createBoard(seedRng(99), cfg);
    const path = findAnyChain(a);
    expect(mustApply(a, path, cfg)).toEqual(mustApply(b, path, cfg));
  });
});

describe('изоляторы', () => {
  const withBlock = (hp: number) =>
    boardFrom(ROWS, { insulators: [{ r: 3, c: 5, hp }] });
  // Вертикальная цепочка цвета 3 в столбце 5, соседствует с изолятором (3,5).
  const chain: Cell[] = [
    { r: 0, c: 5 },
    { r: 1, c: 5 },
    { r: 2, c: 5 },
  ];

  it('цепочка рядом наносит 1 урон за ход', () => {
    const result = mustApply(withBlock(2), chain, cfg);
    expect(result.damaged).toEqual([{ r: 3, c: 5 }]);
    expect(result.destroyed).toHaveLength(0);
    expect(result.board.grid[3]![5]).toEqual({ kind: 'insulator', hp: 1 });
  });

  it('добивание выжигает изолятор и даёт бонус', () => {
    const result = mustApply(withBlock(1), chain, cfg);
    expect(result.destroyed).toEqual([{ r: 3, c: 5 }]);
    expect(result.points).toBe(30 + cfg.insulatorBonus);
    expect(countInsulators(result.board.grid)).toBe(0);
  });

  it('появляется каждый N-й ход в верхнем ряду столбца с досыпкой', () => {
    const spawnCfg: GameConfig = { ...bare, features: { ...bare.features, insulators: true }, insulatorEveryMoves: 1 };
    const result = mustApply(
      boardFrom(ROWS),
      [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }],
      spawnCfg,
    );
    expect(countInsulators(result.board.grid)).toBe(1);
    const topRow = result.board.grid[0]!;
    expect(topRow.some((content) => content.kind === 'insulator')).toBe(true);
  });

  it('не появляется сверх лимита', () => {
    const spawnCfg: GameConfig = {
      ...bare,
      features: { ...bare.features, insulators: true },
      insulatorEveryMoves: 1,
      insulatorMax: 0,
    };
    const result = mustApply(
      boardFrom(ROWS),
      [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }],
      spawnCfg,
    );
    expect(countInsulators(result.board.grid)).toBe(0);
  });
});

describe('перегрузка', () => {
  it('цепочка от surgeChainLength точек оставляет заряд на месте последней', () => {
    const surgeCfg: GameConfig = {
      ...bare,
      features: { ...bare.features, surge: true },
      surgeChainLength: 4,
    };
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 4, c: 0 },
      { r: 4, c: 1 },
      { r: 5, c: 1 },
    ];
    const result = mustApply(boardFrom(ROWS), path, surgeCfg);
    expect(result.charged).toEqual({ r: 5, c: 1 });
    const landed = result.board.grid[5]![1]!;
    expect(landed).toEqual({ kind: 'dot', color: expect.any(Number), charged: true });
  });

  it('заряженная точка в цепочке взрывает 3×3 вокруг себя', () => {
    const surgeCfg: GameConfig = { ...bare, features: { ...bare.features, surge: true } };
    const board = boardFrom(ROWS, { charged: [{ r: 4, c: 1 }] });
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 4, c: 0 },
      { r: 4, c: 1 },
      { r: 5, c: 1 },
    ];
    const result = mustApply(board, path, surgeCfg);
    // Соседи (4,1) вне цепочки: (3,1), (3,2), (4,2), (5,0), (5,2).
    expect(result.exploded).toHaveLength(5);
    expect(result.points).toBe(chainPoints(4, surgeCfg) + 5 * surgeCfg.surgeDotValue);
  });

  it('взрыв добивает изолятор рядом', () => {
    const fullCfg: GameConfig = {
      ...bare,
      features: { insulators: true, phases: false, surge: true },
    };
    // Изолятор hp2: 1 урон за соседство с цепочкой + 1 за зону взрыва.
    const board = boardFrom(ROWS, {
      charged: [{ r: 4, c: 1 }],
      insulators: [{ r: 3, c: 2, hp: 2 }],
    });
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 4, c: 0 },
      { r: 4, c: 1 },
      { r: 5, c: 1 },
    ];
    const result = mustApply(board, path, fullCfg);
    expect(result.destroyed).toEqual([{ r: 3, c: 2 }]);
  });
});

describe('нагрузка сети (фазы)', () => {
  it('первый цикл — без фазы, дальше фаза в начале каждого цикла', () => {
    const seed = 123;
    expect(phaseColorAt(seed, 0, cfg)).toBeNull();
    expect(phaseColorAt(seed, cfg.phasePeriod - 1, cfg)).toBeNull();
    const active = phaseColorAt(seed, cfg.phasePeriod + 1, cfg);
    expect(active).not.toBeNull();
    expect(active).toBeGreaterThanOrEqual(0);
    expect(active).toBeLessThan(cfg.colors);
    expect(phaseColorAt(seed, cfg.phasePeriod + cfg.phaseDuration, cfg)).toBeNull();
  });

  it('детерминирована по сиду', () => {
    const t = cfg.phasePeriod * 3 + 2;
    expect(phaseColorAt(5, t, cfg)).toBe(phaseColorAt(5, t, cfg));
  });

  it('выключена флагом', () => {
    expect(phaseColorAt(5, cfg.phasePeriod + 1, bare)).toBeNull();
  });

  it('умножает очки цепочки своего цвета и только их', () => {
    const board = boardFrom(ROWS);
    const path: Cell[] = [
      { r: 0, c: 0 },
      { r: 0, c: 1 },
      { r: 1, c: 0 },
    ];
    const phased = mustApply(board, path, cfg, 0);
    const offPhase = mustApply(board, path, cfg, 1);
    expect(phased.phased).toBe(true);
    expect(phased.points).toBe(30 * cfg.phaseMultiplier);
    expect(offPhase.phased).toBe(false);
    expect(offPhase.points).toBe(30);
  });

  it('phaseStateAt отдаёт корректный отсчёт до следующей фазы', () => {
    const state = phaseStateAt(9, 5, cfg);
    expect(state.active).toBeNull();
    expect(state.nextIn).toBe(cfg.phasePeriod - 5);
    expect(state.nextColor).toBeGreaterThanOrEqual(0);
  });
});

describe('collapse', () => {
  it('не трогает столбцы без удалений', () => {
    const board = createBoard(seedRng(5), cfg);
    const result = collapse(board, [{ r: 0, c: 0 }, { r: 1, c: 0 }, { r: 2, c: 0 }], cfg, false);
    for (let c = 1; c < cfg.cols; c++) {
      for (let r = 0; r < cfg.rows; r++) {
        expect(result.grid[r]![c]).toEqual(board.grid[r]![c]);
      }
    }
  });

  it('изолятор падает вместе со столбцом', () => {
    const board = boardFrom(ROWS, { insulators: [{ r: 2, c: 0, hp: 2 }] });
    // Убираем две точки под изолятором.
    const result = collapse(board, [{ r: 3, c: 0 }, { r: 4, c: 0 }], cfg, false);
    expect(result.grid[4]![0]).toEqual({ kind: 'insulator', hp: 2 });
  });
});

/** Ищет первую попавшуюся валидную цепочку из трёх — для теста детерминизма. */
function findAnyChain(board: Board): Cell[] {
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      const content = cellAt(board.grid, { r, c });
      if (content?.kind !== 'dot') continue;
      const right = cellAt(board.grid, { r, c: c + 1 });
      const right2 = cellAt(board.grid, { r, c: c + 2 });
      if (right?.kind === 'dot' && right.color === content.color &&
          right2?.kind === 'dot' && right2.color === content.color) {
        return [{ r, c }, { r, c: c + 1 }, { r, c: c + 2 }];
      }
      const down = cellAt(board.grid, { r: r + 1, c });
      const down2 = cellAt(board.grid, { r: r + 2, c });
      if (down?.kind === 'dot' && down.color === content.color &&
          down2?.kind === 'dot' && down2.color === content.color) {
        return [{ r, c }, { r: r + 1, c }, { r: r + 2, c }];
      }
    }
  }
  throw new Error('no chain found on board');
}
