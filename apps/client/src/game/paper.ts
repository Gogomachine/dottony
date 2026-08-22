import {
  ART_PAINTS,
  ART_SIZE,
  artEmptyCells,
  encodeArt,
  type ArtCell,
  type Cell,
} from '@doton/core';
import type { Theme } from '../theme';

/**
 * Лист: режим рисования на приборе.
 *
 * Прибор умеет ровно одно движение — вести палец по соседним точкам, — и
 * здесь оно делает то же, что в игре, только цвет выбирает не поле, а
 * человек: цепочка от двух клеток набирается пальцем, а красит её кнопка
 * цвета на служебном экранчике. Никаких часов и очков тут нет: лист не
 * заход, доигрывать его не надо.
 *
 * Живёт отдельно от партии и её ядра: правил, которые стоило бы проверять
 * серверу, у листа нет. На сервер он уезжает только по одному поводу — когда
 * игрок ставит нарисованное себе на пропуск, — и там проверяют не рисунок, а
 * оплату и форму записи.
 */

/**
 * Сторона листа и его краски живут в ядре: рисунок уезжает на пропуск и на
 * экран соперника, и сетка с набором красок должны совпадать у всех — там
 * же лежит и запись рисунка строкой. Здесь они только под своими именами:
 * лист — то место, где ими рисуют.
 */
export const PAPER_SIZE = ART_SIZE;
export const PAPER_PAINTS = ART_PAINTS;

/** Красит цепочка от двух клеток: одна клетка — это ещё не движение. */
export const PAPER_MIN = 2;

/** Клетка листа: номер краски либо чистое место. */
export type PaperCell = ArtCell;

const KEY = 'doton.paper.v1';

/**
 * Радиус точки в долях клетки — та же пропорция, что у поля: точка узнаётся
 * по ней, а не по размеру, и на мелкой сетке просто мельче.
 */
const DOT = 0.41;

const empty = artEmptyCells;

function sameCell(a: Cell, b: Cell): boolean {
  return a.r === b.r && a.c === b.c;
}

function neighbours(a: Cell, b: Cell): boolean {
  const dr = Math.abs(a.r - b.r);
  const dc = Math.abs(a.c - b.c);
  return dr <= 1 && dc <= 1 && dr + dc > 0;
}

