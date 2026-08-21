import { randomInt } from 'node:crypto';
import { DUEL_SECONDS } from '@doton/protocol';
import type { ScorePoint } from './duel.js';

/**
 * Призрак — записанная попытка вместо живого соперника.
 *
 * Матч с призраком идёт на сиде его записи: поле у живого игрока ровно то,
 * которое проходил призрак, поэтому условия равные, а не «похожие».
 * Игроку всегда честно сообщается, что соперник — запись.
 */

export interface Ghost {
  name: string;
  seed: number;
  score: number;
  /** Когда и сколько очков набирал соперник. */
  log: ScorePoint[];
  /** Корпус того, чья это запись: на время матча он занимает корпус игрока. */
  marks: (string | null)[];
}

/** Пока настоящих записей нет, соперника отыгрывает «Эталон» — образцовый прибор. */
const SYNTHETIC_NAME = 'Эталон';

/**
 * Корпус «Эталона»: отметки за игру под стать образцовому прибору — серия,
 * крупная группа, сотня дуэлей. Наклеек он не носит: покупать их некому, да
 * и не за что — жетонов у записи нет. Своего выбора у него нет и быть не
 * может, поэтому набор задан здесь намертво; проверяет его тест, а не сервер.
 */
const SYNTHETIC_MARKS: (string | null)[] = ['e-run', 'e-big', 'e-duels'];

/**
 * Синтетический призрак: раскладывает целевой счёт на ходы с человеческим
 * ритмом. Нужен на старте, когда играть ещё не с кем и записей нет.
 */
export function makeSyntheticGhost(
  seed: number,
  targetScore: number,
  seconds: number = DUEL_SECONDS.chain,
): Ghost {
  const log: ScorePoint[] = [];
  let t = randomInt(1, 4);
  let total = 0;

  while (t < seconds - 2 && total < targetScore) {
    // Средний ход — цепочка из 3–5 точек, иногда с множителем.
    const points = [30, 30, 60, 60, 100, 150][randomInt(0, 6)]!;
    log.push({ t: Number(t.toFixed(2)), points });
    total += points;
    // Пауза между ходами: люди не жмут равномерно.
    t += 1.4 + randomInt(0, 16) / 10;
  }

  return { name: SYNTHETIC_NAME, seed, score: total, log, marks: [...SYNTHETIC_MARKS] };
}

/** Средний счёт для синтетического соперника, если статистики ещё нет. */
export const DEFAULT_GHOST_SCORE = 900;

export interface GhostSchedule {
  /** Через сколько миллисекунд начислить очередную порцию очков. */
  delayMs: number;
  points: number;
}

/** Превращает запись в расписание начислений от начала матча. */
export function ghostSchedule(ghost: Ghost, seconds: number = DUEL_SECONDS.chain): GhostSchedule[] {
  return ghost.log
    .filter((point) => point.t <= seconds)
    .map((point) => ({ delayMs: Math.max(0, point.t * 1000), points: point.points }));
}
