import { describe, expect, it } from 'vitest';
import { cellAt, collapse, createBoard, dot } from './board.js';
import { applyMove, applyTap, areNeighbors, chainPoints, tapGroup, validatePath } from './move.js';
import {
  bestClaim,
  claimFrom,
  claimWindowAt,
  phaseColorAt,
  phaseStateAt,
  type Claim,
} from './phase.js';
import {
  nextOrderColor,
  orderReward,
  startOrder,
  tapOrder,
  tickOrder,
  type OrderRun,
} from './order.js';
import { cleanMarks, leagueMark, markAllowed, markById, MARKS, MARK_SLOTS } from './marks.js';
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
  features: { phases: false, surge: false, claim: false, tap: false },
};

function boardFrom(rows: string[], charged: Cell[] = []): Board {
  const grid: Grid = rows.map((row) => [...row].map((ch) => dot(Number(ch) as Color)));
  for (const { r, c } of charged) {
    grid[r]![c]!.charged = true;
  }
  return { grid, rng: seedRng(1), moveCount: 0, surgeStreak: 0 };
}

function mustApply(
  board: Board,
  path: Cell[],
  config: GameConfig,
  phase: Color | null = null,
): MoveResult {
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
  it('строит поле нужного размера с допустимыми цветами', () => {
    const board = createBoard(seedRng(7), cfg);
    expect(board.grid).toHaveLength(cfg.rows);
    for (const row of board.grid) {
      expect(row).toHaveLength(cfg.cols);
      for (const content of row) {
        expect(content.color).toBeGreaterThanOrEqual(0);
        expect(content.color).toBeLessThan(cfg.colors);
        expect(content.charged).toBe(false);
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

  it('не мутирует исходное поле', () => {
    const board = boardFrom(ROWS);
    const snapshot = structuredClone(board);
    mustApply(board, [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }], cfg);
    expect(board).toEqual(snapshot);
  });

  it('детерминирован: одинаковый ход на одинаковом поле даёт одинаковый результат', () => {
    const a = createBoard(seedRng(99), cfg);
    const b = createBoard(seedRng(99), cfg);
    const path = findAnyChain(a);
    expect(mustApply(a, path, cfg)).toEqual(mustApply(b, path, cfg));
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
    expect(result.board.grid[5]![1]!.charged).toBe(true);
  });

  it('заряд не появляется от короткой цепочки', () => {
    const result = mustApply(
      boardFrom(ROWS),
      [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }],
      cfg,
    );
    expect(result.charged).toBeNull();
  });

  it('заряженная точка в цепочке взрывает 3×3 вокруг себя', () => {
    const board = boardFrom(ROWS, [{ r: 4, c: 1 }]);
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 4, c: 0 },
      { r: 4, c: 1 },
      { r: 5, c: 1 },
    ];
    const result = mustApply(board, path, cfg);
    // Соседи (4,1) вне цепочки: (3,1), (3,2), (4,2), (5,0), (5,2).
    expect(result.exploded).toHaveLength(5);
    // Заряд не только взрывает, но и удваивает очки хода.
    expect(result.points).toBe((chainPoints(4, cfg) + 5 * cfg.surgeDotValue) * 2);
  });

  it('первый заряд удваивает очки хода', () => {
    const board = boardFrom(ROWS, [{ r: 4, c: 1 }]);
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 4, c: 0 },
      { r: 4, c: 1 },
      { r: 5, c: 1 },
    ];
    const result = mustApply(board, path, cfg);
    const base = chainPoints(4, cfg) + result.exploded.length * cfg.surgeDotValue;
    expect(result.surges).toBe(1);
    expect(result.multiplier).toBe(2);
    expect(result.points).toBe(base * 2);
    expect(result.board.surgeStreak).toBe(1);
  });

  it('серия зарядов растит множитель: ×2, ×3, ×4', () => {
    // Второй заряд подряд идёт с полем, где серия уже равна 1.
    const board = { ...boardFrom(ROWS, [{ r: 4, c: 1 }]), surgeStreak: 1 };
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 4, c: 0 },
      { r: 4, c: 1 },
      { r: 5, c: 1 },
    ];
    const second = mustApply(board, path, cfg);
    expect(second.multiplier).toBe(3);
    expect(second.streak).toBe(2);

    const third = mustApply({ ...board, surgeStreak: 2 }, path, cfg);
    expect(third.multiplier).toBe(4);
  });

  it('два заряда в одной цепочке дают сразу ×3', () => {
    const board = boardFrom(ROWS, [{ r: 3, c: 0 }, { r: 4, c: 1 }]);
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 4, c: 0 },
      { r: 4, c: 1 },
      { r: 5, c: 1 },
    ];
    const result = mustApply(board, path, cfg);
    expect(result.surges).toBe(2);
    expect(result.multiplier).toBe(3);
  });

  it('цепочка без заряда обрывает серию', () => {
    const board = { ...boardFrom(ROWS), surgeStreak: 3 };
    const result = mustApply(
      board,
      [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }],
      cfg,
    );
    expect(result.multiplier).toBe(1);
    expect(result.streak).toBe(0);
    expect(result.points).toBe(30);
  });

  it('множители фазы и серии перемножаются', () => {
    const board = boardFrom(ROWS, [{ r: 4, c: 1 }]);
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 4, c: 0 },
      { r: 4, c: 1 },
      { r: 5, c: 1 },
    ];
    // Цвет цепочки — 1; фаза того же цвета даёт ×2, заряд ещё ×2.
    const result = mustApply(board, path, cfg, 1);
    expect(result.phased).toBe(true);
    expect(result.multiplier).toBe(cfg.phaseMultiplier * 2);
  });

  it('выключается флагом: заряд в цепочке не взрывается', () => {
    const board = boardFrom(ROWS, [{ r: 4, c: 1 }]);
    const path: Cell[] = [
      { r: 3, c: 0 },
      { r: 4, c: 0 },
      { r: 4, c: 1 },
      { r: 5, c: 1 },
    ];
    const result = mustApply(board, path, bare);
    expect(result.exploded).toHaveLength(0);
  });
});

