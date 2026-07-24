import { createHash } from 'node:crypto';
import {
  applyMove,
  createBoard,
  phaseColorAt,
  seedRng,
  DEFAULT_CONFIG,
  type Board,
} from '@doton/core';
import type { MoveLog } from '@doton/protocol';

/** Длительность ежедневного забега, сек (Спринт). */
export const DAILY_SECONDS = 180;

/** Минимальный интервал между ходами: человек физически не жмёт чаще. */
const MIN_MOVE_GAP = 0.1;

/** Сегодняшняя дата по UTC — один день, один сид на всех. */
export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Сид дня: хеш секрета и даты. Секрет нужен, чтобы сид нельзя было
 * вычислить заранее и отрепетировать завтрашнее поле.
 */
export function dailySeed(date: string, secret: string): number {
  return createHash('sha256').update(`${secret}:${date}`).digest().readUInt32BE(0);
}

export type ReplayError =
  | 'bad-timing'
  | 'invalid-move'
  | 'too-long';

/**
 * Прогоняет присланный лог ходов через ядро и возвращает честный счёт.
 * Клиентскому счёту сервер не верит никогда.
 */
export function replayDaily(seed: number, moves: MoveLog[]): { score: number } | ReplayError {
  const cfg = DEFAULT_CONFIG;
  let board: Board = createBoard(seedRng(seed), cfg);
  let score = 0;
  let prevT = -Infinity;

  for (const move of moves) {
    if (move.t > DAILY_SECONDS) return 'too-long';
    if (move.t < prevT + MIN_MOVE_GAP) return 'bad-timing';
    prevT = move.t;

    const phase = phaseColorAt(seed, move.t, cfg);
    const result = applyMove(board, move.path, cfg, phase);
    if (typeof result === 'string') return 'invalid-move';
    board = result.board;
    score += result.points;
  }

  return { score };
}
