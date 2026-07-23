import { areNeighbors, cellAt, validatePath, type Board, type Cell, type GameConfig } from '@doton/core';
import type { Renderer } from './renderer';

function sameCell(a: Cell, b: Cell): boolean {
  return a.r === b.r && a.c === b.c;
}

/**
 * Сбор цепочки пальцем/мышью. Правила расширения — локальные и быстрые,
 * итоговый ход всё равно проверяет ядро.
 * Возврат на предыдущую точку укорачивает цепочку (undo жестом).
 * Попадание в уже взятую точку — попытка замкнуть кольцо: если ядро согласно,
 * ход коммитится сразу, не дожидаясь отпускания.
 */
export class ChainInput {
  chain: Cell[] = [];
  pointer: { x: number; y: number } | null = null;
  private dragging = false;

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

  private toLocal(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private readonly onDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.dragging = true;
    this.chain = [];
    this.pointer = this.toLocal(e);
    const cell = this.renderer.hitTest(this.pointer.x, this.pointer.y);
    if (cell) {
      this.chain.push(cell);
      this.onExtend(1);
    }
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.pointer = this.toLocal(e);
    const cell = this.renderer.hitTest(this.pointer.x, this.pointer.y);
    if (!cell || this.chain.length === 0) return;

    const last = this.chain[this.chain.length - 1]!;
    if (sameCell(cell, last)) return;

    // Undo: вернулись на предпоследнюю точку.
    const prev = this.chain[this.chain.length - 2];
    if (prev && sameCell(cell, prev)) {
      this.chain.pop();
      return;
    }

    const board = this.getBoard();
    if (!areNeighbors(last, cell)) return;
    if (cellAt(board.grid, cell) !== cellAt(board.grid, this.chain[0]!)) return;

    const visited = this.chain.some((taken) => sameCell(taken, cell));
    if (!visited) {
      this.chain.push(cell);
      this.onExtend(this.chain.length);
      return;
    }

    // Попытка замкнуть кольцо.
    const closed = [...this.chain, cell];
    const validated = validatePath(board, closed, this.cfg);
    if (typeof validated !== 'string' && validated.ring) {
      this.commit(closed);
    }
  };

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
