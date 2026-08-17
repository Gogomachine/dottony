import {
  applyMove,
  bestClaim,
  cellAt,
  claimWindowAt,
  createBoard,
  phaseStateAt,
  seedRng,
  DEFAULT_CONFIG,
  type Board,
  type Cell,
  type Claim,
  type Color,
} from '@doton/core';
import { miniState, type MiniState } from './game/mini';
import type { Renderer } from './game/renderer';

/**
 * Обучение — не текст с картинками, а сама игра, которая играет сама в
 * себя. Поле, приборная строка и экранчик настоящие: механику показывает
 * тот же рендерер и то же ядро, что и в бою, поэтому объяснение не может
 * разойтись с правилами.
 *
 * Расклад под каждый шаг рисуется поверх обычного поля (paint): сценарий
 * не должен зависеть от того, повезло ли с образцом.
 */

const cfg = DEFAULT_CONFIG;

/** Секунд на переход пальца между соседними точками. */
const STEP = 0.17;
/** То же в спешке — в окне заявки время дорого. */
const STEP_FAST = 0.1;

/** Длительность дуэли: в шаге про заявку часы идут по её отсчёту. */
const DUEL = 90;

interface Point {
  x: number;
  y: number;
}

/** Куда обучение пишет показания. Всё это — обычные приборы клиента. */
export interface TutorialHud {
  /** Потенциал и серия зарядов рядом с ним. */
  score(value: number, streak: number): void;
  /** Правое поле приборной строки. */
  time(label: string, value: string): void;
  /** Шкала времени вдоль верхнего края окуляра, 0…1. */
  ticks(left: number): void;
  /** Поле соперника; null — спрятать. */
  versus(name: string, score: number): void;
  hideVersus(): void;
  stat(text: string, kind: '' | 'live' | 'warn'): void;
  mini(state: MiniState): void;
  /** Кайма окуляра в цвете заявки. */
  tint(color: Color | null): void;
  /** Вспышка экранчика: заявку перебили. */
  flash(): void;
  /** Счётчик цепочки в углу окуляра. */
  chain(length: number): void;
  /** Всплывающая цифра над ходом. */
  points(points: number, multiplier: number, at: Point): void;
  /** Палец сценария; null — убрать. */
  finger(at: Point | null): void;
  /** Подпись под окуляром. */
  caption(step: number, total: number, title: string, text: string): void;
  /** Сценарий кончился или прерван. */
  finish(): void;
}

/** Прерывание сценария: обучение закрыли на середине. */
const HALT = Symbol('halt');

const STEPS = 6;

export class Tutorial {
  active = false;
  board: Board = createBoard(seedRng(1), cfg);
  chain: Cell[] = [];
  pointer: Point | null = null;
  /** Активный цвет резонанса — рендерер рисует по нему ореолы. */
  phaseColor: Color | null = null;

  private score = 0;
  private stopped = false;
  private clock = 0;
  private clockRuns = false;
  private readonly claims: (Claim & { mine: boolean })[] = [];
  private readonly seed = 20_260;
  private timers: { left: number; go: () => void }[] = [];
  private tween: { from: Point; to: Point; passed: number; total: number; go: () => void } | null =
    null;

