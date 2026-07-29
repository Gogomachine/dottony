import { randomInt } from 'node:crypto';
import { DUEL_SECONDS } from '@doton/protocol';
import type { Cell } from '@doton/core';
import { Duel, type DuelPlayer, type MoveOutcome, type ScorePoint } from './duel.js';
import { ghostSchedule, type Ghost } from './ghost.js';

/**
 * Подбор соперников и жизненный цикл матчей.
 *
 * Матчи живут в памяти процесса: они короткие (90 секунд), а результат
 * сохраняется отдельно. Этого достаточно, пока сервер один; при
 * нескольких инстансах сюда встанет общее хранилище.
 */

export interface MatchResult {
  duelId: string;
  seed: number;
  players: { id: string; name: string; score: number; log: ScorePoint[]; ghost: boolean }[];
}

interface Waiting {
  player: DuelPlayer;
  room: string | undefined;
  since: number;
}

export interface MatchmakerOptions {
  /** Куда сообщать о завершённых матчах (запись в БД). */
  onFinish?: (result: MatchResult) => void;
  /**
   * Ищет призрака для игрока, если живого соперника нет.
   * Возвращает undefined, когда призраков быть не должно.
   */
  findGhost?: (playerId: string) => Promise<Ghost | undefined>;
  /** Сколько ждать живого соперника, прежде чем звать призрака, мс. */
  ghostAfterMs?: number;
  /** Куда сообщать о сбоях подбора призрака. */
  onError?: (error: unknown) => void;
  /** Подменяются в тестах, чтобы не ждать реальные секунды. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  clearTimer?: (handle: NodeJS.Timeout | number) => void;
}

const DEFAULT_GHOST_AFTER_MS = 12_000;

export class Matchmaker {
  private readonly waiting: Waiting[] = [];
  private readonly duels = new Map<string, Duel>();
  /** playerId → активная дуэль. */
  private readonly byPlayer = new Map<string, Duel>();
  /** Таймеры дуэлей и отложенные начисления призракам. */
  private readonly timers = new Map<string, (NodeJS.Timeout | number)[]>();
  private readonly ghostTimers = new Map<string, NodeJS.Timeout | number>();
  private readonly setTimer: NonNullable<MatchmakerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<MatchmakerOptions['clearTimer']>;
  private readonly ghostAfterMs: number;

