import { describe, expect, it, vi } from 'vitest';
import {
  applyMove,
  cellAt,
  createBoard,
  phaseColorAt,
  seedRng,
  DEFAULT_CONFIG,
  type Board,
  type Cell,
} from '@doton/core';
import { DUEL_SECONDS, type DuelServerMessage } from '@doton/protocol';
import { Duel, type DuelPlayer } from './duel.js';
import { Matchmaker } from './matchmaker.js';

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

  it('засчитывает ход и сообщает счёт сопернику', () => {
    const a = recorder('a');
    const b = recorder('b');
    const duel = new Duel(seed, a, b);
    const board = createBoard(seedRng(seed), DEFAULT_CONFIG);
    const path = findAnyChain(board);

    const outcome = duel.applyMove('a', path, 1);
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
    const phaseTime = DEFAULT_CONFIG.phasePeriod + 1;
    const phase = phaseColorAt(seed, phaseTime, DEFAULT_CONFIG);
    const expected = applyMove(board, path, DEFAULT_CONFIG, phase);
    if (typeof expected === 'string') throw new Error(expected);

    const outcome = duel.applyMove('a', path, 0, now + phaseTime * 1000);
    expect(outcome).toMatchObject({ ok: true, points: expected.points });
  });

  it('отклоняет нелегальный ход', () => {
    const duel = new Duel(seed, recorder('a'), recorder('b'));
    const outcome = duel.applyMove(
      'a',
      [{ r: 0, c: 0 }, { r: 5, c: 5 }, { r: 0, c: 1 }],
      1,
    );
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

    expect(duel.applyMove('a', first, 1, now + 1000).ok).toBe(true);
    // Второй ход спустя 10 мс — быстрее, чем возможно вручную.
    const second = findAnyChain(board);
    expect(duel.applyMove('a', second, 1, now + 1010)).toMatchObject({
      ok: false,
      reason: 'too-fast',
    });
  });

  it('не принимает ходы после сирены', () => {
    const now = Date.now();
    const duel = new Duel(seed, recorder('a'), recorder('b'), { now });
    const board = createBoard(seedRng(seed), DEFAULT_CONFIG);
    const path = findAnyChain(board);
    expect(duel.applyMove('a', path, 1, now + (DUEL_SECONDS + 2) * 1000)).toMatchObject({
      ok: false,
      reason: 'duel-over',
    });
  });

  it('объявляет победителя, проигравшего и ничью', () => {
    const a = recorder('a');
    const b = recorder('b');
    const duel = new Duel(seed, a, b);
    const board = createBoard(seedRng(seed), DEFAULT_CONFIG);
    duel.applyMove('a', findAnyChain(board), 1);
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
    duel.applyMove('a', findAnyChain(board), 1);

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
    expect(maker.move('nobody', [], 1)).toMatchObject({ ok: false, reason: 'not-in-duel' });
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
