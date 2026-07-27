import { randomInt } from 'node:crypto';
import { DUEL_SECONDS } from '@doton/protocol';
import type { Cell } from '@doton/core';
import { Duel, type DuelPlayer, type MoveOutcome } from './duel.js';

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
  players: { id: string; name: string; score: number }[];
}

interface Waiting {
  player: DuelPlayer;
  room: string | undefined;
  since: number;
}

export interface MatchmakerOptions {
  /** Куда сообщать о завершённых матчах (запись в БД). */
  onFinish?: (result: MatchResult) => void;
  /** Подменяется в тестах, чтобы не ждать реальные секунды. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  clearTimer?: (handle: NodeJS.Timeout | number) => void;
}

export class Matchmaker {
  private readonly waiting: Waiting[] = [];
  private readonly duels = new Map<string, Duel>();
  /** playerId → активная дуэль. */
  private readonly byPlayer = new Map<string, Duel>();
  private readonly timers = new Map<string, NodeJS.Timeout | number>();
  private readonly setTimer: NonNullable<MatchmakerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<MatchmakerOptions['clearTimer']>;

  constructor(private readonly options: MatchmakerOptions = {}) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
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
      return;
    }

    const [opponent] = this.waiting.splice(index, 1);
    this.start(opponent!.player, player);
  }

  private start(a: DuelPlayer, b: DuelPlayer): void {
    const seed = randomInt(0, 0xffffffff);
    const duel = new Duel(seed, a, b);
    this.duels.set(duel.id, duel);
    for (const id of duel.playerIds) this.byPlayer.set(id, duel);
    duel.announce();

    // Небольшой запас поверх длительности: последний ход игрока может
    // прийти впритык к сирене.
    const handle = this.setTimer(() => this.settle(duel), (DUEL_SECONDS + 1) * 1000);
    this.timers.set(duel.id, handle);
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

    const duel = this.byPlayer.get(playerId);
    if (!duel) return;
    if (!options.silent) duel.abandon(playerId);
    this.settle(duel);
  }

  private settle(duel: Duel): void {
    if (!this.duels.has(duel.id)) return;
    duel.finish();

    const handle = this.timers.get(duel.id);
    if (handle !== undefined) this.clearTimer(handle);
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
      })),
    });
  }

  /** Освобождает таймеры при остановке сервера. */
  close(): void {
    for (const handle of this.timers.values()) this.clearTimer(handle);
    this.timers.clear();
  }

  get stats(): { waiting: number; duels: number } {
    return { waiting: this.waiting.length, duels: this.duels.size };
  }
}