/** Секунда внутри фазы цикла: фаза идёт сразу за окном заявки. */
const inPhase = (cycle: number): number => cycle * cfg.phasePeriod + cfg.claimWindow + 1;

describe('нагрузка сети (фазы)', () => {
  it('первый цикл — разминка, дальше окно заявки и сразу за ним фаза', () => {
    const seed = 123;
    expect(phaseColorAt(seed, 0, cfg)).toBeNull();
    expect(phaseColorAt(seed, cfg.phasePeriod - 1, cfg)).toBeNull();
    // Начало цикла занято окном заявки — фазы там ещё нет.
    expect(phaseColorAt(seed, cfg.phasePeriod + 1, cfg)).toBeNull();
    const active = phaseColorAt(seed, inPhase(1), cfg);
    expect(active).not.toBeNull();
    expect(active).toBeGreaterThanOrEqual(0);
    expect(active).toBeLessThan(cfg.colors);
    const ends = cfg.phasePeriod + cfg.claimWindow + cfg.phaseDuration;
    expect(phaseColorAt(seed, ends, cfg)).toBeNull();
  });

  it('без заявок фаза открывает цикл, как было до них', () => {
    const off: GameConfig = { ...cfg, features: { ...cfg.features, claim: false } };
    expect(phaseColorAt(7, cfg.phasePeriod + 1, off)).not.toBeNull();
    expect(phaseColorAt(7, cfg.phasePeriod + cfg.phaseDuration, off)).toBeNull();
  });

  it('детерминирована по сиду', () => {
    const t = inPhase(3);
    expect(phaseColorAt(5, t, cfg)).toBe(phaseColorAt(5, t, cfg));
  });

  it('выключена флагом', () => {
    expect(phaseColorAt(5, inPhase(1), bare)).toBeNull();
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
    // Разминка: ближайшая фаза — за окном заявки первого цикла.
    expect(state.nextIn).toBe(cfg.phasePeriod + cfg.claimWindow - 5);
    expect(state.nextColor).toBeGreaterThanOrEqual(0);

    // Внутри окна отсчёт идёт до фазы своего же цикла.
    const inWindow = phaseStateAt(9, cfg.phasePeriod + 2, cfg);
    expect(inWindow.active).toBeNull();
    expect(inWindow.nextIn).toBe(cfg.claimWindow - 2);

    // Внутри фазы виден её остаток.
    const running = phaseStateAt(9, inPhase(1), cfg);
    expect(running.active).not.toBeNull();
    expect(running.remaining).toBe(cfg.phaseDuration - 1);
  });
});