  constructor(private readonly options: MatchmakerOptions = {}) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.ghostAfterMs = options.ghostAfterMs ?? DEFAULT_GHOST_AFTER_MS;
  }

  /** Ставит игрока в очередь или сразу сводит с ожидающим соперником. */
  join(player: DuelPlayer, room?: string): void {
    // Повторный join из другой вкладки не должен плодить сущности.
    this.leave(player.id, { silent: true });

    const index = this.waiting.findIndex(
      (entry) => entry.room === room && entry.player.id !== player.id,
    );
    if (index === -1) {
      this.waiting.push({ player, room, since: Date.now() });
      player.send(room ? { type: 'searching', room } : { type: 'searching' });
      // В приватную комнату зовут конкретного друга — призрак там не нужен.
      if (!room && this.options.findGhost) this.scheduleGhost(player);
      return;
    }

    const [opponent] = this.waiting.splice(index, 1);
    this.cancelGhostWait(opponent!.player.id);
    this.start(opponent!.player, player);
  }

  /** Через паузу ожидания подставляет призрака, если игрок всё ещё в очереди. */
  private scheduleGhost(player: DuelPlayer): void {
    const handle = this.setTimer(() => {
      this.ghostTimers.delete(player.id);
      const index = this.waiting.findIndex((entry) => entry.player.id === player.id);
      if (index === -1) return;

      void this.options
        .findGhost?.(player.id)
        .then((ghost) => {
          if (!ghost) return;
          // Пока искали, мог найтись живой соперник.
          const stillWaiting = this.waiting.findIndex((e) => e.player.id === player.id);
          if (stillWaiting === -1) return;
          this.waiting.splice(stillWaiting, 1);
          this.startWithGhost(player, ghost);
        })
        .catch((error: unknown) => {
          // Без призрака игрок останется ждать живого соперника — молча
          // проглатывать причину нельзя, иначе поломка выглядит как «ничего
          // не происходит» и не видна в логах.
          this.options.onError?.(error);
        });
    }, this.ghostAfterMs);
    this.ghostTimers.set(player.id, handle);
  }

  private cancelGhostWait(playerId: string): void {
    const handle = this.ghostTimers.get(playerId);
    if (handle !== undefined) this.clearTimer(handle);
    this.ghostTimers.delete(playerId);
  }

  private start(a: DuelPlayer, b: DuelPlayer): void {
    const seed = randomInt(0, 0xffffffff);
    this.launch(new Duel(seed, a, b));
  }

  /** Матч против записи: играем на её сиде, чтобы поле было тем же самым. */
  private startWithGhost(player: DuelPlayer, ghost: Ghost): void {
    const ghostPlayer: DuelPlayer = {
      id: `ghost:${ghost.name}:${Date.now()}`,
      name: ghost.name,
      send: () => {},
    };
    const duel = new Duel(ghost.seed, player, ghostPlayer, { ghostB: true });
    this.launch(duel);

    // Призрак «играет»: начисляем очки по записанному темпу.
    const handles = this.timers.get(duel.id) ?? [];
    for (const step of ghostSchedule(ghost)) {
      handles.push(
        this.setTimer(() => duel.advanceGhost(ghostPlayer.id, step.points), step.delayMs),
      );
    }
    this.timers.set(duel.id, handles);
  }

  private launch(duel: Duel): void {
    this.duels.set(duel.id, duel);
    for (const id of duel.playerIds) this.byPlayer.set(id, duel);
    duel.announce();

    // Небольшой запас поверх длительности: последний ход игрока может
    // прийти впритык к сирене.
    const handle = this.setTimer(() => this.settle(duel), (DUEL_SECONDS + 1) * 1000);
    this.timers.set(duel.id, [...(this.timers.get(duel.id) ?? []), handle]);
  }

  move(playerId: string, path: Cell[], t: number): MoveOutcome {
    const duel = this.byPlayer.get(playerId);
    if (!duel) return { ok: false, reason: 'not-in-duel' };
    const outcome = duel.applyMove(playerId, path, t);
    if (duel.isOver()) this.settle(duel);
    return outcome;
  }

  /** Уход игрока: из очереди — молча, из матча — с поражением. */
  leave(playerId: string, options: { silent?: boolean } = {}): void {
    const index = this.waiting.findIndex((entry) => entry.player.id === playerId);
    if (index !== -1) this.waiting.splice(index, 1);
    this.cancelGhostWait(playerId);

    const duel = this.byPlayer.get(playerId);
    if (!duel) return;
    if (!options.silent) duel.abandon(playerId);
    this.settle(duel);
  }

  private settle(duel: Duel): void {
    if (!this.duels.has(duel.id)) return;
    duel.finish();

    for (const handle of this.timers.get(duel.id) ?? []) this.clearTimer(handle);
    this.timers.delete(duel.id);
    this.duels.delete(duel.id);
    for (const id of duel.playerIds) this.byPlayer.delete(id);

    this.options.onFinish?.({
      duelId: duel.id,
      seed: duel.seed,
      players: duel.playerIds.map((id) => ({
        id,
        name: duel.nameOf(id),
        score: duel.scoreOf(id),
        log: duel.logOf(id),
        ghost: duel.isGhost(id),
      })),
    });
  }

  /** Освобождает таймеры при остановке сервера. */
  close(): void {
    for (const handles of this.timers.values()) {
      for (const handle of handles) this.clearTimer(handle);
    }
    this.timers.clear();
    for (const handle of this.ghostTimers.values()) this.clearTimer(handle);
    this.ghostTimers.clear();
  }

  get stats(): { waiting: number; duels: number } {
    return { waiting: this.waiting.length, duels: this.duels.size };
  }
}
