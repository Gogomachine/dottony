import { paceSpread } from '@doton/core';
import type { MoveLog } from '@doton/protocol';
import { JUDGE_MIN_MOVES, PACE_LIMIT, SHARP_LIMIT } from './limits.js';
import type { SprintReplay } from './sprint.js';

/**
 * Похож ли заход на человеческий.
 *
 * Сервер переигрывает каждый заход ядром и потому знает, что ходы законны.
 * Здесь он смотрит на другое: как они сделаны. Мерок две, обе выведены
 * измерением (см. `judge.ts` ядра и пороги в `limits.ts`):
 *
 * - **острота** — человек не находит самой длинной цепочки, перебор находит
 *   её всегда;
 * - **ровность** — рука ведёт цепочки рывками, метроном шлёт ходы через
 *   одинаковые промежутки.
 *
 * Возвращает словами то, что заметил, — эти же слова увидит служащий.
 * Пустой список значит «ничего не заметил», а не «человек»: доказать
 * человечность прибор не умеет и не берётся.
 *
 * Заход при этом не отклоняется. Отклонять по догадке значило бы наказывать
 * сильную игру, а её-то как раз и растят.
 */
export function judgeRun(replay: SprintReplay, moves: readonly MoveLog[]): string[] {
  if (replay.moves < JUDGE_MIN_MOVES) return [];
  const noticed: string[] = [];

  if (replay.sharp >= SHARP_LIMIT) {
    noticed.push(`острота ${replay.sharp.toFixed(2)} на ${replay.moves} ходах`);
  }

  const spread = paceSpread(moves.map((move) => move.t));
  if (spread !== null && spread <= PACE_LIMIT) {
    noticed.push(`ровный темп, разброс ${spread.toFixed(3)}`);
  }

  return noticed;
}
