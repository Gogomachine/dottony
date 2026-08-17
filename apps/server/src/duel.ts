import { randomUUID } from 'node:crypto';
import {
  applyMove,
  claimFrom,
  cleanMarks,
  createBoard,
  orderWindow,
  phaseColorAt,
  seedRng,
  startOrder,
  tapOrder,
  tickOrder,
  DEFAULT_CONFIG,
  type Board,
  type Cell,
  type Claim,
  type OrderRun,
} from '@doton/core';
import { MIN_MOVE_GAP } from './limits.js';
import {
  DUEL_SECONDS,
  type DuelKind,
  type DuelServerMessage,
  type DuelSnapshot,
  type MoveLog,
} from '@doton/protocol';

/**
 * Дуэль — гонка на одинаковом поле: обоим игрокам выдаётся один сид,
 * поэтому решает только скилл. Сервер держит поле каждого игрока и
 * проверяет каждый ход через то же ядро, что и клиент, — счёт клиента
 * не принимается на веру никогда.
 */

/** Заявка на цвет фазы вместе с тем, кто её подал. */
export interface DuelClaim extends Claim {
  by: string;
}

export interface DuelPlayer {
  id: string;
  name: string;
  /** Шильдики корпуса: единственное, чем игрок помечен для соперника. */
  marks?: readonly (string | null)[];
  /** Код друга: сопернику его показывают после матча. */
  code?: string;
  send(message: DuelServerMessage): void;
}

/** Момент набора очков: из таких точек складывается темп записи. */
export interface ScorePoint {
  t: number;
  points: number;
}

interface PlayerState {
  player: DuelPlayer;
  board: Board;
  /**
   * Заход заказов — у каждого свой. Поле у обоих из одного сида, но окна
   * расходятся с первого же закрытого заказа: закрыл — сразу новый цвет,
   * ровно как в одиночном режиме. Общее у дуэлянтов только начало.
   */
  run: OrderRun | null;
  score: number;
  lastMoveAt: number;
  /** Записанная попытка вместо живого игрока. */
  ghost: boolean;
  /** Темп набора очков — из него потом получается призрак. */
  log: ScorePoint[];
  /** Пути цепочек — из них собирается реплей партии. */
  moves: MoveLog[];
}

export type MoveOutcome =
  | { ok: true; score: number; points: number }
  | { ok: false; reason: string };

/** Итог матча для одного живого игрока — основа для пересчёта рейтинга. */
export interface DuelOutcome {
  playerId: string;
  player: DuelPlayer;
  outcome: 'win' | 'loss' | 'draw';
  score: number;
  opponentScore: number;
  /** Соперник был записью: такой матч рейтинг не меняет. */
  opponentIsGhost: boolean;
}

export class Duel {
  readonly id = randomUUID();
  readonly seed: number;
  readonly startedAt: number;
  private readonly players = new Map<string, PlayerState>();
  /**
   * Заявки на цвет резонанса от обоих игроков. Живут на матче, а не на
   * игроке: фаза у дуэлянтов одна, и решают её оба сразу.
   */
  private readonly claims: DuelClaim[] = [];
  private finished = false;

  readonly kind: DuelKind;
  /** Длительность этого матча: у механик она разная. */
  readonly duration: number;

  constructor(
    seed: number,
    a: DuelPlayer,
    b: DuelPlayer,
    options: { ghostB?: boolean; now?: number; kind?: DuelKind } = {},
  ) {
    this.seed = seed;
    this.kind = options.kind ?? 'chain';
    this.duration = DUEL_SECONDS[this.kind];
    this.startedAt = options.now ?? Date.now();
    for (const [player, ghost] of [
      [a, false],
      [b, options.ghostB ?? false],
    ] as const) {
      const run = this.kind === 'order' ? startOrder(seed, DEFAULT_CONFIG) : null;
      this.players.set(player.id, {
        player,
        board: run ? run.board : createBoard(seedRng(seed), DEFAULT_CONFIG),
        run,
        score: 0,
        lastMoveAt: -Infinity,
        ghost,
        log: [],
        moves: [],
      });
    }
  }

  get playerIds(): string[] {
    return [...this.players.keys()];
  }

  isOver(now = Date.now()): boolean {
    return this.finished || this.elapsed(now) > this.duration;
  }

  elapsed(now = Date.now()): number {
    return (now - this.startedAt) / 1000;
  }

  private opponentOf(playerId: string): PlayerState | undefined {
    for (const [id, state] of this.players) {
      if (id !== playerId) return state;
    }
    return undefined;
  }

