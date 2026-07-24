import Database from 'better-sqlite3';

/**
 * Хранилище на SQLite: ноль внешних сервисов, синхронный доступ, идеально
 * для тестов. Схема нарочно минимальная — при переезде на Postgres меняется
 * только этот модуль.
 */

export interface UserRow {
  id: string;
  name: string;
  tg_id: string | null;
}

export interface RunRow {
  user_id: string;
  date: string;
  score: number;
  name: string;
}

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tg_id TEXT UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS daily_runs (
        user_id TEXT NOT NULL REFERENCES users(id),
        date TEXT NOT NULL,
        score INTEGER NOT NULL,
        moves TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_runs_date_score
        ON daily_runs (date, score DESC);
    `);
  }

  createUser(id: string, name: string, tgId: string | null = null): UserRow {
    this.db
      .prepare('INSERT INTO users (id, name, tg_id) VALUES (?, ?, ?)')
      .run(id, name, tgId);
    return { id, name, tg_id: tgId };
  }

  userById(id: string): UserRow | undefined {
    return this.db.prepare('SELECT id, name, tg_id FROM users WHERE id = ?').get(id) as
      | UserRow
      | undefined;
  }

  userByTelegramId(tgId: string): UserRow | undefined {
    return this.db.prepare('SELECT id, name, tg_id FROM users WHERE tg_id = ?').get(tgId) as
      | UserRow
      | undefined;
  }

  renameUser(id: string, name: string): void {
    this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
  }

  hasRun(userId: string, date: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM daily_runs WHERE user_id = ? AND date = ?')
        .get(userId, date) !== undefined
    );
  }

  insertRun(userId: string, date: string, score: number, movesJson: string): void {
    this.db
      .prepare('INSERT INTO daily_runs (user_id, date, score, moves) VALUES (?, ?, ?, ?)')
      .run(userId, date, score, movesJson);
  }

  /** Место в таблице дня: 1 + число результатов строго выше. */
  rank(date: string, score: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS above FROM daily_runs WHERE date = ? AND score > ?')
      .get(date, score) as { above: number };
    return row.above + 1;
  }

  top(date: string, limit: number): RunRow[] {
    return this.db
      .prepare(
        `SELECT r.user_id, r.date, r.score, u.name
         FROM daily_runs r JOIN users u ON u.id = r.user_id
         WHERE r.date = ?
         ORDER BY r.score DESC, r.created_at ASC
         LIMIT ?`,
      )
      .all(date, limit) as RunRow[];
  }

  runOf(userId: string, date: string): RunRow | undefined {
    return this.db
      .prepare(
        `SELECT r.user_id, r.date, r.score, u.name
         FROM daily_runs r JOIN users u ON u.id = r.user_id
         WHERE r.user_id = ? AND r.date = ?`,
      )
      .get(userId, date) as RunRow | undefined;
  }

  close(): void {
    this.db.close();
  }
}