describe('заявка цвета', () => {
  /** Цвет, которого фаза этого цикла точно не получила бы сама. */
  function otherThanSeed(seed: number, cycle: number): Color {
    const own = phaseColorAt(seed, inPhase(cycle), cfg)!;
    return (((own + 1) % cfg.colors) as Color);
  }

  it('окно открывает цикл: первая заявка — на 45-й секунде', () => {
    // Разминка окна не знает: биться за цвет на нетронутом поле нечем.
    expect(claimWindowAt(cfg.phasePeriod - 0.1, cfg).open).toBe(false);
    const open = claimWindowAt(cfg.phasePeriod + 0.1, cfg);
    expect(open.open).toBe(true);
    // Окно решает фазу своего цикла — ту, что начнётся сразу за ним.
    expect(open.cycle).toBe(1);
    expect(open.remaining).toBeCloseTo(cfg.claimWindow - 0.1, 5);
    // К началу фазы окно закрыто.
    expect(claimWindowAt(cfg.phasePeriod + cfg.claimWindow, cfg).open).toBe(false);
    // Следующее окно — ровно через период.
    expect(claimWindowAt(cfg.phasePeriod * 2 + 0.1, cfg)).toMatchObject({ open: true, cycle: 2 });
  });

  it('заявкой становится только длинная цепочка внутри окна', () => {
    const inside = cfg.phasePeriod + 2;
    expect(claimFrom(1, cfg.claimChainLength - 1, inside, cfg)).toBeNull();
    expect(claimFrom(1, cfg.claimChainLength, 1, cfg)).toBeNull();
    const claim = claimFrom(1, cfg.claimChainLength, inside, cfg);
    expect(claim).toEqual({ cycle: 1, color: 1, length: cfg.claimChainLength, t: inside });
  });

  it('заявка красит фазу вместо сида', () => {
    const seed = 77;
    const color = otherThanSeed(seed, 1);
    const claims: Claim[] = [{ cycle: 1, color, length: 6, t: cfg.phasePeriod + 3 }];
    expect(phaseColorAt(seed, inPhase(1), cfg, claims)).toBe(color);
    // Следующий цикл заявку не наследует: за него надо биться заново.
    expect(phaseColorAt(seed, inPhase(2), cfg, claims)).toBe(phaseColorAt(seed, inPhase(2), cfg));
  });

  it('побеждает длинная заявка, при равной длине — ранняя', () => {
    const claims: Claim[] = [
      { cycle: 1, color: 0, length: 6, t: 46 },
      { cycle: 1, color: 1, length: 9, t: 49 },
      { cycle: 1, color: 2, length: 9, t: 51 },
      { cycle: 2, color: 3, length: 20, t: 92 },
    ];
    expect(bestClaim(claims, 1)?.color).toBe(1);
    expect(bestClaim(claims, 2)?.color).toBe(3);
    expect(bestClaim(claims, 3)).toBeNull();
  });

  it('заявка видна в nextColor ещё до начала фазы', () => {
    const seed = 12;
    const color = otherThanSeed(seed, 1);
    const t = cfg.phasePeriod + 4;
    const claims: Claim[] = [{ cycle: 1, color, length: 7, t: cfg.phasePeriod + 3 }];
    expect(phaseStateAt(seed, t, cfg, claims).nextColor).toBe(color);
    expect(phaseStateAt(seed, t, cfg).nextColor).not.toBe(color);
  });

  it('выключенный флаг возвращает цвет из сида и закрывает окно', () => {
    const off: GameConfig = { ...cfg, features: { ...cfg.features, claim: false } };
    const seed = 31;
    const color = otherThanSeed(seed, 1);
    const claims: Claim[] = [{ cycle: 1, color, length: 9, t: cfg.phasePeriod + 2 }];
    expect(claimWindowAt(cfg.phasePeriod + 2, off).open).toBe(false);
    expect(claimFrom(color, 9, cfg.phasePeriod + 2, off)).toBeNull();
    // Без окна фаза открывает цикл, и цвет у неё сидовый.
    expect(phaseColorAt(seed, cfg.phasePeriod + 1, off, claims)).toBe(
      phaseColorAt(seed, inPhase(1), cfg),
    );
  });
});

