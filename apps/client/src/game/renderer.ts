import type { Cell, Color, GameConfig, Grid, MoveResult } from '@doton/core';
import type { Theme } from '../theme';

interface DotAnim {
  /** Смещение по вертикали в пикселях (отрицательное — точка ещё падает). */
  offset: number;
  velocity: number;
}

interface Ghost {
  x: number;
  y: number;
  fill: string;
  age: number;
}

interface Shockwave {
  x: number;
  y: number;
  age: number;
}

const GHOST_LIFE = 0.4;
const SHOCK_LIFE = 0.5;
/** Ускорение падения в клетках/с² — подбиралось на глаз. */
const GRAVITY_CELLS = 34;
const BOUNCE = 0.16;
/** Контур молнии заряда, в долях радиуса точки. */
const BOLT = [
  [0.18, -0.55],
  [-0.3, 0.1],
  [-0.02, 0.1],
  [-0.18, 0.55],
  [0.34, -0.14],
  [0.06, -0.14],
] as const;

/**
 * Canvas-рендер поля: точки, заряды, линия цепочки, падение.
 * Свечение — только как ответ на действие (стайлгайд «Цепи»).
 */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private anims: DotAnim[][] = [];
  private ghosts: Ghost[] = [];
  private shocks: Shockwave[] = [];
  private cell = 0;
  private pad = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cfg: GameConfig,
    private theme: Theme,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.resetAnims();
    this.resize();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  resize(): void {
    const cssSize = this.canvas.clientWidth;
    if (cssSize === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(cssSize * dpr);
    this.canvas.height = Math.round(cssSize * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.pad = cssSize * 0.04;
    this.cell = (cssSize - this.pad * 2) / this.cfg.cols;
  }

  center(cell: Cell): { x: number; y: number } {
    return {
      x: this.pad + cell.c * this.cell + this.cell / 2,
      y: this.pad + cell.r * this.cell + this.cell / 2,
    };
  }

  /** Ближайшая клетка к точке (в CSS-пикселях канваса) или null вне радиуса захвата. */
  hitTest(x: number, y: number): Cell | null {
    const c = Math.floor((x - this.pad) / this.cell);
    const r = Math.floor((y - this.pad) / this.cell);
    if (r < 0 || r >= this.cfg.rows || c < 0 || c >= this.cfg.cols) return null;
    const center = this.center({ r, c });
    const radius = this.cell * 0.42;
    return Math.hypot(x - center.x, y - center.y) <= radius ? { r, c } : null;
  }

  resetAnims(): void {
    this.anims = Array.from({ length: this.cfg.rows }, () =>
      Array.from({ length: this.cfg.cols }, () => ({ offset: 0, velocity: 0 })),
    );
    this.ghosts = [];
    this.shocks = [];
  }

  /** Ставит анимации падения и призраков по результату хода (grid уже новый). */
  animateMove(oldGrid: Grid, result: MoveResult): void {
    const gone: Cell[] = [...result.removed, ...result.exploded];
    const removedByCol = new Map<number, Set<number>>();

    for (const cell of gone) {
      const content = oldGrid[cell.r]![cell.c]!;
      const fill = this.theme.dots[content.color]!;
      const center = this.center(cell);
      this.ghosts.push({ x: center.x, y: center.y, fill, age: 0 });

      let rows = removedByCol.get(cell.c);
      if (!rows) removedByCol.set(cell.c, (rows = new Set()));
      rows.add(cell.r);
    }

    // Ударная волна из каждой заряженной точки цепочки.
    for (const cell of result.removed) {
      if (oldGrid[cell.r]![cell.c]!.charged) {
        const center = this.center(cell);
        this.shocks.push({ x: center.x, y: center.y, age: 0 });
      }
    }

    for (let c = 0; c < this.cfg.cols; c++) {
      const removedRows = removedByCol.get(c);
      if (!removedRows) continue;
      const missing = removedRows.size;
      const survivorRows: number[] = [];
      for (let r = 0; r < this.cfg.rows; r++) {
        if (!removedRows.has(r)) survivorRows.push(r);
      }
      for (let r = 0; r < missing; r++) {
        // Новые точки въезжают стопкой из-за верхнего края.
        this.anims[r]![c] = { offset: -(missing + 0.6) * this.cell, velocity: 0 };
      }
      survivorRows.forEach((oldRow, i) => {
        const newRow = missing + i;
        this.anims[newRow]![c] = {
          offset: -(newRow - oldRow) * this.cell,
          velocity: 0,
        };
      });
    }
  }

  draw(
    dt: number,
    grid: Grid,
    chain: Cell[],
    pointer: { x: number; y: number } | null,
    phaseColor: Color | null,
  ): void {
    const size = this.canvas.clientWidth;
    const ctx = this.ctx;
    const theme = this.theme;

    this.step(dt);

    ctx.clearRect(0, 0, size, size);

    // Волосяная сетка платы.
    ctx.strokeStyle = theme.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < this.cfg.cols; i++) {
      const x = this.pad + i * this.cell;
      ctx.moveTo(x, this.pad);
      ctx.lineTo(x, size - this.pad);
      const y = this.pad + i * this.cell;
      ctx.moveTo(this.pad, y);
      ctx.lineTo(size - this.pad, y);
    }
    ctx.stroke();

    // Линия цепочки — под точками.
    const first = chain[0];
    const firstContent = first ? grid[first.r]?.[first.c] : undefined;
    if (firstContent !== undefined) {
      ctx.strokeStyle = theme.dots[firstContent.color]!;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = this.cell * 0.18;
      ctx.lineCap = 'square';
      ctx.lineJoin = 'miter';
      ctx.beginPath();
      chain.forEach((cell, i) => {
        const p = this.center(cell);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      if (pointer) ctx.lineTo(pointer.x, pointer.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Содержимое клеток.
    const inChain = new Set(chain.map((cell) => `${cell.r},${cell.c}`));
    const radius = this.cell * 0.34;
    for (let r = 0; r < this.cfg.rows; r++) {
      for (let c = 0; c < this.cfg.cols; c++) {
        const content = grid[r]![c]!;
        const anim = this.anims[r]![c]!;
        const center = this.center({ r, c });
        const y = center.y + anim.offset;

        const active = inChain.has(`${r},${c}`);
        // Точка цвета фазы — с ореолом: сейчас за неё ×2.
        if (phaseColor !== null && content.color === phaseColor) {
          ctx.globalAlpha = 0.25;
          ctx.fillStyle = theme.dots[content.color]!;
          ctx.beginPath();
          ctx.arc(center.x, y, radius * 1.45, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        ctx.fillStyle = theme.dots[content.color]!;
        ctx.beginPath();
        ctx.arc(center.x, y, active ? radius * 1.14 : radius, 0, Math.PI * 2);
        ctx.fill();

        if (active) {
          ctx.strokeStyle = theme.chainOutline;
          ctx.lineWidth = 3;
          ctx.stroke();
        }

        if (content.charged) {
          this.drawBolt(center.x, y, radius);
        }
      }
    }

    // Призраки снятых клеток.
    for (const ghost of this.ghosts) {
      const t = ghost.age / GHOST_LIFE;
      ctx.globalAlpha = 0.5 * (1 - t);
      ctx.fillStyle = ghost.fill;
      ctx.beginPath();
      ctx.arc(ghost.x, ghost.y, radius * (1 + t * 0.9), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Ударные волны перегрузки.
    for (const shock of this.shocks) {
      const t = shock.age / SHOCK_LIFE;
      ctx.globalAlpha = 0.55 * (1 - t);
      ctx.strokeStyle = theme.chainOutline;
      ctx.lineWidth = 3 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(shock.x, shock.y, this.cell * (0.4 + t * 1.3), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawBolt(x: number, y: number, radius: number): void {
    const ctx = this.ctx;
    const scale = radius * 1.35;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.beginPath();
    BOLT.forEach(([bx, by], i) => {
      if (i === 0) ctx.moveTo(x + bx * scale, y + by * scale);
      else ctx.lineTo(x + bx * scale, y + by * scale);
    });
    ctx.closePath();
    ctx.fill();
  }

  private step(dt: number): void {
    const gravity = GRAVITY_CELLS * this.cell;
    for (const row of this.anims) {
      for (const anim of row) {
        if (anim.offset === 0 && anim.velocity === 0) continue;
        anim.velocity += gravity * dt;
        anim.offset += anim.velocity * dt;
        if (anim.offset >= 0) {
          if (anim.velocity > this.cell * 2.4) {
            // Лёгкий отскок при жёстком приземлении.
            anim.offset = 0;
            anim.velocity = -anim.velocity * BOUNCE;
          } else {
            anim.offset = 0;
            anim.velocity = 0;
          }
        }
      }
    }
    for (const ghost of this.ghosts) ghost.age += dt;
    this.ghosts = this.ghosts.filter((ghost) => ghost.age < GHOST_LIFE);
    for (const shock of this.shocks) shock.age += dt;
    this.shocks = this.shocks.filter((shock) => shock.age < SHOCK_LIFE);
  }
}
