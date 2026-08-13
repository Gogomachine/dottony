import { nextInt, seedRng } from './rng.js';
import type { Color, GameConfig } from './types.js';

/**
 * Заказ: прибор входит в резонанс со случайным цветом и держит окно
 * `orderWindow` секунд. За это время нужно снять `orderTarget` точек этого
 * цвета — и обязательно за один раз, одним касанием.
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
  /** Цвет окна; в паузе — цвет следующего окна. */
  color: Color;
  /** Открыто ли окно прямо сейчас. */
  open: boolean;
  /** Секунды до конца окна или, в паузе, до начала следующего. */
  remaining: number;
  /** Номер окна с начала захода; в паузе — уже следующего. */
  cycle: number;
}

function colorOfWindow(seed: number, cycle: number, cfg: GameConfig): Color {
  const roll = nextInt(seedRng((seed ^ Math.imul(cycle + 1, 0x85ebca6b)) >>> 0), cfg.colors);
  return roll.value as Color;
}

export function orderAt(seed: number, timeSec: number, cfg: GameConfig): OrderState {
  const period = cfg.orderWindow + cfg.orderBreak;
  const passed = Math.floor(timeSec / period);
  const within = timeSec - passed * period;
  const open = within < cfg.orderWindow;
  // В паузе прибор уже называет следующий цвет: пауза для того и нужна —
  // успеть посмотреть на поле и решить, с чего начинать.
  const cycle = open ? passed : passed + 1;
  return {
    color: colorOfWindow(seed, cycle, cfg),
    open,
    remaining: open ? cfg.orderWindow - within : period - within,
    cycle,
  };
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