describe('collapse', () => {
  it('не трогает столбцы без удалений', () => {
    const board = createBoard(seedRng(5), cfg);
    const result = collapse(board, [{ r: 0, c: 0 }, { r: 1, c: 0 }, { r: 2, c: 0 }], cfg);
    for (let c = 1; c < cfg.cols; c++) {
      for (let r = 0; r < cfg.rows; r++) {
        expect(result.grid[r]![c]).toEqual(board.grid[r]![c]);
      }
    }
  });

  it('заряд падает вместе с точкой', () => {
    const board = boardFrom(ROWS, [{ r: 2, c: 0 }]);
    // Убираем две точки под заряженной.
    const result = collapse(board, [{ r: 3, c: 0 }, { r: 4, c: 0 }], cfg);
    expect(result.grid[4]![0]!.charged).toBe(true);
  });
});

/** Ищет первую попавшуюся валидную цепочку из трёх — для теста детерминизма. */
function findAnyChain(board: Board): Cell[] {
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      const start = cellAt(board.grid, { r, c })!;
      const right = cellAt(board.grid, { r, c: c + 1 });
      const right2 = cellAt(board.grid, { r, c: c + 2 });
      if (right?.color === start.color && right2?.color === start.color) {
        return [{ r, c }, { r, c: c + 1 }, { r, c: c + 2 }];
      }
      const down = cellAt(board.grid, { r: r + 1, c });
      const down2 = cellAt(board.grid, { r: r + 2, c });
      if (down?.color === start.color && down2?.color === start.color) {
        return [{ r, c }, { r: r + 1, c }, { r: r + 2, c }];
      }
    }
  }
  throw new Error('no chain found on board');
}