  /** Рассылает обоим стартовое сообщение с сидом. */
  announce(): void {
    for (const [id, state] of this.players) {
      const opponent = this.opponentOf(id);
      if (state.ghost || !opponent) continue;
      state.player.send({
        type: 'matched',
        seed: this.seed,
        duration: this.duration,
        kind: this.kind,
        opponent: opponent.player.name,
        opponentMarks: cleanMarks(opponent.player.marks ?? []),
        ghost: opponent.ghost,
        ...(opponent.ghost || !opponent.player.code
          ? {}
          : { opponentCode: opponent.player.code }),
      });
    }
  }

  /**
   * Применяет ход игрока: проверяет темп и легальность, начисляет очки
   * и сообщает сопернику новый счёт.
   *
   * Время хода — только серверное. Клиент своей секунды не присылает: ей
   * всё равно не было бы веры, а поле в контракте создавало бы обратное
   * впечатление.
   */
  applyMove(playerId: string, path: Cell[], now = Date.now()): MoveOutcome {
    const state = this.players.get(playerId);
    if (!state) return { ok: false, reason: 'not-in-duel' };
    if (this.isOver(now)) return { ok: false, reason: 'duel-over' };
    const elapsed = this.elapsed(now);
    if (elapsed < state.lastMoveAt + MIN_MOVE_GAP) return { ok: false, reason: 'too-fast' };
    if (state.run) return this.applyTap(playerId, state, path, elapsed);

    const phase = phaseColorAt(this.seed, elapsed, DEFAULT_CONFIG, this.claims);
    const result = applyMove(state.board, path, DEFAULT_CONFIG, phase);
    if (typeof result === 'string') return { ok: false, reason: result };

    state.board = result.board;
    state.score += result.points;
    state.lastMoveAt = elapsed;
    // Записываем темп: позже этот матч может стать призраком для другого игрока.
    state.log.push({ t: Number(elapsed.toFixed(2)), points: result.points });
    // И сам ход: сид плюс пути цепочек полностью восстанавливают партию.
    state.moves.push({
      path: path.map((cell) => ({ r: cell.r, c: cell.c })),
      t: Number(elapsed.toFixed(2)),
    });

    // Заявка на цвет: окно решают серверные часы, поэтому её объявляем
    // отсюда — и обоим сразу. Своя заявка приходит игроку тем же путём,
    // что и чужая, иначе у границы окна клиент разошёлся бы с сервером.
    const claim = claimFrom(
      result.color,
      path.length,
      Number(elapsed.toFixed(3)),
      DEFAULT_CONFIG,
    );
    if (claim) {
      this.claims.push({ ...claim, by: playerId });
      for (const [id, other] of this.players) {
        if (other.ghost) continue;
        other.player.send({ type: 'claim', ...claim, mine: id === playerId });
      }
    }

    const opponent = this.opponentOf(playerId);
    if (opponent && !opponent.ghost) {
      opponent.player.send({ type: 'opponent', score: state.score });
    }
    return { ok: true, score: state.score, points: result.points };
  }

  /**
   * Касание в дуэли на заказах. Правила те же, что в одиночном заходе, и
   * считает их то же ядро — сервер лишь подставляет своё время: клиентской
   * секунде тут веры не больше, чем в цепочках.
   */
  private applyTap(
    playerId: string,
    state: PlayerState,
    path: Cell[],
    elapsed: number,
  ): MoveOutcome {
    const cell = path[0];
    if (!cell || !state.run) return { ok: false, reason: 'not-in-duel' };
    const before = state.run.score;
    const tapped = tapOrder(state.run, cell, elapsed, DEFAULT_CONFIG);
    if (typeof tapped === 'string') return { ok: false, reason: tapped };

    state.run = tapped.run;
    state.board = tapped.run.board;
    const points = tapped.run.score - before;
    state.score = tapped.run.score;
    state.lastMoveAt = elapsed;
    if (points > 0) state.log.push({ t: Number(elapsed.toFixed(2)), points });
    state.moves.push({
      path: [{ r: cell.r, c: cell.c }],
      t: Number(elapsed.toFixed(2)),
    });
    this.tellOpponent(playerId, state);
    return { ok: true, score: state.score, points };
  }

  /** Сообщает сопернику новый счёт, а в заказах — и запас сбоев. */
  private tellOpponent(playerId: string, state: PlayerState): void {
    const opponent = this.opponentOf(playerId);
    if (!opponent || opponent.ghost) return;
    opponent.player.send({
      type: 'opponent',
      score: state.score,
      ...(state.run ? { fails: state.run.fails } : {}),
    });
  }

  /**
   * Доводит заказы до текущей секунды. Окно кончается временем, а не
   * ходом, — без этого игрок, переставший играть, не набирал бы сбоев
   * вовсе, и запас был бы наказанием только для тех, кто пробует.
   *
   * Возвращает того, у кого запас кончился: для матча это конец.
   */
  tick(now = Date.now()): string | null {
    if (this.finished || this.kind !== 'order') return null;
    const elapsed = this.elapsed(now);
    for (const [id, state] of this.players) {
      if (!state.run || state.ghost) continue;
      state.run = tickOrder(state.run, elapsed, DEFAULT_CONFIG);
      state.board = state.run.board;
      if (state.run.over) return id;
    }
    return null;
  }

