import { createClient, type Client } from '@libsql/client';

/**
 * Хранилище на libSQL (диалект SQLite). Один и тот же код работает с
 * файлом на диске, базой в памяти (тесты) и облачной Turso — меняется
 * только строка подключения. При переезде на другую СУБД правится
 * только этот модуль.
 */

export interface UserRow {
  id: string;
  name: string;
  tg_id: string | null;
}

export interface RunRow {
  date: string;
  score: number;
  name: string;
}

export interface StoreOptions {
  url: string;
  authToken?: string;
}

export class Store {
  private readonly client: Client;

  constructor(options: StoreOptions) {
    this.client = createClient(
      options.authToken ? { url: options.url, authToken: options.authToken } : { url: options.url },
    );
  }

  /** Создаёт схему. Вызывается один раз при старте приложения. */
  async migrate(): Promise<void> {
    await this.client.batch(
      [
        `CREATE TABLE IF NOT EXISTS users (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           tg_id TEXT UNIQUE,
           created_at TEXT NOT NULL DEFAULT (datetime('now'))
         )`,
        `CREATE TABLE IF NOT EXISTS daily_runs (
           user_id TEXT NOT NULL REFERENCES users(id),
           date TEXT NOT NULL,
           score INTEGER NOT NULL,
           moves TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (datetime('now')),
           PRIMARY KEY (user_id, date)
         )`,
        `CREATE INDEX IF NOT EXISTS idx_daily_runs_date_score
           ON daily_runs (date, score DESC)`,
        `CREATE TABLE IF NOT EXISTS duels (
           id TEXT PRIMARY KEY,
           seed INTEGER NOT NULL,
           created_at TEXT NOT NULL DEFAULT (datetime('now'))
         )`,
        `CREATE TABLE IF NOT EXISTS duel_players (
           duel_id TEXT NOT NULL REFERENCES duels(id),
           user_id TEXT NOT NULL,
           score INTEGER NOT NULL,
           PRIMARY KEY (duel_id, user_id)
         )`,
        `CREATE INDEX IF NOT EXISTS idx_duel_players_user
           ON duel_players (user_id)`,
      ],
      'write',
    );
  }

  /** Сохраняет завершённый матч: сама дуэль и результат каждого игрока. */
  async saveDuel(
    id: string,
    seed: number,
    players: { id: string; score: number }[],
  ): Promise<void> {
    await this.client.batch(
      [
        { sql: 'INSERT INTO duels (id, seed) VALUES (?, ?)', args: [id, seed] },
        ...players.map((player) => ({
          sql: 'INSERT INTO duel_players (duel_id, user_id, score) VALUES (?, ?, ?)',
          args: [id, player.id, player.score],
        })),
      ],
      'write',
    );
  }

  /** Сводка дуэлей игрока: сыграно и выиграно. */
  async duelRecord(userId: string): Promise<{ played: number; won: number }> {
    const result = await this.client.execute({
      sql: `SELECT
              COUNT(*) AS played,
              SUM(CASE WHEN mine.score > COALESCE(theirs.score, -1) THEN 1 ELSE 0 END) AS won
            FROM duel_players mine
            LEFT JOIN duel_players theirs
              ON theirs.duel_id = mine.duel_id AND theirs.user_id <> mine.user_id
            WHERE mine.user_id = ?`,
      args: [userId],
    });
    const row = result.rows[0];
    return {
      played: Number(row?.played ?? 0),
      won: Number(row?.won ?? 0),
    };
  }

  async createUser(id: string, name: string, tgId: string | null = null): Promise<UserRow> {
    await this.client.execute({
      sql: 'INSERT INTO users (id, name, tg_id) VALUES (?, ?, ?)',
      args: [id, name, tgId],
    });
    return { id, name, tg_id: tgId };
  }

  async userByTelegramId(tgId: string): Promise<UserRow | undefined> {
    const result = await this.client.execute({
      sql: 'SELECT id, name, tg_id FROM users WHERE tg_id = ?',
      args: [tgId],
    });
    return result.rows[0] as unknown as UserRow | undefined;
  }

  async renameUser(id: string, name: string): Promise<void> {
    await this.client.execute({
      sql: 'UPDATE users SET name = ? WHERE id = ?',
      args: [name, id],
    });
  }

  async hasRun(userId: string, date: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: 'SELECT 1 FROM daily_runs WHERE user_id = ? AND date = ?',
      args: [userId, date],
    });
    return result.rows.length > 0;
  }

  async insertRun(userId: string, date: string, score: number, movesJson: string): Promise<void> {
    await this.client.execute({
      sql: 'INSERT INTO daily_runs (user_id, date, score, moves) VALUES (?, ?, ?, ?)',
      args: [userId, date, score, movesJson],
    });
  }

  /** Место в таблице дня: 1 + число результатов строго выше. */
  async rank(date: string, score: number): Promise<number> {
    const result = await this.client.execute({
      sql: 'SELECT COUNT(*) AS above FROM daily_runs WHERE date = ? AND score > ?',
      args: [date, score],
    });
    return Number(result.rows[0]!.above) + 1;
  }

  async top(date: string, limit: number): Promise<RunRow[]> {
    const result = await this.client.execute({
      sql: `SELECT r.date, r.score, u.name
            FROM daily_runs r JOIN users u ON u.id = r.user_id
            WHERE r.date = ?
            ORDER BY r.score DESC, r.created_at ASC
            LIMIT ?`,
      args: [date, limit],
    });
    return result.rows as unknown as RunRow[];
  }

  async runOf(userId: string, date: string): Promise<RunRow | undefined> {
    const result = await this.client.execute({
      sql: `SELECT r.date, r.score, u.name
            FROM daily_runs r JOIN users u ON u.id = r.user_id
            WHERE r.user_id = ? AND r.date = ?`,
      args: [userId, date],
    });
    return result.rows[0] as unknown as RunRow | undefined;
  }

  close(): void {
    this.client.close();
  }
}
