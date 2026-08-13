import {
  applyMove,
  applyTap,
  bestClaim,
  claimFrom,
  claimWindowAt,
  createBoard,
  orderAt,
  orderReward,
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
  type OrderState,
  type PhaseState,
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
  /** Закрыто заказов за заход и сколько окон подряд закрыто хотя бы одним. */
  ordersDone = 0;
  orderStreak = 0;
  /**
   * Сбои: окна, закрытые без единого заказа. Их запас и есть конец захода —
   * иначе заказы шли бы бесконечно и заход нечем было бы мерить.
   */
  orderFails = 0;
  /** Сколько заказов закрыто в текущем окне. */
  orderHits = 0;
  /** Номер окна, которое идёт сейчас; −1 — заход ещё не начинался. */
  orderCycle = -1;
  /** Чем кончилось прошлое окно: закрыто или упущено. */
  lastWindow: 'done' | 'missed' | null = null;
  /** Последний ход цветом окна: сколько снял и сколько за это дали. */
  lastFire: { size: number; reward: number } | null = null;
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
    this.syncOrder();
  }

  /** Окно заказа на текущей секунде; null — режим не тот. */
  order(): OrderState | null {
    return this.mode === 'order' ? orderAt(this.seed, this.elapsed, this.cfg) : null;
  }

  /**
   * Закрывает прошедшее окно и открывает новое. Считаем по окнам, а не по
   * ходам: промах внутри окна стоит пятна и времени, но окно ещё можно
   * вытянуть — а вот окно, закрытое пустым, уже сбой прибора.
   */
  private syncOrder(): void {
    const state = this.order();
    if (state === null || state.cycle === this.orderCycle) return;
    if (this.orderCycle >= 0) {
      const done = this.orderHits > 0;
      this.lastWindow = done ? 'done' : 'missed';
      this.orderStreak = done ? this.orderStreak + 1 : 0;
      if (!done) this.orderFails += 1;
      if (this.orderFails >= this.cfg.orderLives) this.over = true;
    }
    this.orderCycle = state.cycle;
    this.orderHits = 0;
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
    // Пока окно открыто, прибор притягивает свой цвет: досыпка отдаёт ему
    // вес против единицы у прочих. Без этого пятно до цели не дорастает.
    const window = this.order();
    const bias = window?.open ? window.color : null;
    return this.commit(applyTap(this.board, cell, this.cfg, this.phaseNow(), bias));
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

  /**
   * Цвет фазы на текущей секунде — с учётом уже поданных заявок. В заказах
   * фаз нет вовсе: там резонанс — само окно, и второй, со своим цветом и
   * множителем, только сбивал бы с толку.
   */
  private phaseNow(): Color | null {
    if (this.mode === 'order') return null;
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
    // В заказах счёт — это награды за закрытые заказы: потенциал обычного
    // хода там на два порядка крупнее и просто затопил бы их.
    if (this.mode === 'order') {
      this.fire(result);
      return result;
    }
    this.score += result.points;
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
   * Считает ход по заказу. В счёт идёт только сама группа: взрыв заряда
   * сносит что попало, и пускать его в заказ значило бы отдать решающий
   * ход лотерее. Ход чужого цвета или мимо цели не стоит ничего — линия
   * резкая, в ней вся ставка.
   */
  private fire(result: MoveResult): void {
    this.syncOrder();
    const window = this.order();
    if (window === null || !window.open || result.color !== window.color) {
      this.lastFire = null;
      return;
    }
    const size = result.removed.length;
    const reward = orderReward(size, this.cfg);
    this.lastFire = { size, reward };
    if (reward === 0) return;
    this.score += reward;
    this.ordersDone += 1;
    this.orderHits += 1;
  }

  /**
   * Пересчитывает время партии; возвращает true в момент её окончания.
   * Опирается на часы, а не на прошедшие кадры, — поэтому свёрнутая
   * вкладка или заблокированный экран не останавливают партию.
   */
  tick(_dtSeconds: number, now = Date.now()): boolean {
    if (this.over || this.pausedAt !== null || !this.startedYet) return false;
    this.elapsed = (now - this.startedAt) / 1000;
    this.syncOrder();
    // Заход заказов кончается не по часам, а по запасу сбоев.
    if (this.over) return true;
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