describe('ход одним касанием', () => {
  /*
   * Поле для группы: пятно нулей в левом верхнем углу, связанное и по
   * диагонали, и отдельная единица под ним.
   */
  const SPOT = ['001231', '001323', '102132', '231213', '312321', '123132'];

  it('снимает всю связную группу цвета, считая и диагонали', () => {
    const board = boardFrom(SPOT);
    const group = tapGroup(board, { r: 0, c: 0 }, bare);
    expect(group.map((cell) => `${cell.r}${cell.c}`).sort()).toEqual(['00', '01', '10', '11', '21']);
  });

  it('порядок идёт волной от касания: первой снимается нажатая точка', () => {
    const board = boardFrom(SPOT);
    expect(tapGroup(board, { r: 2, c: 1 }, bare)[0]).toEqual({ r: 2, c: 1 });
  });

  it('считает потенциал как цепочка той же длины', () => {
    const board = boardFrom(SPOT);
    const tapped = applyTap(board, { r: 0, c: 0 }, bare);
    if (typeof tapped === 'string') throw new Error(tapped);
    expect(tapped.points).toBe(chainPoints(5, bare));
    expect(tapped.removed).toHaveLength(5);
    expect(tapped.color).toBe(0);
  });

  it('одиночку не берёт: порог тот же, что у цепочки', () => {
    const board = boardFrom(SPOT);
    expect(tapGroup(board, { r: 2, c: 0 }, bare).length).toBeLessThan(bare.minChain);
    expect(applyTap(board, { r: 2, c: 0 }, bare)).toBe('too-short');
  });

  it('за полем — отказ', () => {
    expect(applyTap(boardFrom(SPOT), { r: -1, c: 0 }, bare)).toBe('out-of-bounds');
  });

  it('заряд в группе взрывает 3×3 и множит ход — как в цепочке', () => {
    const board = boardFrom(SPOT, [{ r: 1, c: 1 }]);
    const tapped = applyTap(board, { r: 0, c: 0 }, cfg);
    if (typeof tapped === 'string') throw new Error(tapped);
    expect(tapped.surges).toBe(1);
    expect(tapped.exploded.length).toBeGreaterThan(0);
    expect(tapped.multiplier).toBe(2);
  });

  it('фаза своего цвета удваивает и касание', () => {
    const board = boardFrom(SPOT);
    const plain = applyTap(board, { r: 0, c: 0 }, cfg, 1);
    const phased = applyTap(board, { r: 0, c: 0 }, cfg, 0);
    if (typeof plain === 'string' || typeof phased === 'string') throw new Error('tap');
    expect(phased.points).toBe(plain.points * cfg.phaseMultiplier);
  });

  it('поле после касания падает так же, как после цепочки', () => {
    const board = boardFrom(SPOT);
    const tapped = applyTap(board, { r: 0, c: 0 }, bare);
    if (typeof tapped === 'string') throw new Error(tapped);
    expect(tapped.board.grid).toHaveLength(bare.rows);
    for (const row of tapped.board.grid) expect(row).toHaveLength(bare.cols);
    expect(tapped.board.moveCount).toBe(1);
  });

  it('не трогает исходное поле', () => {
    const board = boardFrom(SPOT);
    const snapshot = structuredClone(board);
    applyTap(board, { r: 0, c: 0 }, cfg);
    expect(board).toEqual(snapshot);
  });
});

