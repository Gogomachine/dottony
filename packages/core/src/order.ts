import { createBoard } from './board.js';
import { applyTap } from './move.js';
import { nextInt, seedRng } from './rng.js';
import type { Board, Cell, Color, GameConfig, MoveError, MoveResult } from './types.js';

/**
 * Заказ: прибор звенит случайным цветом и держит окно `orderWindow`
 * секунд. За окно нужно снять `orderTarget` точек его цвета — и
 * обязательно за один раз, одним касанием.
 *
 * Окно кончается двумя способами, и оба сразу открывают следующее, с
 * новым цветом и полным отсчётом: время вышло — сбой, заказ закрыт —
 * успех. Тянуть закрытое окно незачем: цвет уже отработан.
 *
 * Смысл механики в том, что размер группы задаёт поле, а не игрок: пятно
 * нужного цвета выращивают, разбирая всё вокруг, а сколько в нём точек на
 * самом деле — до касания не сосчитать. Может оказаться двадцать четыре, и
 * тогда всё уйдёт впустую. В этом и интрига.
 *
 * Пока окно открыто, прибор притягивает свой цвет: досыпка отдаёт ему вес
 * `orderWeight` против единицы у каждого из прочих. Без притяжения пятно
 * упирается в два десятка точек, и цель была бы не задачей, а лотереей
 * расклада — с ним медиана достижимого встаёт ровно на цель.
 *
 * Всё выводится из сида и секунды партии, как и фазы: одинаковый заход
 * даёт одинаковые окна.
 */

export interface OrderState {
  /** Цвет, которым прибор звенит сейчас. */
  color: Color;
  /** Секунды до конца окна. */
  remaining: number;
  /** Номер окна с начала захода. */
  cycle: number;
}

function roll(seed: number, cycle: number, sides: number): number {
  return nextInt(seedRng((seed ^ Math.imul(cycle + 1, 0x85ebca6b)) >>> 0), sides).value;
}

/**
 * Цвет окна номер `cycle` — из сида, но никогда не тот, что был в
 * предыдущем: смена цвета и есть знак, что окно кончилось. Повторись он —
 * закрытый заказ выглядел бы как незакрытый.
 *
 * Поэтому цвет — цепочка от окна к окну, а не функция одного номера, и
 * ведёт её партия. По сиду она всё равно воспроизводима.
 */
export function nextOrderColor(
  seed: number,
  cycle: number,
  previous: Color | null,
  cfg: GameConfig,
): Color {
  if (previous === null) return roll(seed, cycle, cfg.colors) as Color;
  return ((previous + 1 + roll(seed, cycle, cfg.colors - 1)) % cfg.colors) as Color;
}

/**
 * Награда за снятую группу: ровно в цель стоит `orderReward`, и каждая
 * точка сверх цели — столько же ещё. Недобор не стоит ничего: линия
 * резкая, иначе исчезает вся ставка хода.
 */
export function orderReward(size: number, cfg: GameConfig): number {
  if (size < cfg.orderTarget) return 0;
  return cfg.orderReward * (size - cfg.orderTarget + 1);
}

/**
 * Состояние захода целиком. Живёт в ядре, а не у клиента, потому что счёт
 * заказов идёт в общую таблицу: сервер переигрывает присланный журнал
 * ходов этим же кодом и получает то же число. Разъедься копии — разъехались
 * бы и правила приёма рекорда.
 */
export interface OrderRun {
  readonly seed: number;
  board: Board;
  /** Цвет текущего окна и его номер. */
  color: Color;
  cycle: number;
  /** Секунда захода, с которой пошло текущее окно. */
  since: number;
  score: number;
  /** Закрыто заказов и сколько окон подряд закрыто. */
  orders: number;
  streak: number;
  /** Упущено окон; на `orderLives` заход кончается. */
  fails: number;
  over: boolean;
  /** Чем кончилось прошлое окно; null — первое ещё идёт. */
  lastWindow: 'done' | 'missed' | null;
}

/** Итог хода для заказа: сколько сняли цветом окна и сколько за это дали. */
export interface OrderFire {
  size: number;
  reward: number;
}

export function startOrder(seed: number, cfg: GameConfig): OrderRun {
  return {
    seed,
    board: createBoard(seedRng(seed), cfg),
    color: nextOrderColor(seed, 0, null, cfg),
    cycle: 0,
    since: 0,
    score: 0,
    orders: 0,
    streak: 0,
    fails: 0,
    over: false,
    lastWindow: null,
  };
}

/** Что показывать про окно на секунде `timeSec`. */
export function orderWindow(run: OrderRun, timeSec: number, cfg: GameConfig): OrderState {
  return {
    color: run.color,
    cycle: run.cycle,
    remaining: run.since + cfg.orderWindow - timeSec,
  };
}

/** Закрывает окно и открывает следующее — с новым цветом и от секунды `at`. */
function closeWindow(run: OrderRun, done: boolean, at: number, cfg: GameConfig): OrderRun {
  const fails = done ? run.fails : run.fails + 1;
  const streak = done ? run.streak + 1 : 0;
  const lastWindow = done ? 'done' : 'missed';
  // Запас кончился — заход тоже: следующего окна уже не будет.
  if (fails >= cfg.orderLives) return { ...run, fails, streak, lastWindow, over: true };
  const cycle = run.cycle + 1;
  return {
    ...run,
    fails,
    streak,
    lastWindow,
    cycle,
    since: at,
    color: nextOrderColor(run.seed, cycle, run.color, cfg),
  };
}

/**
 * Доводит заход до секунды `timeSec`: каждое просроченное окно — свой сбой.
 *
 * Новое окно начинается от границы прошлого, а не от текущей секунды.
 * Только так клиент, считающий кадрами, и сервер, считающий по журналу
 * ходов, приходят к одним и тем же окнам.
 */
export function tickOrder(run: OrderRun, timeSec: number, cfg: GameConfig): OrderRun {
  let next = run;
  while (!next.over && timeSec >= next.since + cfg.orderWindow) {
    next = closeWindow(next, false, next.since + cfg.orderWindow, cfg);
  }
  return next;
}

export interface OrderTap {
  run: OrderRun;
  move: MoveResult;
  /** null — ход был не цветом окна и заказа не касается. */
  fire: OrderFire | null;
}

/**
 * Ход касанием в секунду `timeSec`. Сначала догоняет окна, потом снимает
 * группу; заказ в цель закрывает окно и сразу открывает следующее.
 *
 * Ход после конца захода отклоняется: в мёртвом заходе ходов не бывает.
 */
export function tapOrder(
  run: OrderRun,
  cell: Cell,
  timeSec: number,
  cfg: GameConfig,
): OrderTap | MoveError {
  const now = tickOrder(run, timeSec, cfg);
  if (now.over) return 'too-short';

  // Фаз в заказах нет — резонанс здесь сам заказ; зато его цвет притянут
  // досыпкой, и это часть правила, а не украшение.
  const move = applyTap(now.board, cell, cfg, null, now.color);
  if (typeof move === 'string') return move;

  const fire: OrderFire | null =
    move.color === now.color
      ? { size: move.removed.length, reward: orderReward(move.removed.length, cfg) }
      : null;

  let next: OrderRun = { ...now, board: move.board };
  if (fire !== null && fire.reward > 0) {
    next = closeWindow(
      { ...next, score: next.score + fire.reward, orders: next.orders + 1 },
      true,
      timeSec,
      cfg,
    );
  }
  return { run: next, move, fire };
}
