import { nextInt, seedRng } from './rng.js';
import type { Color, GameConfig } from './types.js';

/**
 * Заказ: прибор звенит случайным цветом и держит окно `orderWindow`
 * секунд, после чего сразу берёт следующий цвет. За окно нужно снять
 * `orderTarget` точек его цвета — и обязательно за один раз, одним
 * касанием.
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

function colorOfWindow(seed: number, cycle: number, cfg: GameConfig): Color {
  const roll = nextInt(seedRng((seed ^ Math.imul(cycle + 1, 0x85ebca6b)) >>> 0), cfg.colors);
  return roll.value as Color;
}

/**
 * Окна идут подряд, без передышки: прибор звенит всегда, меняется только
 * цвет. Пауза между ними была временем на подготовку — и оказалась
 * временем, когда играть незачем.
 */
export function orderAt(seed: number, timeSec: number, cfg: GameConfig): OrderState {
  const cycle = Math.floor(timeSec / cfg.orderWindow);
  return {
    color: colorOfWindow(seed, cycle, cfg),
    remaining: (cycle + 1) * cfg.orderWindow - timeSec,
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