describe('заказ', () => {
  /** Цепочка цветов окон по сиду — как её ведёт партия. */
  function windows(seed: number, count: number): Color[] {
    const out: Color[] = [];
    let previous: Color | null = null;
    for (let cycle = 0; cycle < count; cycle++) {
      previous = nextOrderColor(seed, cycle, previous, cfg);
      out.push(previous);
    }
    return out;
  }

  it('цвет окна не повторяет предыдущий — смену видно', () => {
    const run = windows(7, 60);
    for (let i = 1; i < run.length; i++) expect(run[i]).not.toBe(run[i - 1]);
    for (const color of run) expect(color).toBeLessThan(cfg.colors);
    // Все цвета в ходу: исключается только один, а не половина палитры.
    expect(new Set(run).size).toBe(cfg.colors);
  });

  it('цвета окон выводятся из сида — заход воспроизводим', () => {
    expect(windows(7, 12)).toEqual(windows(7, 12));
  });

  it('разные образцы дают разные окна', () => {
    expect(windows(1, 12).join('')).not.toBe(windows(2, 12).join(''));
  });

  it('недобор не стоит ничего, цель стоит награду, а сверх — по награде за точку', () => {
    expect(orderReward(cfg.orderTarget - 1, cfg)).toBe(0);
    expect(orderReward(cfg.orderTarget, cfg)).toBe(cfg.orderReward);
    expect(orderReward(cfg.orderTarget + 1, cfg)).toBe(cfg.orderReward * 2);
    expect(orderReward(cfg.orderTarget + 5, cfg)).toBe(cfg.orderReward * 6);
  });

  /**
   * Самая большая снимаемая группа: заданного цвета или, если цвет null,
   * любого, кроме цвета окна.
   */
  function biggest(run: OrderRun, color: Color | null): { cell: Cell; size: number } | null {
    let best: { cell: Cell; size: number } | null = null;
    for (let r = 0; r < cfg.rows; r++) {
      for (let c = 0; c < cfg.cols; c++) {
        const dot = run.board.grid[r]![c]!.color;
        if (color === null ? dot === run.color : dot !== color) continue;
        const size = tapGroup(run.board, { r, c }, cfg).length;
        if (size >= cfg.minChain && (best === null || size > best.size)) {
          best = { cell: { r, c }, size };
        }
      }
    }
    return best;
  }

  it('заход начинается с первого окна и живого запаса', () => {
    const run = startOrder(11, cfg);
    expect(run.cycle).toBe(0);
    expect(run.since).toBe(0);
    expect(run.over).toBe(false);
    expect(run.fails).toBe(0);
    expect(run.board.grid).toHaveLength(cfg.rows);
  });

  it('просроченное окно — сбой, и каждое считается отдельно', () => {
    const run = startOrder(11, cfg);
    expect(tickOrder(run, cfg.orderWindow - 0.1, cfg).fails).toBe(0);

    const one = tickOrder(run, cfg.orderWindow, cfg);
    expect(one.fails).toBe(1);
    expect(one.cycle).toBe(1);
    expect(one.lastWindow).toBe('missed');
    // Окно считается от границы прошлого, а не от секунды, когда спохватились.
    expect(one.since).toBe(cfg.orderWindow);
    expect(one.color).not.toBe(run.color);

    // Долгий простой стоит всех окон, которые за него прошли.
    const dead = tickOrder(run, cfg.orderWindow * cfg.orderLives, cfg);
    expect(dead.fails).toBe(cfg.orderLives);
    expect(dead.over).toBe(true);
  });

  it('заказ в цель закрывает окно и открывает следующее', () => {
    // Растим пятно, разбирая всё, кроме него, и жмём, когда дорастёт.
    let run = startOrder(3, cfg);
    let t = 0;
    let fired: { size: number; reward: number } | null = null;
    for (let move = 0; move < 120 && fired === null; move++) {
      const mine = biggest(run, run.color);
      const cell =
        mine !== null && mine.size >= cfg.orderTarget
          ? mine.cell
          : (biggest(run, null)?.cell ?? mine?.cell ?? null);
      if (cell === null) break;
      // Время двигаем по чуть-чуть: окно за такой заход не истечёт.
      t += 0.05;
      const out = tapOrder(run, cell, t, cfg);
      if (typeof out === 'string') throw new Error(out);
      run = out.run;
      if (out.fire !== null && out.fire.reward > 0) fired = out.fire;
    }

    expect(fired).not.toBeNull();
    expect(fired!.size).toBeGreaterThanOrEqual(cfg.orderTarget);
    expect(run.orders).toBe(1);
    expect(run.streak).toBe(1);
    expect(run.fails).toBe(0);
    expect(run.score).toBe(orderReward(fired!.size, cfg));
    expect(run.cycle).toBe(1);
    expect(run.lastWindow).toBe('done');
    // Новое окно пошло от секунды заказа: отсчёт полный.
    expect(run.since).toBe(t);
    expect(run.over).toBe(false);
  });

  it('недобор цветом окна ничего не меняет, кроме поля', () => {
    let run = startOrder(5, cfg);
    const mine = biggest(run, run.color);
    if (mine === null) throw new Error('нет группы своего цвета');
    const out = tapOrder(run, mine.cell, 1, cfg);
    if (typeof out === 'string') throw new Error(out);
    expect(out.fire).toEqual({ size: mine.size, reward: 0 });
    expect(out.run.score).toBe(0);
    expect(out.run.orders).toBe(0);
    expect(out.run.cycle).toBe(0);
  });

  it('в мёртвом заходе ходов не бывает', () => {
    const run = { ...startOrder(5, cfg), over: true };
    expect(tapOrder(run, { r: 0, c: 0 }, 1, cfg)).toBe('too-short');
  });

  it('притянутый цвет сыплется чаще прочих, но не вытесняет их', () => {
    // Смотрим прямо на досыпку: сносим поле целиком и считаем, чем его залило.
    const tally = [0, 0, 0, 0];
    let board = boardFrom(ROWS);
    const whole: Cell[] = [];
    for (let r = 0; r < cfg.rows; r++) {
      for (let c = 0; c < cfg.cols; c++) whole.push({ r, c });
    }
    for (let i = 0; i < 60; i++) {
      const filled = collapse(board, whole, cfg, 3);
      for (const row of filled.grid) {
        for (const cell of row) tally[cell.color]! += 1;
      }
      board = { ...board, grid: filled.grid, rng: filled.rng };
    }
    const total = tally.reduce((a, b) => a + b, 0);
    const share = tally[3]! / total;
    const expected = cfg.orderWeight / (cfg.orderWeight + cfg.colors - 1);
    expect(Math.abs(share - expected)).toBeLessThan(0.05);
    for (const color of [0, 1, 2]) expect(tally[color]!).toBeGreaterThan(0);
  });

  it('без притяжения досыпка равномерна', () => {
    const plain = applyTap(boardFrom(ROWS), { r: 0, c: 0 }, bare);
    const same = applyTap(boardFrom(ROWS), { r: 0, c: 0 }, bare, null, null);
    if (typeof plain === 'string' || typeof same === 'string') throw new Error('tap');
    expect(same.board.grid).toEqual(plain.board.grid);
  });
});