export class Paper {
  private cells: PaperCell[][] = empty();
  /** Набранная цепочка. Она переживает поднятый палец: цвет жмут после. */
  chain: Cell[] = [];
  private readonly ctx: CanvasRenderingContext2D;
  private cell = 0;
  private pad = 0;
  private drawing = false;
  private bound = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private theme: Theme,
    /** Звук шага — тот же, что у цепочки в игре: прибор один. */
    private readonly onStep: (index: number) => void,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.cells = load();
    this.resize();
  }

  /** Сколько клеток закрашено — единственное число, которое лист считает. */
  get painted(): number {
    return this.cells.flat().filter((cell) => cell !== null).length;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  /**
   * Красит набранную цепочку и сбрасывает её. Пустой цвет — стирает: без
   * стирания рисование было бы дорогой в одну сторону.
   *
   * Возвращает, сколько клеток изменилось: по нему прибор решает, отвечать
   * ли на нажатие звуком.
   */
  paint(color: PaperCell): number {
    if (this.chain.length < PAPER_MIN) return 0;
    const painted = this.chain.length;
    for (const { r, c } of this.chain) this.cells[r]![c] = color;
    this.chain = [];
    save(this.cells);
    return painted;
  }

  /** Рисунок строкой — в том виде, в каком он уезжает на пропуск. */
  art(): string {
    return encodeArt(this.cells);
  }

  /** Чистый лист. Кнопка ⟳ на корпусе в этом режиме делает именно это. */
  clear(): void {
    this.cells = empty();
    this.chain = [];
    save(this.cells);
  }

  /** Снимает набранное, не трогая рисунок: палец соскользнул — не беда. */
  drop(): void {
    this.chain = [];
  }

  bind(): void {
    if (this.bound) return;
    this.bound = true;
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
  }

  unbind(): void {
    if (!this.bound) return;
    this.bound = false;
    this.drawing = false;
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
  }

  private readonly onDown = (event: PointerEvent): void => {
    const cell = this.hit(event);
    if (!cell) {
      // Мимо листа — набранное снимаем: это и есть отказ от цепочки.
      this.chain = [];
      return;
    }
    event.preventDefault();
    this.drawing = true;
    this.chain = [cell];
    this.onStep(0);
  };

  private readonly onMove = (event: PointerEvent): void => {
    if (!this.drawing) return;
    const cell = this.hit(event);
    if (!cell) return;
    const last = this.chain[this.chain.length - 1];
    // Правила ведения те же, что у цепочки в игре, минус цвет: соседняя
    // клетка, без возвратов. Цвет здесь выбирает человек, а не поле.
    if (!last || sameCell(last, cell) || !neighbours(last, cell)) return;
    if (this.chain.some((taken) => sameCell(taken, cell))) return;
    this.chain.push(cell);
    this.onStep(this.chain.length - 1);
  };

  private readonly onUp = (): void => {
    this.drawing = false;
  };

  private hit(event: PointerEvent): Cell | null {
    const box = this.canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const c = Math.floor((x - this.pad) / this.cell);
    const r = Math.floor((y - this.pad) / this.cell);
    if (r < 0 || r >= PAPER_SIZE || c < 0 || c >= PAPER_SIZE) return null;
    return { r, c };
  }

  resize(): void {
    const size = this.canvas.clientWidth;
    if (size === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.pad = size * 0.04;
    this.cell = (size - this.pad * 2) / PAPER_SIZE;
  }

  render(): void {
    const ctx = this.ctx;
    const size = this.canvas.clientWidth;
    if (size === 0 || this.cell === 0) return;
    ctx.clearRect(0, 0, size, size);

    // Волосяная сетка платы — та же, что под точками в игре.
    ctx.strokeStyle = this.theme.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < PAPER_SIZE; i++) {
      const x = this.pad + i * this.cell;
      ctx.moveTo(x, this.pad);
      ctx.lineTo(x, size - this.pad);
      const y = this.pad + i * this.cell;
      ctx.moveTo(this.pad, y);
      ctx.lineTo(size - this.pad, y);
    }
    ctx.stroke();

    const radius = this.cell * DOT;

    // Нить набранной цепочки — под точками, как и в игре.
    if (this.chain.length > 1) {
      ctx.strokeStyle = this.theme.chainOutline;
      ctx.lineWidth = this.cell * 0.22;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      this.chain.forEach((cell, index) => {
        const center = this.center(cell);
        if (index === 0) ctx.moveTo(center.x, center.y);
        else ctx.lineTo(center.x, center.y);
      });
      ctx.stroke();
    }

    // Незакрашенной клетки не видно вовсе: чистый лист — это чёрное стекло
    // с волосяной сеткой, и всё. Так лист показывает ровно то, чем станет
    // шильдик: там пустая клетка — тоже просто стекло. Точка на её месте
    // обещала бы то, чего в шильдике нет, и рисовать пришлось бы, держа
    // поправку в голове.
    const taken = new Set(this.chain.map((cell) => `${cell.r},${cell.c}`));
    for (let r = 0; r < PAPER_SIZE; r++) {
      for (let c = 0; c < PAPER_SIZE; c++) {
        const center = this.center({ r, c });
        const color = this.cells[r]![c] ?? null;
        const paint = color === null ? null : (PAPER_PAINTS[color]?.css ?? null);
        if (paint !== null) {
          ctx.beginPath();
          ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
          ctx.fillStyle = paint;
          ctx.fill();
        }
        // Взятая точка обведена — по обводке видно, что покрасится.
        if (taken.has(`${r},${c}`)) {
          ctx.strokeStyle = this.theme.chainOutline;
          ctx.lineWidth = Math.max(2, this.cell * 0.07);
          ctx.beginPath();
          ctx.arc(center.x, center.y, radius + ctx.lineWidth, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }

  private center(cell: Cell): { x: number; y: number } {
    return {
      x: this.pad + cell.c * this.cell + this.cell / 2,
      y: this.pad + cell.r * this.cell + this.cell / 2,
    };
  }
}

/**
 * Рисунок живёт в устройстве и никуда не уходит: сервер про лист пока не
 * знает. Мусор в хранилище читаем как чистый лист — терять рисунок обидно,
 * но падать из-за него глупее.
 */
function load(): PaperCell[][] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return empty();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > PAPER_SIZE) return empty();
    // Сетка могла быть меньше: лист начинался с шести клеток. Старый рисунок
    // не выбрасываем, а кладём в середину нового листа — он там и был.
    const shift = Math.floor((PAPER_SIZE - parsed.length) / 2);
    const cells = empty();
    parsed.forEach((row, r) => {
      if (!Array.isArray(row)) return;
      row.forEach((value, c) => {
        if (r + shift >= PAPER_SIZE || c + shift >= PAPER_SIZE) return;
        if (typeof value === 'number' && value >= 0 && value < PAPER_PAINTS.length) {
          cells[r + shift]![c + shift] = value;
        }
      });
    });
    return cells;
  } catch {
    return empty();
  }
}

function save(cells: PaperCell[][]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cells));
  } catch {
    // Приватный режим — рисунок живёт до конца сессии, и только.
  }
}
