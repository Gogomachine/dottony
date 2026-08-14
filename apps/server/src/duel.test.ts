import { describe, expect, it, vi } from 'vitest';
import {
  applyMove,
  cellAt,
  cleanMarks,
  createBoard,
  phaseColorAt,
  seedRng,
  DEFAULT_CONFIG,
  MARK_SLOTS,
  type Board,
  type Cell,
} from '@doton/core';
import { DUEL_SECONDS, type DuelServerMessage } from '@doton/protocol';
import { Duel, type DuelPlayer } from './duel.js';
import { ghostSchedule, makeSyntheticGhost, type Ghost } from './ghost.js';
import { Matchmaker, type MatchResult } from './matchmaker.js';

/** Любая цепочка из трёх по правилам игры (8 направлений). */
function findAnyChain(board: Board): Cell[] {
  const cfg = DEFAULT_CONFIG;
  const dirs = [-1, 0, 1];
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      const start = cellAt(board.grid, { r, c })!;
      for (const dr1 of dirs) {
        for (const dc1 of dirs) {
          if (dr1 === 0 && dc1 === 0) continue;
          const second: Cell = { r: r + dr1, c: c + dc1 };
          if (cellAt(board.grid, second)?.color !== start.color) continue;
          for (const dr2 of dirs) {
            for (const dc2 of dirs) {
              if (dr2 === 0 && dc2 === 0) continue;
              const third: Cell = { r: second.r + dr2, c: second.c + dc2 };
              if (third.r === r && third.c === c) continue;
              if (cellAt(board.grid, third)?.color !== start.color) continue;
              return [{ r, c }, second, third];
            }
          }
        }
      }
    }
  }
  throw new Error('no chain found');
}

interface Recorder extends DuelPlayer {
  messages: DuelServerMessage[];
  last(type: DuelServerMessage['type']): DuelServerMessage | undefined;
}

function recorder(id: string, name = id): Recorder {
  const messages: DuelServerMessage[] = [];
  return {
    id,
    name,
    messages,
    send: (message) => messages.push(message),
    last: (type) => [...messages].reverse().find((message) => message.type === type),
  };
}

