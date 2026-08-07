import {
  applyMove,
  bestClaim,
  claimFrom,
  claimWindowAt,
  createBoard,
  phaseColorAt,
  phaseStateAt,
  seedRng,
  DEFAULT_CONFIG,
  type Board,
  type Cell,
  type Claim,
  type ClaimWindow,
  type GameConfig,
  type MoveError,
  type MoveResult,
  type PhaseState,
  type Color,
} from '@doton/core';

export type Mode = 'sprint' | 'free' | 'duel';

/**
 * Ошибки ядра плюс отказ самой сессии: ход в стоп-кадре ядро бы принял,
 * но партия в этот момент стоит.
 */
export type SessionMoveError = MoveError | 'paused';

export const SPRINT_SECONDS = 180;

/** Заявка с пометкой, чья она: правилу это безразлично, показу — нет. */
export interface SessionClaim extends Claim {
  mine: boolean;
}

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
  /**
   * Заявки на цвет: свои — от собственных ходов, чужие приходят по сети.
   * Держим их списком, а не одним цветом на цикл, потому что победителя
   * решает сравнение, и заявка соперника может прийти после твоей.
   */
  private readonly claims: SessionClaim[] = [];
  over = false;
  /**
   * Момент старта по стенным часам. Время партии считаем от него, а не
   * накоплением кадров: в свёрнутой вкладке кадры не идут, и таймер бы
   * «замерзал», расходясь с серверным.
   */
  private startedAt = Date.now();
  /** Момент постановки на паузу; null — партия идёт. */
  private pausedAt: number | null = null;
  /**
   * Партия создана, но часы ещё не пущены: ждём первого касания. Иначе
   * время утекало бы, пока игрок разглядывает свежий образец. В дуэли
   * так нельзя — там время общее с соперником, и его пускает сервер.
   */
  private startedYet = false;
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
    return phaseStateAt(this.seed, this.elapsed, this.cfg, this.claims);
  }

  /** Идёт ли сейчас окно заявки и сколько его осталось. */
  claimWindow(): ClaimWindow {
    return claimWindowAt(this.elapsed, this.cfg);
  }

  /** Кто ведёт в заявке на ближайшую фазу; null — заявок не было. */
  leader(): SessionClaim | null {
    return bestClaim(this.claims, this.claimWindow().cycle);
  }

  /**
   * Заявка, объявленная сервером, — своя или соперника. Поля она не
   * трогает: меняет только цвет будущей фазы, общий у обоих.
   */
  addClaim(claim: Claim, mine: boolean): void {
    this.claims.push({ ...claim, mine });
  }

  /** Замещает список заявок целиком: возвращение в матч и реплей. */
  setClaims(claims: SessionClaim[]): void {
    this.claims.length = 0;
    this.claims.push(...claims);
  }

  tryMove(path: Cell[]): MoveResult | SessionMoveError {
    if (this.over) return 'too-short';
    // Стоп-кадр останавливает партию, а не только часы. Иначе в замершем
    // времени можно было бы спокойно собирать цепочки: фаза не меняется,
    // остаток не тает, а очки капают — это уже не наблюдение.
    if (this.paused) return 'paused';
    const phaseColor = phaseColorAt(this.seed, this.elapsed, this.cfg, this.claims);
    const result = applyMove(this.board, path, this.cfg, phaseColor);
    if (typeof result === 'string') return result;
    this.board = result.board;
    this.score += result.points;
    // Заявку на цвет в дуэли объявляет сервер: окно там решают его часы,
    // и ход у самой границы окна иначе разошёлся бы с сервером. В
    // одиночных режимах считать некому — считаем сами.
    if (this.mode !== 'duel') {
      // Время округляем как в журнале ходов: сервер переигрывает заход по
      // журналу и должен попасть в то же окно, что и клиент.
      const claim = claimFrom(result.color, path.length, Number(this.elapsed.toFixed(3)), this.cfg);
      if (claim) this.claims.push({ ...claim, mine: true });
    }
    return result;
  }

  /**
   * Пересчитывает время партии; возвращает true в момент её окончания.
   * Опирается на часы, а не на прошедшие кадры, — поэтому свёрнутая
   * вкладка или заблокированный экран не останавливают партию.
   */
  tick(_dtSeconds: number, now = Date.now()): boolean {
    if (this.over || this.pausedAt !== null || !this.startedYet) return false;
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

  /** Пускает часы. Первое касание поля, а в дуэли — сообщение сервера. */
  begin(now = Date.now()): void {
    if (this.startedYet) return;
    this.startedYet = true;
    this.startedAt = now;
  }

  get started(): boolean {
    return this.startedYet;
  }

  /**
   * Пауза сдвигает начало партии вперёд на время простоя — часы идут, а
   * партия нет. Разрешать её можно не везде: в дуэли время общее, а в
   * вызове дня остановка дала бы фору перед остальными.
   */
  pause(now = Date.now()): void {
    if (this.pausedAt !== null || this.over) return;
    this.pausedAt = now;
  }

  resume(now = Date.now()): void {
    if (this.pausedAt === null) return;
    this.startedAt += now - this.pausedAt;
    this.pausedAt = null;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  /**
   * Ставит время партии в заданную секунду. Нужно реплею: там ритм задаёт
   * запись, а не часы, и фазы «нагрузки сети» должны совпасть с исходными.
   */
  seek(t: number): void {
    this.elapsed = t;
    if (this.timed) this.timeLeft = Math.max(0, this.duration - t);
  }

  /** Синхронизирует остаток времени с сервером после переподключения. */
  syncRemaining(remaining: number): void {
    this.timeLeft = Math.max(0, remaining);
    this.elapsed = this.duration - this.timeLeft;
    if (this.timeLeft === 0) this.over = true;
  }
}