  constructor(
    private readonly renderer: Renderer,
    private readonly hud: TutorialHud,
  ) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.stopped = false;
    this.score = 0;
    this.claims.length = 0;
    this.clock = 0;
    this.clockRuns = false;
    this.phaseColor = null;
    void this.run().catch((error: unknown) => {
      if (error !== HALT) throw error;
    });
  }

  /** Закрывает обучение: и по кнопке, и в самом конце сценария. */
  stop(): void {
    if (!this.active) return;
    this.stopped = true;
    this.active = false;
    this.clockRuns = false;
    this.chain = [];
    this.pointer = null;
    this.tween = null;
    // Ждущие шаги сценария будят сразу — они увидят stopped и свернутся.
    const waiting = this.timers;
    this.timers = [];
    for (const timer of waiting) timer.go();
    this.hud.finger(null);
    this.hud.tint(null);
    this.hud.hideVersus();
    this.hud.finish();
  }

  /** Кадр: часы сценария, движение пальца и отложенные шаги. */
  update(dt: number): void {
    if (!this.active) return;

    if (this.clockRuns) {
      this.clock += dt;
      this.instruments();
    }

    const tween = this.tween;
    if (tween) {
      tween.passed += dt;
      const k = Math.min(1, tween.passed / tween.total);
      const at = {
        x: tween.from.x + (tween.to.x - tween.from.x) * k,
        y: tween.from.y + (tween.to.y - tween.from.y) * k,
      };
      this.pointer = at;
      this.hud.finger(at);
      if (k === 1) {
        this.tween = null;
        tween.go();
      }
    }

    for (const timer of [...this.timers]) {
      timer.left -= dt;
      if (timer.left > 0) continue;
      this.timers = this.timers.filter((other) => other !== timer);
      timer.go();
    }
  }

  // ---------- Ожидания ----------

  private wait(seconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.timers.push({
        left: seconds,
        go: () => (this.stopped ? reject(HALT) : resolve()),
      });
    });
  }

  private glide(to: Point, seconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.tween = {
        from: this.pointer ?? to,
        to,
        passed: 0,
        total: seconds,
        go: () => (this.stopped ? reject(HALT) : resolve()),
      };
    });
  }

  // ---------- Поле ----------

  /** Новый образец под очередной шаг: расклад живой, а путь на нём рисуем. */
  private reset(step: number): void {
    this.board = createBoard(seedRng(this.seed + step), cfg);
    this.renderer.resetAnims();
    this.chain = [];
    this.pointer = null;
    this.hud.finger(null);
    this.hud.chain(0);
  }

  /** Красит путь в один цвет: сценарий не должен зависеть от удачи. */
  private paint(path: Cell[], color: Color, charged: Cell[] = []): void {
    for (const cell of path) {
      const dot = this.board.grid[cell.r]?.[cell.c];
      if (dot) {
        dot.color = color;
        dot.charged = false;
      }
    }
    for (const cell of charged) {
      const dot = this.board.grid[cell.r]?.[cell.c];
      if (dot) dot.charged = true;
    }
  }

  /**
   * Путь нужной длины через заданную точку. Сначала ищем на поле, и только
   * если не нашлось — дорисовываем соседей: после взрыва расклад случайный,
   * а показать продолжение серии надо обязательно.
   */
  private chainThrough(from: Cell, length: number): Cell[] {
    const start = cellAt(this.board.grid, from);
    if (!start) return [from];
    const color = start.color;
    const path: Cell[] = [];
    const taken = new Set<string>();
    const walk = (cell: Cell): boolean => {
      path.push(cell);
      taken.add(`${cell.r},${cell.c}`);
      if (path.length === length) return true;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const next: Cell = { r: cell.r + dr, c: cell.c + dc };
          if (taken.has(`${next.r},${next.c}`)) continue;
          if (cellAt(this.board.grid, next)?.color !== color) continue;
          if (walk(next)) return true;
        }
      }
      path.pop();
      taken.delete(`${cell.r},${cell.c}`);
      return false;
    };
    if (walk(from)) return path;

    // Не нашлось — красим соседей под нужный цвет.
    const made: Cell[] = [from];
    for (let dc = 1; made.length < length && from.c + dc < cfg.cols; dc++) {
      made.push({ r: from.r, c: from.c + dc });
    }
    for (let dc = 1; made.length < length && from.c - dc >= 0; dc++) {
      made.unshift({ r: from.r, c: from.c - dc });
    }
    const keepCharged = this.board.grid[from.r]![from.c]!.charged;
    this.paint(made, color);
    this.board.grid[from.r]![from.c]!.charged = keepCharged;
    return made;
  }

  /** Ведёт палец по пути и делает ход. */
  private async play(path: Cell[], speed = STEP): Promise<ReturnType<typeof applyMove>> {
    this.chain = [path[0]!];
    this.pointer = this.renderer.center(path[0]!);
    this.hud.finger(this.pointer);
    this.renderer.pulse(path[0]!);
    this.hud.chain(1);
    await this.wait(speed);

    for (let i = 1; i < path.length; i++) {
      await this.glide(this.renderer.center(path[i]!), speed);
      this.chain.push(path[i]!);
      this.renderer.pulse(path[i]!);
      this.hud.chain(i + 1);
    }
    await this.wait(0.28);
    return this.commit(path);
  }

  private commit(path: Cell[]): ReturnType<typeof applyMove> {
    const old = this.board.grid;
    const result = applyMove(this.board, path, cfg, this.phaseColor);
    this.chain = [];
    this.pointer = null;
    this.hud.finger(null);
    this.hud.chain(0);
    if (typeof result === 'string') return result;

    this.board = result.board;
    this.score += result.points;
    this.renderer.animateMove(old, result);
    this.hud.score(this.score, result.streak);
    this.hud.points(result.points, result.multiplier, this.renderer.center(path[path.length - 1]!));
    const gain = result.multiplier > 1 ? ` ×${result.multiplier}` : '';
    this.hud.stat(
      `Снято ${result.removed.length + result.exploded.length} · +${result.points}${gain}`,
      'live',
    );
    return result;
  }

  // ---------- Приборы ----------

  /** Экранчик и часы по часам сценария — теми же функциями, что в бою. */
  private instruments(): void {
    const t = this.clock;
    const phase = phaseStateAt(this.seed, t, cfg, this.claims);
    const window = claimWindowAt(t, cfg);
    const leader = window.open ? bestClaim(this.claims, window.cycle) : null;
    this.phaseColor = phase.active;
    this.hud.mini(miniState(phase, window, leader, cfg, true));
    this.hud.tint(phase.active ?? leader?.color ?? null);
    const left = Math.max(0, DUEL - t);
    this.hud.time('Время', `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`);
    this.hud.ticks(left / DUEL);
  }

  /** Экранчик в покое: шаги без часов не должны показывать чужой отсчёт. */
  private idleInstruments(): void {
    this.hud.mini({ text: 'Обучение · показ', cd: '--', color: null, fill: 0 });
    this.hud.tint(null);
    this.hud.time('Время', '∞');
    // Делений не зажигаем: пока идёт показ, запаса времени не существует.
    this.hud.ticks(0);
  }

  private say(step: number, title: string, text: string): void {
    this.hud.caption(step, STEPS, title, text);
  }

  // ---------- Сценарий ----------

  private async run(): Promise<void> {
    this.hud.score(0, 0);
    this.hud.hideVersus();
    this.idleInstruments();

    await this.chainAct();
    await this.lensAct();
    await this.cascadeAct();
    const color = await this.claimAct();
    await this.resonanceAct(color);
    await this.modesAct();

    this.say(STEPS, 'Готово', 'Это весь прибор. Дальше — образец и ваши руки.');
    this.hud.stat('Готов к наблюдению', '');
    await this.wait(1.9);
    this.stop();
  }

  /** 1. Цепочка: соседние точки одного цвета, в любую сторону. */
  private async chainAct(): Promise<void> {
    this.reset(1);
    const path: Cell[] = [
      { r: 1, c: 0 },
      { r: 1, c: 1 },
      { r: 2, c: 2 },
      { r: 3, c: 2 },
      { r: 3, c: 3 },
      { r: 2, c: 4 },
      { r: 1, c: 4 },
    ];
    this.paint(path, 2);
    this.say(
      1,
      'Цепочка',
      'Ведите палец по соседним точкам одного цвета — по горизонтали, вертикали и по диагонали. Цепочка идёт от трёх точек, и каждая следующая дороже предыдущей.',
    );
    await this.wait(1.8);
    await this.play(path);
    await this.wait(1.9);
  }

  /** 2. Линза: цепочка от десяти точек оставляет заряд. */
  private async lensAct(): Promise<void> {
    this.reset(2);
    const path: Cell[] = [
      { r: 0, c: 1 },
      { r: 1, c: 1 },
      { r: 2, c: 1 },
      { r: 3, c: 1 },
      { r: 4, c: 1 },
      { r: 4, c: 2 },
      { r: 3, c: 3 },
      { r: 2, c: 3 },
      { r: 1, c: 3 },
      { r: 0, c: 3 },
    ];
    this.paint(path, 0);
    this.say(
      2,
      'Линза',
      `Цепочка от ${cfg.surgeChainLength} точек шлифует линзу — кольцо с ядром на месте последней точки. Сама по себе она ничего не даёт: её надо собрать следующей цепочкой.`,
    );
    await this.wait(2.2);
    const result = await this.play(path, 0.13);
    if (typeof result !== 'string' && result.charged) {
      await this.wait(0.9);
      this.renderer.pulse(result.charged);
      this.hud.stat('Линза отшлифована', 'live');
    }
    await this.wait(1.8);
  }

  /** 3. Увеличение: линзы подряд множат потенциал. */
  private async cascadeAct(): Promise<void> {
    this.reset(3);
    const first: Cell[] = [
      { r: 2, c: 0 },
      { r: 2, c: 1 },
      { r: 2, c: 2 },
      { r: 2, c: 3 },
      { r: 2, c: 4 },
    ];
    this.paint(first, 1, [
      { r: 2, c: 1 },
      { r: 2, c: 3 },
    ]);
    this.say(
      3,
      'Увеличение',
      'Собранная линза даёт вспышку 3×3 и увеличение: одна — ×2, вторая подряд — ×3, третья — ×4. Цепочка без линзы сбрасывает его на единицу.',
    );
    await this.wait(2.4);
    await this.play(first);
    await this.wait(1.6);

    // Продолжаем серию: ещё одна линза — и увеличение растёт.
    const spot: Cell = { r: 3, c: 2 };
    this.board.grid[spot.r]![spot.c]!.charged = true;
    const second = this.chainThrough(spot, 4);
    this.renderer.pulse(spot);
    await this.wait(1.1);
    await this.play(second);
    await this.wait(2.1);
  }

  /** 4. Заявка: битва за цвет резонанса в окне перед фазой. */
  private async claimAct(): Promise<Color> {
    this.reset(4);
    this.hud.versus('Соперник', 1980);
    this.say(
      4,
      'Битва за цвет',
      `Цикл открывается окном заявки на ${cfg.claimWindow} секунд, резонанс идёт сразу за ним. Цепочка от ${cfg.claimChainLength} точек ставит свой цвет — и он загорится у обоих.`,
    );
    // Часы сценария подводим к самому окну: оно открывает цикл.
    this.clock = cfg.phasePeriod - 2;
    this.clockRuns = true;
    await this.wait(3.2);

    // Своя заявка: пять точек.
    const mine: Cell[] = [
      { r: 1, c: 1 },
      { r: 1, c: 2 },
      { r: 2, c: 3 },
      { r: 3, c: 3 },
      { r: 3, c: 2 },
    ];
    const myColor: Color = 3;
    this.paint(mine, myColor);
    await this.play(mine, STEP_FAST);
    this.claims.push({ cycle: 1, color: myColor, length: mine.length, t: this.clock, mine: true });
    this.hud.stat(`Заявка · цепь ${mine.length}`, 'live');
    await this.wait(1.5);

    // Соперник перебивает цепочкой длиннее — считается длина, не скорость.
    const hisColor: Color = 1;
    this.claims.push({ cycle: 1, color: hisColor, length: 7, t: this.clock, mine: false });
    this.hud.stat('Заявку перебили · 7', 'warn');
    this.hud.flash();
    this.say(
      4,
      'Битва за цвет',
      'Перебить заявку можно только цепочкой длиннее — считается длина, а не скорость. Кайма окуляра всё время показывает цвет, за которым сейчас идёт резонанс.',
    );
    await this.wait(2.6);

    // Ответ: восемь точек забирают цвет обратно.
    const answer: Cell[] = [
      { r: 4, c: 0 },
      { r: 4, c: 1 },
      { r: 4, c: 2 },
      { r: 4, c: 3 },
      { r: 3, c: 4 },
      { r: 2, c: 4 },
      { r: 1, c: 4 },
      { r: 0, c: 3 },
    ];
    this.paint(answer, myColor);
    await this.play(answer, STEP_FAST);
    this.claims.push({ cycle: 1, color: myColor, length: answer.length, t: this.clock, mine: true });
    this.hud.stat(`Заявка · цепь ${answer.length}`, 'live');
    // Часы придерживаем сразу: пока игрок читает итог заявки, окно не
    // должно закрыться само. Следующий шаг подведёт их к фазе, а отматывать
    // назад нельзя — на экранчике это выглядит как сбой прибора.
    this.clockRuns = false;
    await this.wait(1.6);
    return myColor;
  }

  /** 5. Что даёт цвет: множители перемножаются. */
  private async resonanceAct(color: Color): Promise<void> {
    // Доводим часы до фазы: цвет заявлен, резонанс загорается им.
    this.clock = Math.max(this.clock, cfg.phasePeriod + cfg.claimWindow - 0.6);
    this.clockRuns = true;
    this.say(
      5,
      'Резонанс',
      `Восемь секунд цепочки заявленного цвета дают ×${cfg.phaseMultiplier}. Множители перемножаются: увеличение ×3 в резонансе даёт ×6 — ради этого линзы и копят к началу фазы.`,
    );
    await this.wait(2.4);

    this.reset(5);
    const path: Cell[] = [
      { r: 2, c: 0 },
      { r: 2, c: 1 },
      { r: 2, c: 2 },
      { r: 3, c: 3 },
      { r: 3, c: 4 },
    ];
    this.paint(path, color, [
      { r: 2, c: 1 },
      { r: 3, c: 3 },
    ]);
    await this.wait(1.2);
    await this.play(path);
    await this.wait(2.4);
    this.clockRuns = false;
    this.phaseColor = null;
    this.hud.tint(null);
  }

  /** 6. Режимы: три способа играть — быстро, по одному. */
  private async modesAct(): Promise<void> {
    this.reset(6);
    this.hud.hideVersus();
    this.hud.score(this.score, 0);
    this.idleInstruments();

    this.hud.time('Время', '3:00');
    this.say(
      6,
      'Спринт',
      'Три минуты на максимум потенциала. Попыток сколько угодно, в общую таблицу идёт лучшая — счёт подтверждает сервер, переигрывая заход.',
    );
    await this.wait(2.6);

    this.hud.time('Заказы', '7');
    this.say(
      6,
      'Заказ',
      'Вторая механика прибора, её включает клавиша ⇄ на корпусе. Прибор звенит цветом 18 секунд: снять 25 точек этого цвета за одно касание. Три пустых окна — заход окончен.',
    );
    await this.wait(2.8);

    this.hud.time('Время', '1:30');
    this.hud.versus('Соперник', 2430);
    this.say(
      6,
      'Дуэль',
      'Одинаковый образец с живым соперником: полторы минуты на цепочках, три минуты на заказах. У каждой механики свой рейтинг.',
    );
    await this.wait(2.8);
    this.hud.hideVersus();
  }
}
