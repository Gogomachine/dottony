import {
  applyMove,
  createBoard,
  phaseColorAt,
  phaseStateAt,
  seedRng,
  DEFAULT_CONFIG,
  type Board,
  type Cell,
  type GameConfig,
  type MoveError,
  type MoveResult,
  type PhaseState,
} from '@doton/core';

export type Mode = 'sprint' | 'free' | 'duel';

export const SPRINT_SECONDS = 180;

/**
 * Состояние одной партии. Правила целиком в @doton/core —
 * сессия только держит поле, счёт и время.
 */
export class Session {
  readonly seed: number;
  readonly mode: Mode;
  board: Board;
  score = 0;
  timeLeft: number;
  /** Секунды с начала партии — ритм фаз «нагрузки сети». */
  elapsed = 0;
  over = false;

  constructor(
    seed: number,
    mode: Mode,
    readonly cfg: GameConfig = DEFAULT_CONFIG,
    /** Длительность матча для режима дуэли. */
    duration?: number,
  ) {
    this.seed = seed;
    this.mode = mode;
    this.board = createBoard(seedRng(seed), cfg);
    this.timeLeft =
      mode === 'sprint' ? SPRINT_SECONDS : mode === 'duel' ? (duration ?? 90) : Infinity;
  }

  /** Партия идёт на время. */
  get timed(): boolean {
    return this.mode === 'sprint' || this.mode === 'duel';
  }

  phase(): PhaseState {
    return phaseStateAt(this.seed, this.elapsed, this.cfg);
  }

  tryMove(path: Cell[]): MoveResult | MoveError {
    if (this.over) return 'too-short';
    const phaseColor = phaseColorAt(this.seed, this.elapsed, this.cfg);
    const result = applyMove(this.board, path, this.cfg, phaseColor);
    if (typeof result === 'string') return result;
    this.board = result.board;
    this.score += result.points;
    return result;
  }

  /** Тик времени; возвращает true в момент окончания партии. */
  tick(dtSeconds: number): boolean {
    if (this.over) return false;
    this.elapsed += dtSeconds;
    if (!this.timed) return false;
    this.timeLeft = Math.max(0, this.timeLeft - dtSeconds);
    if (this.timeLeft === 0) {
      this.over = true;
      return true;
    }
    return false;
  }
}