describe('Duel', () => {
  const seed = 4242;

  it('выдаёт обоим одинаковое поле и объявляет соперника', () => {
    const a = recorder('a', 'Ада');
    const b = recorder('b', 'Боб');
    const duel = new Duel(seed, a, b);
    duel.announce();

    const matchedA = a.last('matched');
    const matchedB = b.last('matched');
    expect(matchedA).toMatchObject({ seed, opponent: 'Боб', duration: DUEL_SECONDS });
    expect(matchedB).toMatchObject({ seed, opponent: 'Ада', duration: DUEL_SECONDS });
  });

  it('шлёт каждому корпус соперника целиком, а не свой', () => {
    const a = recorder('a', 'Ада');
    const b = recorder('b', 'Боб');
    a.marks = ['p0', null, 's0'];
    b.marks = ['e-lg2', 'p3', null];
    const duel = new Duel(seed, a, b);
    duel.announce();

    expect(a.last('matched')).toMatchObject({ opponentMarks: ['e-lg2', 'p3', null] });
    expect(b.last('matched')).toMatchObject({ opponentMarks: ['p0', null, 's0'] });

    // И после обрыва — тоже соперника: снимок восстанавливает весь экран.
    expect(duel.snapshot('a')).toMatchObject({ opponentMarks: ['e-lg2', 'p3', null] });
  });

  it('корпус пустой, если соперник ничего не поставил', () => {
    const a = recorder('a', 'Ада');
    const duel = new Duel(seed, a, recorder('b', 'Боб'));
    duel.announce();
    expect(a.last('matched')).toMatchObject({ opponentMarks: [null, null, null] });
  });

  it('засчитывает ход и сообщает счёт сопернику', () => {
    const a = recorder('a');
    const b = recorder('b');
    const duel = new Duel(seed, a, b);
    const board = createBoard(seedRng(seed), DEFAULT_CONFIG);
    const path = findAnyChain(board);

    const outcome = duel.applyMove('a', path);
    expect(outcome).toMatchObject({ ok: true, points: 30, score: 30 });
    // Соперник видит только счёт, не поле.
    expect(b.last('opponent')).toEqual({ type: 'opponent', score: 30 });
    expect(a.last('opponent')).toBeUndefined();
  });

  it('считает очки сам и не верит клиенту: фаза учитывается сервером', () => {
    const a = recorder('a');
    const b = recorder('b');
    const now = Date.now();
    const duel = new Duel(seed, a, b, { now });

    const board = createBoard(seedRng(seed), DEFAULT_CONFIG);
    const path = findAnyChain(board);
    // Момент внутри фазы «нагрузки сети»: сервер берёт своё время.
    // Фаза идёт сразу за окном заявки, а не в начале цикла.
    const phaseTime = DEFAULT_CONFIG.phasePeriod + DEFAULT_CONFIG.claimWindow + 1;
    const phase = phaseColorAt(seed, phaseTime, DEFAULT_CONFIG);
    const expected = applyMove(board, path, DEFAULT_CONFIG, phase);
    if (typeof expected === 'string') throw new Error(expected);

    const outcome = duel.applyMove('a', path, now + phaseTime * 1000);
    expect(outcome).toMatchObject({ ok: true, points: expected.points });
  });

  it('отклоняет нелегальный ход', () => {
    const duel = new Duel(seed, recorder('a'), recorder('b'));
    const outcome = duel.applyMove('a', [{ r: 0, c: 0 }, { r: 5, c: 5 }, { r: 0, c: 1 }]);
    expect(outcome.ok).toBe(false);
  });

  it('отклоняет нечеловеческий темп', () => {
    const now = Date.now();
    const duel = new Duel(seed, recorder('a'), recorder('b'), { now });
    let board = createBoard(seedRng(seed), DEFAULT_CONFIG);

    const first = findAnyChain(board);
    const applied = applyMove(board, first, DEFAULT_CONFIG, null);
    if (typeof applied === 'string') throw new Error(applied);
    board = applied.board;

    expect(duel.applyMove('a', first, now + 1000).ok).toBe(true);
    // Второй ход спустя 10 мс — быстрее, чем возможно вручную.
    const second = findAnyChain(board);
    expect(duel.applyMove('a', second, now + 1010)).toMatchObject({
      ok: false,
      reason: 'too-fast',
    });
  });

  it('не принимает ходы после сирены', () => {
    const now = Date.now();
    const duel = new Duel(seed, recorder('a'), recorder('b'), { now });
    const board = createBoard(seedRng(seed), DEFAULT_CONFIG);
    const path = findAnyChain(board);
    expect(duel.applyMove('a', path, now + (DUEL_SECONDS + 2) * 1000)).toMatchObject({
      ok: false,
      reason: 'duel-over',
    });
  });

  it('объявляет победителя, проигравшего и ничью', () => {
    const a = recorder('a');
    const b = recorder('b');
    const duel = new Duel(seed, a, b);
    const board = createBoard(seedRng(seed), DEFAULT_CONFIG);
    duel.applyMove('a', findAnyChain(board));
    duel.finish();

    expect(a.last('finished')).toMatchObject({ outcome: 'win', score: 30, opponentScore: 0 });
    expect(b.last('finished')).toMatchObject({ outcome: 'loss', score: 0, opponentScore: 30 });

    const draw = new Duel(seed, recorder('c'), recorder('d'));
    draw.finish();
    expect(draw.scoreOf('c')).toBe(0);
  });

  it('повторное завершение не рассылает результат дважды', () => {
    const a = recorder('a');
    const duel = new Duel(seed, a, recorder('b'));
    duel.finish();
    duel.finish();
    expect(a.messages.filter((message) => message.type === 'finished')).toHaveLength(1);
  });

  it('ушедший игрок проигрывает', () => {
    const a = recorder('a');
    const b = recorder('b');
    const duel = new Duel(seed, a, b);
    const board = createBoard(seedRng(seed), DEFAULT_CONFIG);
    duel.applyMove('a', findAnyChain(board));

    duel.abandon('a');
    expect(a.last('finished')).toMatchObject({ outcome: 'loss' });
    expect(b.last('finished')).toMatchObject({ outcome: 'win' });
  });
});