describe('шильдики', () => {
  it('каталог без повторов: и номера, и картинки', () => {
    expect(new Set(MARKS.map((mark) => mark.id)).size).toBe(MARKS.length);
    expect(new Set(MARKS.map((mark) => mark.glyph)).size).toBe(MARKS.length);
  });

  it('находит по номеру и отвергает выдуманный', () => {
    const free = MARKS.find((mark) => mark.kind !== 'earned')!;
    expect(markById(free.id)).toEqual(free);
    expect(markById('нет-такого')).toBeUndefined();
    expect(markAllowed(free.id)).toBe(true);
    expect(markAllowed('нет-такого')).toBe(false);
  });

  it('отметку за игру носит только тот, кому её выдали', () => {
    const earned = MARKS.find((mark) => mark.kind === 'earned')!;
    expect(earned.needs).toBeTruthy();
    expect(markAllowed(earned.id)).toBe(false);
    expect(markAllowed(earned.id, [earned.id])).toBe(true);
    // Чужая выданная отметка своей не делает.
    expect(markAllowed(earned.id, ['e-нет'])).toBe(false);
  });

  it('лига даёт отметку со второй ступени', () => {
    expect(leagueMark(0)).toBeNull();
    expect(leagueMark(1)).toBe('e-lg1');
    expect(leagueMark(4)).toBe('e-lg4');
    expect(leagueMark(5)).toBeNull();
    for (const tier of [1, 2, 3, 4]) expect(markById(leagueMark(tier)!)).toBeDefined();
  });

  it('выбор приводится к корпусу: три ячейки, без повторов и выдумок', () => {
    const free = MARKS.filter((mark) => mark.kind !== 'earned');
    const [a, b] = [free[0]!.id, free[1]!.id];
    expect(cleanMarks([a, b])).toEqual([a, b, null]);
    // Повтор и несуществующий номер гасят ячейку, а не занимают её.
    expect(cleanMarks([a, a, 'нет-такого'])).toEqual([a, null, null]);
    // Лишнее за край корпуса просто не помещается.
    expect(cleanMarks(free.slice(0, 5).map((mark) => mark.id))).toHaveLength(MARK_SLOTS);
    expect(cleanMarks([])).toEqual([null, null, null]);
  });
});
