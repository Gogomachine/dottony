import type { Cell } from '@doton/core';
import type { DuelClientMessage, DuelServerMessage } from '@doton/protocol';
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

  constructor(private readonly onMessage: DuelHandler) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Открывает соединение и встаёт в очередь. room — код приватной комнаты. */
  connect(room?: string): void {
    this.close();
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
      this.send(room ? { type: 'join', room } : { type: 'join' });
    });
    socket.addEventListener('message', (event) => {
      try {
        this.onMessage(JSON.parse(String(event.data)) as DuelServerMessage);
      } catch {
        this.onMessage({ type: 'error', error: 'bad-message' });
      }
    });
    socket.addEventListener('error', () => {
      this.onMessage({ type: 'error', error: 'network' });
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
    });
  }

  move(path: Cell[], t: number): void {
    this.send({ type: 'move', path, t: Number(t.toFixed(3)) });
  }

  private send(message: DuelClientMessage): void {
    if (this.connected) this.socket!.send(JSON.stringify(message));
  }

  /** Закрывает матч: сервер засчитает уход как поражение. */
  close(): void {
    if (!this.socket) return;
    if (this.connected) this.send({ type: 'leave' });
    this.socket.close();
    this.socket = null;
  }
}

/** Код приватной комнаты из ссылки-приглашения. */
export function roomFromLocation(): string | null {
  const room = new URLSearchParams(location.search).get('room');
  return room && room.length >= 4 ? room.slice(0, 16) : null;
}

export function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (const value of crypto.getRandomValues(new Uint8Array(6))) {
    code += alphabet[value % alphabet.length];
  }
  return code;
}

export function inviteLink(room: string): string {
  const url = new URL(location.href);
  url.search = `?room=${room}`;
  return url.toString();
}
