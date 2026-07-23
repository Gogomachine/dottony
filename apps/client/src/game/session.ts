import {
  applyMove,
  createBoard,
  seedRng,
  DEFAULT_CONFIG,
  type Board,
  type Cell,
  type GameConfig,
  type MoveError,
  type MoveResult,
} from '@doton/core';

export type Mode = 'sprint' | 'free';

export const SPRINT_SECONDS = 180;

/**
 * Состояние одной партии. Правила целиком в @doton/core —
 * сессия только держит поле, счёт и таймер.
 */
export class Session {
  readonly cfg: GameConfig = DEFAULT_CONFIG;
  readonly seed: number;
  readonly mode: Mode;
  board: Board;
  score = 0;
  timeLeft: number;
  over = false;

  constructor(seed: number, mode: Mode) {
    this.seed = seed;
    this.mode = mode;
    this.board = createBoard(seedRng(seed), this.cfg);
    this.timeLeft = mode === 'sprint' ? SPRINT_SECONDS : Infinity;
  }

  tryMove(path: Cell[]): MoveResult | MoveError {
    if (this.over) return 'too-short';
    const result = applyMove(this.board, path, this.cfg);
    if (typeof result === 'string') return result;
    this.board = result.board;
    this.score += result.points;
    return result;
  }

  /** Тик таймера; возвращает true в момент окончания партии. */
  tick(dtSeconds: number): boolean {
    if (this.over || this.mode !== 'sprint') return false;
    this.timeLeft = Math.max(0, this.timeLeft - dtSeconds);
    if (this.timeLeft === 0) {
      this.over = true;
      return true;
    }
    return false;
  }
}
