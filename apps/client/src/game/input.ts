import { areNeighbors, cellAt, type Board, type Cell, type GameConfig } from '@doton/core';
import { FEEL } from './feel';
import type { Renderer } from './renderer';

function sameCell(a: Cell, b: Cell): boolean {
  return a.r === b.r && a.c === b.c;
}

interface Point {
  x: number;
  y: number;
}

/**
 * Сбор цепочки пальцем/мышью. Правила расширения — локальные и быстрые,
 * итоговый ход всё равно проверяет ядро.
 * Отката нет: уже взятая точка из цепочки не выходит, так что за
 * направление игрок отвечает сразу.
 */
export class ChainInput {
  chain: Cell[] = [];
  pointer: Point | null = null;
  private on = true;
  private dragging = false;
  private touch = false;

  /** Поле принимает касания. Выключено в реплее и в стоп-кадре. */
  get enabled(): boolean {
    return this.on;
  }

  set enabled(value: boolean) {
    this.on = value;
    // Начатая цепочка не должна пережить запрет: иначе палец, поднятый уже
    // после паузы, отправит ход, собранный до неё.
    if (!value) this.clear();
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: Renderer,
    private readonly getBoard: () => Board,
    private readonly cfg: GameConfig,
    private readonly onCommit: (path: Cell[]) => void,
    private readonly onExtend: (length: number) => void,
  ) {
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
  }

  private toLocal(e: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (!this.on) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.dragging = true;
    this.touch = e.pointerType !== 'mouse';
    this.chain = [];
    const point = this.toLocal(e);
    this.pointer = point;
    const cell = this.renderer.hitTest(point.x, point.y, this.touch);
    if (cell) {
      this.chain.push(cell);
      this.renderer.pulse(cell);
      this.onExtend(1);
    }
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const from = this.pointer;
    const to = this.toLocal(e);
    this.pointer = to;
    if (this.chain.length === 0) {
      // Цепочка ещё не начата: разрешаем подхватить точку по ходу движения.
      const cell = this.renderer.hitTest(to.x, to.y, this.touch);
      if (cell) {
        this.chain.push(cell);
        this.renderer.pulse(cell);
        this.onExtend(1);
      }
      return;
    }

    // Палец между событиями успевает пройти несколько клеток — идём по отрезку,
    // иначе на быстром движении точки пропускаются и цепочка рвётся.
    for (const point of this.trace(from, to)) {
      const cell = this.renderer.hitTest(point.x, point.y, this.touch);
      if (cell) this.tryExtend(cell);
    }
  };

  /** Точки вдоль отрезка с шагом в долю клетки, включая конец. */
  private *trace(from: Point | null, to: Point): Iterable<Point> {
    if (!from) {
      yield to;
      return;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    const step = this.renderer.cellSize * FEEL.traceStep;
    const steps = Math.min(Math.ceil(distance / step), 24);
    for (let i = 1; i <= steps; i++) {
      yield { x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps };
    }
  }

  private tryExtend(cell: Cell): void {
    const last = this.chain[this.chain.length - 1]!;
    if (sameCell(cell, last)) return;

    const board = this.getBoard();
    if (!areNeighbors(last, cell)) return;
    if (cellAt(board.grid, cell)?.color !== cellAt(board.grid, this.chain[0]!)?.color) return;
    if (this.chain.some((taken) => sameCell(taken, cell))) return;

    this.chain.push(cell);
    this.renderer.pulse(cell);
    this.onExtend(this.chain.length);
  }

  private readonly onUp = (): void => {
    if (!this.dragging) return;
    if (this.chain.length >= this.cfg.minChain) {
      this.commit(this.chain);
    } else {
      this.clear();
    }
  };

  private commit(path: Cell[]): void {
    this.dragging = false;
    const finished = path;
    this.clear();
    this.onCommit(finished);
  }

  private clear(): void {
    this.dragging = false;
    this.chain = [];
    this.pointer = null;
  }
}
