import type { Cell } from '@doton/core';
import type { DuelClientMessage, DuelKind, DuelServerMessage } from '@doton/protocol';
import { apiBase, authToken } from './api';

/**
 * Клиент дуэли поверх WebSocket.
 *
 * Счёт ведёт сервер: каждый ход отправляется на проверку, и в HUD
 * попадает подтверждённое значение. Локально считать нельзя — иначе
 * расхождение с сервером будет видно игроку как «съеденные» очки.
 */

export type DuelHandler = (message: DuelServerMessage) => void;

export class DuelConnection {
  private socket: WebSocket | null = null;
  private room: string | undefined;
  /** На чём играем: механику сервер должен знать с первой же заявки. */
  private kind: DuelKind = 'chain';
  /** Матч идёт: обрыв связи нужно чинить переподключением, а не сдачей. */
  private active = false;
  private retries = 0;
  private retryTimer = 0;
  private closeTimer = 0;

  constructor(
    private readonly onMessage: DuelHandler,
    /** Сообщает интерфейсу, что связь пропала и идёт восстановление. */
    private readonly onConnectionState?: (state: 'lost' | 'restored') => void,
  ) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Помечает, что матч начался: с этого момента обрывы восстанавливаем. */
  markActive(): void {
    this.active = true;
  }

  /** Открывает соединение и встаёт в очередь. room — код приватной комнаты. */
  connect(room?: string, kind: DuelKind = 'chain'): void {
    this.room = room;
    this.kind = kind;
    this.retries = 0;
    clearTimeout(this.closeTimer);
    this.close({ keepActive: false });
    this.open();
  }

  private open(): void {
    const token = authToken();
    if (!token) {
      this.onMessage({ type: 'error', error: 'unauthorized' });
      return;
    }
    const url = new URL('/duel', apiBase());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token);

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.retries > 0) this.onConnectionState?.('restored');
      this.retries = 0;
      // Сервер сам поймёт, вернулись мы в идущий матч или встаём в очередь.
      this.send(
        this.room
          ? { type: 'join', room: this.room, kind: this.kind }
          : { type: 'join', kind: this.kind },
      );
    });
    socket.addEventListener('message', (event) => {
      try {
        this.onMessage(JSON.parse(String(event.data)) as DuelServerMessage);
      } catch {
        this.onMessage({ type: 'error', error: 'bad-message' });
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      // Матч на сервере продолжается — пробуем вернуться в него.
      if (this.active) this.scheduleReconnect();
    });
  }

  /** Повторные попытки с нарастающей паузой: сеть после сворачивания оживает не сразу. */
  private scheduleReconnect(): void {
    if (this.retries === 0) this.onConnectionState?.('lost');
    if (this.retries >= 8) return;
    const delay = Math.min(300 * 2 ** this.retries, 4000);
    this.retries++;
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  move(path: Cell[]): void {
    this.send({ type: 'move', path });
  }

  private send(message: DuelClientMessage): void {
    if (this.connected) this.socket!.send(JSON.stringify(message));
  }

  /**
   * Матч окончен: соединение больше не нужно, но закрывать его сразу нельзя.
   * Рейтинг сервер досылает отдельным сообщением сразу после результата —
   * закрыв сокет по первому же «finished», клиент бы его не дождался.
   */
  closeAfterResults(graceMs = 4000): void {
    this.active = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.closeTimer);
    this.closeTimer = window.setTimeout(() => this.close(), graceMs);
  }

  /**
   * Осознанный выход: сервер засчитает поражение. Обрыв связи сюда
   * не относится — он лечится переподключением.
   */
  close(options: { keepActive?: boolean } = {}): void {
    if (!options.keepActive) this.active = false;
    clearTimeout(this.closeTimer);
    clearTimeout(this.retryTimer);
    this.retries = 0;
    if (!this.socket) return;
    if (this.connected) this.send({ type: 'leave' });
    this.socket.close();
    this.socket = null;
  }
}

export function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (const value of crypto.getRandomValues(new Uint8Array(6))) {
    code += alphabet[value % alphabet.length];
  }
  return code;
}