  scoreOf(playerId: string): number {
    return this.players.get(playerId)?.score ?? 0;
  }

  nameOf(playerId: string): string {
    return this.players.get(playerId)?.player.name ?? '';
  }

  /** Подменяет канал связи — игрок вернулся с новым соединением. */
  reattach(playerId: string, player: DuelPlayer): boolean {
    const state = this.players.get(playerId);
    if (!state || state.ghost || this.finished) return false;
    state.player = player;
    return true;
  }

  /** Полное состояние матча для вернувшегося игрока. */
  snapshot(playerId: string, now = Date.now()): DuelSnapshot | undefined {
    const state = this.players.get(playerId);
    const opponent = this.opponentOf(playerId);
    if (!state || !opponent) return undefined;
    const run = state.run;
    return {
      seed: this.seed,
      kind: this.kind,
      ...(run
        ? {
            order: {
              ...orderWindow(run, this.elapsed(now), DEFAULT_CONFIG),
              fails: run.fails,
            },
          }
        : {}),
      grid: state.board.grid.map((row) =>
        row.map((dot) => ({ color: dot.color, charged: dot.charged })),
      ),
      score: state.score,
      opponentScore: opponent.score,
      opponent: opponent.player.name,
      opponentMarks: cleanMarks(opponent.player.marks ?? []),
      ghost: opponent.ghost,
      ...(opponent.ghost || !opponent.player.code ? {} : { opponentCode: opponent.player.code }),
      remaining: Math.max(0, this.duration - this.elapsed(now)),
      streak: state.board.surgeStreak,
      claims: this.claims.map(({ by, ...claim }) => ({ ...claim, mine: by === playerId })),
    };
  }

  isGhost(playerId: string): boolean {
    return this.players.get(playerId)?.ghost ?? false;
  }

  /** Темп набора очков игрока — материал для будущего призрака. */
  logOf(playerId: string): ScorePoint[] {
    return this.players.get(playerId)?.log ?? [];
  }

  /** Ходы игрока — материал для реплея. */
  movesOf(playerId: string): MoveLog[] {
    return this.players.get(playerId)?.moves ?? [];
  }

  /**
   * Заявки матча — материал для реплея. Без них запись не воспроизвести:
   * цвет фазы решали оба игрока, а ходы сохраняются только свои.
   */
  claimLog(): DuelClaim[] {
    return this.claims;
  }

  /** Начисляет призраку очередную порцию очков и показывает их сопернику. */
  advanceGhost(playerId: string, points: number): void {
    const state = this.players.get(playerId);
    if (!state?.ghost || this.finished) return;
    state.score += points;
    const opponent = this.opponentOf(playerId);
    if (opponent && !opponent.ghost) {
      opponent.player.send({ type: 'opponent', score: state.score });
    }
  }

  /** Досрочно проставляет счёт «призраку» — он играет по записи. */
  setGhostScore(playerId: string, score: number): void {
    const state = this.players.get(playerId);
    if (state?.ghost) state.score = score;
  }

  /**
   * Завершает матч и рассылает результаты. Повторный вызов безопасен.
   * forfeitedBy — техническое поражение (игрок ушёл): исход не зависит
   * от счёта, иначе уход при равном счёте давал бы ничью.
   *
   * Результаты возвращаются наружу: рейтинг считается уже после, поэтому
   * отправку сообщения о нём берёт на себя вызывающая сторона.
   */
  finish(forfeitedBy?: string): DuelOutcome[] {
    if (this.finished) return [];
    this.finished = true;
    const results: DuelOutcome[] = [];
    for (const [id, state] of this.players) {
      const opponent = this.opponentOf(id);
      if (state.ghost || !opponent) continue;
      const mine = state.score;
      const theirs = opponent.score;
      const outcome =
        forfeitedBy !== undefined
          ? forfeitedBy === id
            ? 'loss'
            : 'win'
          : mine > theirs
            ? 'win'
            : mine < theirs
              ? 'loss'
              : 'draw';
      state.player.send({ type: 'finished', score: mine, opponentScore: theirs, outcome });
      results.push({
        playerId: id,
        player: state.player,
        outcome,
        score: mine,
        opponentScore: theirs,
        opponentIsGhost: opponent.ghost,
      });
    }
    return results;
  }

  /** Игрок вышел: матч засчитывается сопернику. */
  abandon(playerId: string): void {
    if (this.finished) return;
    if (!this.players.has(playerId) || !this.opponentOf(playerId)) return;
    this.finish(playerId);
  }
}
