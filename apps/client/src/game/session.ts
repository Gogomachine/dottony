import {
  applyMove,
  applyTap,
  bestClaim,
  claimFrom,
  claimWindowAt,
  createBoard,
  fillOrder,
  nextOrder,
  phaseColorAt,
  phaseStateAt,
  seedRng,
  DEFAULT_CONFIG,
  SPRINT_SECONDS,
  type Board,
  type Cell,
  type Claim,
  type ClaimWindow,
  type GameConfig,
  type MoveError,
  type MoveResult,
  type Order,
  type OrderStep,
  type PhaseState,
  type RngState,
  type Color,
} from '@doton/core';

export type Mode = 'sprint' | 'free' | 'duel' | 'order';

// Длительность спринта задаёт ядро — клиент и сервер меряют заход одним
// числом. Переэкспорт, чтобы экран не лез в ядро за одной константой.
export { SPRINT_SECONDS };

/**
 * Ошибки ядра плюс отказ самой сессии: ход в стоп-кадре ядро бы принял,
 * но партия в этот момент стоит.
 */
export type SessionMoveError = MoveError | 'paused';

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
  /**
   * Текущий заказ прибора и сколько его цвета уже снято. Живёт только в
   * режиме заказов; в остальных — null, и ходы его не касаются.
   */
  order: Order | null = null;
  orderTaken = 0;
  /** Закрыто заказов за заход и сколько из них подряд, без срыва. */
  ordersDone = 0;
  orderStreak = 0;
  /** Чем последний ход кончился для заказа — для отчёта на экране. */
  lastOrder: OrderStep = 'idle';
  /**
   * Заказы идут своим потоком случайных чисел. Брать их из поля нельзя:
   * тот же поток раздаёт новые точки, и заказ сдвигал бы расклад.
   */
  private orderRng: RngState;
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
    // Свой сид, но выведенный из общего: по номеру образца заказы
    // повторяются, а расклад поля от них не зависит.
    this.orderRng = seedRng(seed ^ 0x9e3779b9);
    if (mode === 'order') this.drawOrder();
  }

  /** Берёт следующий заказ и обнуляет прогресс по нему. */
  private drawOrder(): void {
    const drawn = nextOrder(this.orderRng, this.cfg);
    this.orderRng = drawn.state;
    this.order = drawn.order;
    this.orderTaken = 0;
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
    const stop = this.blocked();
    if (stop) return stop;
    return this.commit(applyMove(this.board, path, this.cfg, this.phaseNow()));
  }

  /**
   * Ход одним касанием: снимается вся группа под нажатой точкой. Опыт
   * включается флагом ядра, поэтому экран зовёт этот путь только когда
   * ввод и правила согласованы.
   */
  tryTap(cell: Cell): MoveResult | SessionMoveError {
    const stop = this.blocked();
    if (stop) return stop;
    return this.commit(applyTap(this.board, cell, this.cfg, this.phaseNow()));
  }

  /** Почему партия не примет ход прямо сейчас; null — примет. */
  private blocked(): SessionMoveError | null {
    if (this.over) return 'too-short';
    // Стоп-кадр останавливает партию, а не только часы. Иначе в замершем
    // времени можно было бы спокойно собирать цепочки: фаза не меняется,
    // время не тает, а потенциал капает — это уже не наблюдение.
    if (this.paused) return 'paused';
    return null;
  }

  /** Цвет фазы на текущей секунде — с учётом уже поданных заявок. */
  private phaseNow(): Color | null {
    return phaseColorAt(this.seed, this.elapsed, this.cfg, this.claims);
  }

  /**
   * Общий хвост хода: счёт и заявка на цвет. Цепочка и касание отличаются
   * только тем, что попало в ядро, — дальше всё одинаково, и длину для
   * заявки обе берут из одного места: снятых точек хода.
   */
  private commit(result: MoveResult | MoveError): MoveResult | SessionMoveError {
    if (typeof result === 'string') return result;
    this.board = result.board;
    this.score += result.points;
    this.fill(result);
    // Заявку на цвет в дуэли объявляет сервер: окно там решают его часы,
    // и ход у самой границы окна иначе разошёлся бы с сервером. В
    // одиночных режимах считать некому — считаем сами.
    if (this.mode !== 'duel') {
      // Время округляем как в журнале ходов: сервер переигрывает заход по
      // журналу и должен попасть в то же окно, что и клиент.
      const claim = claimFrom(
        result.color,
        result.removed.length,
        Number(this.elapsed.toFixed(3)),
        this.cfg,
      );
      if (claim) this.claims.push({ ...claim, mine: true });
    }
    return result;
  }

  /**
   * Засчитывает ход в заказ. Закрытый заказ и сорванный одинаково ведут к
   * следующему: партия в этом режиме не кончается, кончается заказ — и
   * разница между ними только в серии.
   */
  private fill(result: MoveResult): void {
    const order = this.order;
    if (!order) return;
    const step = fillOrder(order, this.orderTaken, result, this.cfg);
    this.orderTaken = step.taken;
    this.lastOrder = step.step;
    if (step.step === 'done') {
      this.ordersDone += 1;
      this.orderStreak += 1;
      this.drawOrder();
    } else if (step.step === 'over' || step.step === 'stuck') {
      this.orderStreak = 0;
      this.drawOrder();
    }
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
