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
  type Color,
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
  /**
   * Момент старта по стенным часам. Время партии считаем от него, а не
   * накоплением кадров: в свёрнутой вкладке кадры не идут, и таймер бы
   * «замерзал», расходясь с серверным.
   */
  private readonly startedAt = Date.now();
  private readonly duration: number;

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
    this.duration =
      mode === 'sprint' ? SPRINT_SECONDS : mode === 'duel' ? (duration ?? 90) : Infinity;
    this.timeLeft = this.duration;
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

  /**
   * Пересчитывает время партии; возвращает true в момент её окончания.
   * Опирается на часы, а не на прошедшие кадры, — поэтому свёрнутая
   * вкладка или заблокированный экран не останавливают партию.
   */
  tick(_dtSeconds: number, now = Date.now()): boolean {
    if (this.over) return false;
    this.elapsed = (now - this.startedAt) / 1000;
    if (!this.timed) return false;
    this.timeLeft = Math.max(0, this.duration - this.elapsed);
    if (this.timeLeft === 0) {
      this.over = true;
      return true;
    }
    return false;
  }

  /**
   * Принимает состояние матча от сервера после переподключения. Сервер —
   * источник истины, поэтому его поле и счёт замещают локальные: ходы,
   * не дошедшие из-за обрыва, не засчитаны и там.
   */
  restore(grid: { color: number; charged: boolean }[][], score: number, streak: number): void {
    this.board = {
      ...this.board,
      grid: grid.map((row) =>
        row.map((dot) => ({ color: dot.color as Color, charged: dot.charged })),
      ),
      surgeStreak: streak,
    };
    this.score = score;
  }

  /** Синхронизирует остаток времени с сервером после переподключения. */
  syncRemaining(remaining: number): void {
    this.timeLeft = Math.max(0, remaining);
    this.elapsed = this.duration - this.timeLeft;
    if (this.timeLeft === 0) this.over = true;
  }
}