describe('Matchmaker', () => {
  function make(onFinish?: (result: { players: { id: string; score: number }[] }) => void) {
    const timers: (() => void)[] = [];
    const maker = new Matchmaker({
      ...(onFinish ? { onFinish } : {}),
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => {},
    });
    return { maker, fireTimers: () => timers.splice(0).forEach((fn) => fn()) };
  }

  it('первый игрок ждёт, второй запускает матч', () => {
    const { maker } = make();
    const a = recorder('a', 'Ада');
    const b = recorder('b', 'Боб');

    maker.join(a);
    expect(a.last('searching')).toEqual({ type: 'searching' });
    expect(maker.stats).toEqual({ waiting: 1, duels: 0 });

    maker.join(b);
    expect(a.last('matched')).toMatchObject({ opponent: 'Боб' });
    expect(b.last('matched')).toMatchObject({ opponent: 'Ада' });
    // Поле общее — это и делает дуэль честной.
    const seedA = (a.last('matched') as { seed: number }).seed;
    const seedB = (b.last('matched') as { seed: number }).seed;
    expect(seedA).toBe(seedB);
    expect(maker.stats).toEqual({ waiting: 0, duels: 1 });
  });

  it('приватная комната сводит только своих', () => {
    const { maker } = make();
    const a = recorder('a');
    const stranger = recorder('s');
    const friend = recorder('f');

    maker.join(a, 'КОД123');
    maker.join(stranger);
    expect(a.last('matched')).toBeUndefined();

    maker.join(friend, 'КОД123');
    expect(a.last('matched')).toBeDefined();
    expect(friend.last('matched')).toBeDefined();
  });

  it('ход вне матча отклоняется', () => {
    const { maker } = make();
    expect(maker.move('nobody', [])).toMatchObject({ ok: false, reason: 'not-in-duel' });
  });

  it('по истечении времени матч закрывается и результат сохраняется', () => {
    const onFinish = vi.fn();
    const { maker, fireTimers } = make(onFinish);
    const a = recorder('a', 'Ада');
    const b = recorder('b', 'Боб');
    maker.join(a);
    maker.join(b);

    fireTimers();
    expect(maker.stats).toEqual({ waiting: 0, duels: 0 });
    expect(onFinish).toHaveBeenCalledTimes(1);
    const result = onFinish.mock.calls[0]![0] as { players: { name: string }[] };
    expect(result.players.map((player) => player.name).sort()).toEqual(['Ада', 'Боб']);
    expect(a.last('finished')).toBeDefined();
  });

  it('выход из очереди не создаёт матч', () => {
    const { maker } = make();
    const a = recorder('a');
    maker.join(a);
    maker.leave('a');
    expect(maker.stats).toEqual({ waiting: 0, duels: 0 });

    maker.join(recorder('b'));
    expect(maker.stats).toEqual({ waiting: 1, duels: 0 });
  });

  it('обрыв связи засчитывает поражение и закрывает матч', () => {
    const onFinish = vi.fn();
    const { maker } = make(onFinish);
    const a = recorder('a');
    const b = recorder('b');
    maker.join(a);
    maker.join(b);

    maker.leave('a');
    expect(a.last('finished')).toMatchObject({ outcome: 'loss' });
    expect(b.last('finished')).toMatchObject({ outcome: 'win' });
    expect(maker.stats).toEqual({ waiting: 0, duels: 0 });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('повторный join не плодит очередь', () => {
    const { maker } = make();
    const a = recorder('a');
    maker.join(a);
    maker.join(a);
    expect(maker.stats).toEqual({ waiting: 1, duels: 0 });
  });
});

describe('признак рейтингового матча', () => {
  function make(options: { findGhost?: () => Promise<Ghost | undefined> } = {}) {
    const timers: { fn: () => void; ms: number }[] = [];
    const onFinish = vi.fn();
    const maker = new Matchmaker({
      onFinish,
      ...(options.findGhost ? { findGhost: options.findGhost, ghostAfterMs: 100 } : {}),
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
    });
    return {
      maker,
      onFinish,
      fire: (upToMs: number) => {
        for (const timer of timers.filter((entry) => entry.ms <= upToMs)) {
          timers.splice(timers.indexOf(timer), 1);
          timer.fn();
        }
      },
      result: () => onFinish.mock.calls[0]![0] as MatchResult,
    };
  }

  it('открытый матч двух живых игроков рейтинговый, исходы приходят наружу', () => {
    const { maker, fire, result } = make();
    const a = recorder('a', 'Ада');
    const b = recorder('b', 'Боб');
    maker.join(a);
    maker.join(b);
    const seed = (a.last('matched') as { seed: number }).seed;
    maker.move('a', findAnyChain(createBoard(seedRng(seed), DEFAULT_CONFIG)));

    fire((DUEL_SECONDS + 1) * 1000);
    expect(result().rated).toBe(true);
    const outcomes = result().outcomes;
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(['loss', 'win']);
    expect(outcomes.find((outcome) => outcome.playerId === 'a')).toMatchObject({
      outcome: 'win',
      score: 30,
      opponentScore: 0,
    });
  });

  it('матч в комнате с другом рейтинг не двигает', () => {
    const { maker, fire, result } = make();
    maker.join(recorder('a'), 'КОД123');
    maker.join(recorder('b'), 'КОД123');
    fire((DUEL_SECONDS + 1) * 1000);
    expect(result().rated).toBe(false);
  });

  it('матч с призраком не рейтинговый: запись не может проиграть', async () => {
    const ghost: Ghost = {
      name: 'Ада',
      seed: 777,
      score: 300,
      log: [{ t: 1, points: 300 }],
      marks: ['p0', null, null],
    };
    const { maker, fire, result } = make({ findGhost: async () => ghost });
    maker.join(recorder('p'));
    fire(100);
    await Promise.resolve();
    await Promise.resolve();

    fire((DUEL_SECONDS + 1) * 1000);
    expect(result().rated).toBe(false);
    // Исход живому игроку всё равно нужен — экран результата его показывает.
    expect(result().outcomes).toHaveLength(1);
    expect(result().outcomes[0]).toMatchObject({ playerId: 'p', opponentIsGhost: true });
  });

  it('сдача в открытом матче остаётся рейтинговой', () => {
    const { maker, result } = make();
    maker.join(recorder('a'));
    maker.join(recorder('b'));
    maker.leave('a');
    expect(result().rated).toBe(true);
    expect(result().outcomes.find((outcome) => outcome.playerId === 'a')?.outcome).toBe('loss');
  });
});

describe('обрыв связи', () => {
  function make() {
    const timers: (() => void)[] = [];
    const onFinish = vi.fn();
    const maker = new Matchmaker({
      onFinish,
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => {},
    });
    return { maker, onFinish, fireTimers: () => timers.splice(0).forEach((fn) => fn()) };
  }

  it('не завершает матч: на телефоне соединение рвётся от сворачивания', () => {
    const { maker, onFinish } = make();
    const a = recorder('a', 'Ада');
    const b = recorder('b', 'Боб');
    maker.join(a);
    maker.join(b);

    maker.disconnect('a');
    expect(a.last('finished')).toBeUndefined();
    expect(b.last('finished')).toBeUndefined();
    expect(maker.stats.duels).toBe(1);
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('возвращает игрока в его матч со счётом, полем и остатком времени', () => {
    const { maker } = make();
    const a = recorder('a', 'Ада');
    const b = recorder('b', 'Боб');
    maker.join(a);
    maker.join(b);

    const seed = (a.last('matched') as { seed: number }).seed;
    const board = createBoard(seedRng(seed), DEFAULT_CONFIG);
    maker.move('a', findAnyChain(board));
    maker.disconnect('a');

    // Игрок вернулся: новое соединение, тот же идентификатор.
    const reconnected = recorder('a', 'Ада');
    maker.join(reconnected);

    const resumed = reconnected.last('resumed') as {
      seed: number;
      score: number;
      opponent: string;
      remaining: number;
      grid: unknown[][];
    };
    expect(resumed).toMatchObject({ seed, score: 30, opponent: 'Боб' });
    expect(resumed.grid).toHaveLength(DEFAULT_CONFIG.rows);
    expect(resumed.remaining).toBeGreaterThan(0);
    expect(resumed.remaining).toBeLessThanOrEqual(DUEL_SECONDS);
    expect(maker.stats).toEqual({ waiting: 0, duels: 1 });
  });

  it('после возвращения ходы снова принимаются и видны сопернику', () => {
    const { maker } = make();
    const a = recorder('a');
    const b = recorder('b');
    maker.join(a);
    maker.join(b);
    const seed = (a.last('matched') as { seed: number }).seed;

    maker.disconnect('a');
    const reconnected = recorder('a');
    maker.join(reconnected);

    const board = createBoard(seedRng(seed), DEFAULT_CONFIG);
    expect(maker.move('a', findAnyChain(board)).ok).toBe(true);
    expect(b.last('opponent')).toEqual({ type: 'opponent', score: 30 });
  });

  it('не вернулся до сирены — результат по набранным очкам, а не техническое поражение', () => {
    const { maker, fireTimers } = make();
    const a = recorder('a');
    const b = recorder('b');
    maker.join(a);
    maker.join(b);
    const seed = (a.last('matched') as { seed: number }).seed;
    const board = createBoard(seedRng(seed), DEFAULT_CONFIG);
    maker.move('a', findAnyChain(board));

    maker.disconnect('a');
    fireTimers();

    // У «a» очки есть, у «b» нет — значит побеждает «a», хоть он и отключился.
    expect(b.last('finished')).toMatchObject({ outcome: 'loss', opponentScore: 30 });
  });

  it('осознанный выход по-прежнему засчитывает поражение', () => {
    const { maker } = make();
    const a = recorder('a');
    const b = recorder('b');
    maker.join(a);
    maker.join(b);

    maker.leave('a');
    expect(a.last('finished')).toMatchObject({ outcome: 'loss' });
    expect(b.last('finished')).toMatchObject({ outcome: 'win' });
  });
});

describe('призраки', () => {
  const ghost: Ghost = {
    name: 'Ада',
    seed: 777,
    score: 300,
    marks: ['p0', null, null],
    log: [
      { t: 1, points: 100 },
      { t: 2, points: 200 },
    ],
  };

  /** Матчмейкер с ручным управлением временем: таймеры срабатывают по команде. */
  function makeWithGhost(findGhost: () => Promise<Ghost | undefined>) {
    const timers: { fn: () => void; ms: number }[] = [];
    const onFinish = vi.fn();
    const maker = new Matchmaker({
      onFinish,
      findGhost,
      ghostAfterMs: 100,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
    });
    return {
      maker,
      onFinish,
      /** Срабатывает таймерами, чей срок не больше указанного. */
      fire: (upToMs: number) => {
        const due = timers.filter((timer) => timer.ms <= upToMs);
        due.forEach((timer) => {
          timers.splice(timers.indexOf(timer), 1);
          timer.fn();
        });
      },
      pending: () => timers.length,
    };
  }

  it('после ожидания подставляет призрака на его же поле', async () => {
    const { maker, fire } = makeWithGhost(async () => ghost);
    const player = recorder('p', 'Игрок');
    maker.join(player);
    expect(player.last('matched')).toBeUndefined();

    fire(100);
    await Promise.resolve();
    await Promise.resolve();

    const matched = player.last('matched') as { seed: number; opponent: string; ghost: boolean };
    expect(matched).toMatchObject({ seed: ghost.seed, opponent: 'Ада', ghost: true });
    // Запись носит корпус того, чья она: пустая полоса выглядела бы поломкой.
    expect(matched).toMatchObject({ opponentMarks: ghost.marks });
    expect(maker.stats).toEqual({ waiting: 0, duels: 1 });
  });

  it('призрак набирает очки по записанному темпу', async () => {
    const { maker, fire } = makeWithGhost(async () => ghost);
    const player = recorder('p');
    maker.join(player);
    fire(100);
    await Promise.resolve();
    await Promise.resolve();

    fire(1000);
    expect(player.last('opponent')).toEqual({ type: 'opponent', score: 100 });
    fire(2000);
    expect(player.last('opponent')).toEqual({ type: 'opponent', score: 300 });
  });

  it('живой соперник отменяет призрака', async () => {
    const findGhost = vi.fn(async () => ghost);
    const { maker, fire } = makeWithGhost(findGhost);
    const a = recorder('a', 'Ада');
    const b = recorder('b', 'Боб');

    maker.join(a);
    maker.join(b);
    fire(100);
    await Promise.resolve();

    expect(a.last('matched')).toMatchObject({ opponent: 'Боб', ghost: false });
    expect(maker.stats).toEqual({ waiting: 0, duels: 1 });
  });

  it('в приватную комнату призрак не приходит', async () => {
    const findGhost = vi.fn(async () => ghost);
    const { maker, fire } = makeWithGhost(findGhost);
    maker.join(recorder('a'), 'КОД123');
    fire(100);
    await Promise.resolve();
    expect(findGhost).not.toHaveBeenCalled();
  });

  it('без подходящей записи игрок продолжает ждать', async () => {
    const { maker, fire } = makeWithGhost(async () => undefined);
    const player = recorder('p');
    maker.join(player);
    fire(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(player.last('matched')).toBeUndefined();
    expect(maker.stats).toEqual({ waiting: 1, duels: 0 });
  });

  it('матч с призраком доигрывается и сохраняется без него', async () => {
    const { maker, fire, onFinish } = makeWithGhost(async () => ghost);
    const player = recorder('p', 'Игрок');
    maker.join(player);
    fire(100);
    await Promise.resolve();
    await Promise.resolve();

    fire((DUEL_SECONDS + 1) * 1000);
    expect(player.last('finished')).toBeDefined();
    const result = onFinish.mock.calls[0]![0] as MatchResult;
    // Призрак помечен, чтобы приложение не записало его как игрока.
    expect(result.players.filter((p) => p.ghost)).toHaveLength(1);
    expect(result.players.filter((p) => !p.ghost).map((p) => p.name)).toEqual(['Игрок']);
  });

  it('синтетический призрак укладывается в матч и набирает примерно заданное', () => {
    const synthetic = makeSyntheticGhost(1234, 800);
    expect(synthetic.log.length).toBeGreaterThan(3);
    expect(Math.max(...synthetic.log.map((point) => point.t))).toBeLessThanOrEqual(DUEL_SECONDS);
    // Раскладка по ходам не обязана попасть точно, но должна быть в разумных пределах.
    expect(synthetic.score).toBeGreaterThanOrEqual(800);
    expect(synthetic.score).toBeLessThan(800 + 200);
    // У «Эталона» корпус тоже помечен, и все шильдики существуют.
    expect(cleanMarks(synthetic.marks)).toEqual(synthetic.marks);
    expect(synthetic.marks.filter((id) => id !== null).length).toBe(MARK_SLOTS);
  });

  it('темп записи ложится в расписание начислений', () => {
    const schedule = ghostSchedule(ghost);
    expect(schedule).toEqual([
      { delayMs: 1000, points: 100 },
      { delayMs: 2000, points: 200 },
    ]);
  });
});

describe('заявка на цвет', () => {
  const cfg = DEFAULT_CONFIG;
  const seed = 4242;
  /** Секунда внутри окна заявки на первую фазу: окно открывает цикл. */
  const inWindow = cfg.phasePeriod + cfg.claimWindow / 2;
  /** Секунда внутри самой фазы — она идёт сразу за окном. */
  const inPhase = cfg.phasePeriod + cfg.claimWindow + 1;

  /** Цепочка заданной длины и цвета: обычный поиск в глубину по соседям. */
  function findChain(board: Board, length: number, color: number): Cell[] | null {
    const dirs = [-1, 0, 1];
    const path: Cell[] = [];
    const taken = new Set<string>();
    const key = (cell: Cell): string => `${cell.r},${cell.c}`;

    const walk = (cell: Cell): boolean => {
      path.push(cell);
      taken.add(key(cell));
      if (path.length === length) return true;
      for (const dr of dirs) {
        for (const dc of dirs) {
          if (dr === 0 && dc === 0) continue;
          const next: Cell = { r: cell.r + dr, c: cell.c + dc };
          if (taken.has(key(next))) continue;
          if (cellAt(board.grid, next)?.color !== color) continue;
          if (walk(next)) return true;
        }
      }
      path.pop();
      taken.delete(key(cell));
      return false;
    };

    for (let r = 0; r < cfg.rows; r++) {
      for (let c = 0; c < cfg.cols; c++) {
        if (cellAt(board.grid, { r, c })?.color !== color) continue;
        if (walk({ r, c })) return path;
        path.length = 0;
        taken.clear();
      }
    }
    return null;
  }

  /**
   * Расклад, на котором заявку видно: цвет, который фаза сама бы не
   * выбрала, и цепочка достаточной длины под него.
   */
  function layout(length: number): { seed: number; color: number; path: Cell[] } {
    for (let candidate = seed; candidate < seed + 200; candidate++) {
      const board = createBoard(seedRng(candidate), cfg);
      const own = phaseColorAt(candidate, inPhase, cfg)!;
      for (let color = 0; color < cfg.colors; color++) {
        if (color === own) continue;
        const path = findChain(board, length, color);
        if (path) return { seed: candidate, color, path };
      }
    }
    throw new Error('no layout found');
  }

  it('заявка красит фазу обоим игрокам', () => {
    const { seed: s, color, path } = layout(cfg.claimChainLength);
    const a = recorder('a');
    const b = recorder('b');
    const now = Date.now();
    const duel = new Duel(s, a, b, { now });

    const claimed = duel.applyMove('a', path, now + inWindow * 1000);
    expect(claimed.ok).toBe(true);
    // Заявку объявляют обоим — своя приходит тем же сообщением, что чужая.
    expect(a.last('claim')).toMatchObject({ cycle: 1, color, mine: true });
    expect(b.last('claim')).toMatchObject({ cycle: 1, color, mine: false });

    // Сопернику фаза досталась чужого цвета — и всё равно она его цвета:
    // заявка общая. Тот же ход без заявки множителя бы не получил.
    const board = createBoard(seedRng(s), cfg);
    const plain = applyMove(board, path, cfg, phaseColorAt(s, inPhase, cfg));
    if (typeof plain === 'string') throw new Error(plain);
    const scored = duel.applyMove('b', path, now + inPhase * 1000);
    expect(scored).toMatchObject({ ok: true, points: plain.points * cfg.phaseMultiplier });
  });

  it('короткая цепочка и цепочка вне окна заявкой не становятся', () => {
    const { seed: s, path } = layout(cfg.claimChainLength);
    const a = recorder('a');
    const duel = new Duel(s, a, recorder('b'), { now: 0 });

    // Вне окна — заявки нет.
    duel.applyMove('a', path, (inWindow - cfg.claimWindow) * 1000);
    expect(a.last('claim')).toBeUndefined();
    expect(duel.claimLog()).toHaveLength(0);

    // Короткая цепочка внутри окна — тоже нет.
    const short = findChain(createBoard(seedRng(s), cfg), cfg.claimChainLength - 1, 0);
    if (short) {
      duel.applyMove('a', short, inWindow * 1000);
      expect(duel.claimLog().every((claim) => claim.length >= cfg.claimChainLength)).toBe(true);
    }
  });

  it('снимок матча несёт заявки: вернувшийся видит тот же цвет', () => {
    const { seed: s, color, path } = layout(cfg.claimChainLength);
    const now = Date.now();
    const duel = new Duel(s, recorder('a'), recorder('b'), { now });
    duel.applyMove('a', path, now + inWindow * 1000);

    expect(duel.snapshot('a')?.claims).toEqual([
      expect.objectContaining({ cycle: 1, color, mine: true }),
    ]);
    expect(duel.snapshot('b')?.claims).toEqual([
      expect.objectContaining({ cycle: 1, color, mine: false }),
    ]);
  });
});
