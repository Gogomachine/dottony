import { randomUUID } from 'node:crypto';
import {
  applyMove,
  createBoard,
  phaseColorAt,
  seedRng,
  DEFAULT_CONFIG,
  type Board,
  type Cell,
} from '@doton/core';
import {
  DUEL_SECONDS,
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

/** Минимальный интервал между ходами: человек физически не жмёт чаще. */
const MIN_MOVE_GAP = 0.1;

export interface DuelPlayer {
  id: string;
  name: string;
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
  private finished = false;

  constructor(
    seed: number,
    a: DuelPlayer,
    b: DuelPlayer,
    options: { ghostB?: boolean; now?: number } = {},
  ) {
    this.seed = seed;
    this.startedAt = options.now ?? Date.now();
    for (const [player, ghost] of [
      [a, false],
      [b, options.ghostB ?? false],
    ] as const) {
      this.players.set(player.id, {
        player,
        board: createBoard(seedRng(seed), DEFAULT_CONFIG),
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
    return this.finished || this.elapsed(now) > DUEL_SECONDS;
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
        duration: DUEL_SECONDS,
        opponent: opponent.player.name,
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
   */
  applyMove(playerId: string, path: Cell[], t: number, now = Date.now()): MoveOutcome {
    const state = this.players.get(playerId);
    if (!state) return { ok: false, reason: 'not-in-duel' };
    if (this.isOver(now)) return { ok: false, reason: 'duel-over' };
    // Время берём серверное: присланному t доверять нельзя, он лишь
    // помогает отсеять всплески частоты.
    const elapsed = this.elapsed(now);
    if (elapsed < state.lastMoveAt + MIN_MOVE_GAP) return { ok: false, reason: 'too-fast' };

    const phase = phaseColorAt(this.seed, elapsed, DEFAULT_CONFIG);
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

    const opponent = this.opponentOf(playerId);
    if (opponent && !opponent.ghost) {
      opponent.player.send({ type: 'opponent', score: state.score });
    }
    return { ok: true, score: state.score, points: result.points };
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
    return {
      seed: this.seed,
      grid: state.board.grid.map((row) =>
        row.map((dot) => ({ color: dot.color, charged: dot.charged })),
      ),
      score: state.score,
      opponentScore: opponent.score,
      opponent: opponent.player.name,
      ghost: opponent.ghost,
      ...(opponent.ghost || !opponent.player.code ? {} : { opponentCode: opponent.player.code }),
      remaining: Math.max(0, DUEL_SECONDS - this.elapsed(now)),
      streak: state.board.surgeStreak,
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
