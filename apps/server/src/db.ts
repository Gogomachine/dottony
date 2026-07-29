import { createClient, type Client } from '@libsql/client';
import { newRating, PLACEMENT_GAMES, type Rating } from '@doton/core';

/**
 * Хранилище на libSQL (диалект SQLite). Один и тот же код работает с
 * файлом на диске, базой в памяти (тесты) и облачной Turso — меняется
 * только строка подключения. При переезде на другую СУБД правится
 * только этот модуль.
 */

export interface UserRow {
  id: string;
  name: string;
}

/**
 * Способ входа в аккаунт. Игрок один, способов может быть несколько:
 * начал гостем, вошёл через Telegram, позже привяжет кошелёк TON.
 */
export type IdentityKind = 'guest' | 'telegram' | 'ton';

export interface Identity {
  kind: IdentityKind;
  externalId: string;
}

export interface RunRow {
  date: string;
  score: number;
  name: string;
}

/** Строка истории матчей. Соперника может не быть: он ушёл или был призраком. */
export interface DuelHistoryRow {
  duelId: string;
  playedAt: string;
  score: number;
  outcome: string | null;
  opponentName: string | null;
  opponentScore: number | null;
  opponentGhost: boolean;
  ratingBefore: number | null;
  ratingAfter: number | null;
  hasReplay: boolean;
}

/** Рейтинг игрока вместе с историей: когда играл и сколько рейтинговых матчей. */
export interface PlayerRating extends Rating {
  ratedAt: string | null;
  games: number;
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
           log TEXT NOT NULL DEFAULT '[]',
           PRIMARY KEY (duel_id, user_id)
         )`,
        `CREATE INDEX IF NOT EXISTS idx_duel_players_user
           ON duel_players (user_id)`,
        // Способы входа в один и тот же аккаунт: гость, Telegram, позже — кошелёк.
        // Личность отделена от игрока, поэтому новый способ входа не меняет схему.
        `CREATE TABLE IF NOT EXISTS identities (
           kind TEXT NOT NULL,
           external_id TEXT NOT NULL,
           user_id TEXT NOT NULL REFERENCES users(id),
           linked_at TEXT NOT NULL DEFAULT (datetime('now')),
           PRIMARY KEY (kind, external_id)
         )`,
        `CREATE INDEX IF NOT EXISTS idx_identities_user ON identities (user_id)`,
      ],
      'write',
    );

    // CREATE TABLE IF NOT EXISTS не меняет уже существующую таблицу, поэтому
    // колонки, добавленные после первого запуска, доливаем отдельно.
    await this.addColumnIfMissing('duel_players', 'log', "TEXT NOT NULL DEFAULT '[]'");
    // Рейтинг Glicko-2: сила, неуверенность в ней и волатильность.
    await this.addColumnIfMissing('users', 'rating', 'INTEGER NOT NULL DEFAULT 1500');
    await this.addColumnIfMissing('users', 'deviation', 'INTEGER NOT NULL DEFAULT 350');
    await this.addColumnIfMissing('users', 'volatility', 'REAL NOT NULL DEFAULT 0.06');
    await this.addColumnIfMissing('users', 'rated_at', 'TEXT');
    await this.addColumnIfMissing('users', 'rated_games', 'INTEGER NOT NULL DEFAULT 0');
    await this.addColumnIfMissing('duel_players', 'rating_before', 'INTEGER');
    await this.addColumnIfMissing('duel_players', 'rating_after', 'INTEGER');
    // Исход хранится явно: по счёту его не восстановить — сдача при 0:0
    // выглядит как ничья, хотя это поражение.
    await this.addColumnIfMissing('duel_players', 'outcome', 'TEXT');
    // Имя соперника на момент матча: после переименования история должна
    // показывать того, с кем ты играл, а у призрака своего users-ряда нет.
    await this.addColumnIfMissing('duel_players', 'name', 'TEXT');
    await this.addColumnIfMissing('duel_players', 'ghost', 'INTEGER NOT NULL DEFAULT 0');
    // Пути цепочек — из них собирается реплей. У матчей, сыгранных раньше,
    // их нет: там писался только темп набора очков.
    await this.addColumnIfMissing('duel_players', 'moves', 'TEXT');

    // Старые аккаунты знали только Telegram — переносим их в общий вид.
    // INSERT OR IGNORE делает перенос повторяемым.
    await this.client.execute(
      `INSERT OR IGNORE INTO identities (kind, external_id, user_id)
       SELECT 'telegram', tg_id, id FROM users WHERE tg_id IS NOT NULL`,
    );
    await this.client.execute(
      `INSERT OR IGNORE INTO identities (kind, external_id, user_id)
       SELECT 'guest', id, id FROM users WHERE tg_id IS NULL`,
    );
  }

  /** Идемпотентно добавляет колонку — безопасно на любой существующей базе. */
  private async addColumnIfMissing(
    table: string,
    column: string,
    definition: string,
  ): Promise<void> {
    const info = await this.client.execute(`PRAGMA table_info(${table})`);
    const exists = info.rows.some((row) => String(row.name) === column);
    if (exists) return;
    await this.client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /**
   * Сохраняет завершённый матч: саму дуэль, результат каждого игрока и темп
   * его игры. Темп нужен, чтобы матч потом мог стать призраком.
   */
  async saveDuel(
    id: string,
    seed: number,
    players: {
      id: string;
      name?: string;
      score: number;
      log?: unknown;
      moves?: unknown;
      outcome?: string;
      ghost?: boolean;
    }[],
  ): Promise<void> {
    await this.client.batch(
      [
        { sql: 'INSERT INTO duels (id, seed) VALUES (?, ?)', args: [id, seed] },
        ...players.map((player) => ({
          sql: `INSERT INTO duel_players
                  (duel_id, user_id, name, score, log, moves, outcome, ghost)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            player.id,
            player.name ?? null,
            player.score,
            JSON.stringify(player.log ?? []),
            player.moves === undefined ? null : JSON.stringify(player.moves),
            player.outcome ?? null,
            player.ghost ? 1 : 0,
          ],
        })),
      ],
      'write',
    );
  }

  /** Последние матчи игрока для личного кабинета. */
  async duelHistory(userId: string, limit: number): Promise<DuelHistoryRow[]> {
    const result = await this.client.execute({
      sql: `SELECT d.id, d.created_at, mine.score, mine.outcome,
                   mine.rating_before, mine.rating_after,
                   mine.moves IS NOT NULL AS has_replay,
                   theirs.score AS opponent_score,
                   theirs.ghost AS opponent_ghost,
                   COALESCE(theirs.name, u.name) AS opponent_name
            FROM duel_players mine
            JOIN duels d ON d.id = mine.duel_id
            LEFT JOIN duel_players theirs
              ON theirs.duel_id = mine.duel_id AND theirs.user_id <> mine.user_id
            LEFT JOIN users u ON u.id = theirs.user_id
            WHERE mine.user_id = ?
            ORDER BY d.created_at DESC, d.rowid DESC
            LIMIT ?`,
      args: [userId, limit],
    });
    return result.rows.map((row) => ({
      duelId: String(row.id),
      playedAt: String(row.created_at),
      score: Number(row.score),
      outcome: row.outcome === null ? null : String(row.outcome),
      opponentName: row.opponent_name === null ? null : String(row.opponent_name),
      opponentScore: row.opponent_score === null ? null : Number(row.opponent_score),
      opponentGhost: Number(row.opponent_ghost ?? 0) === 1,
      ratingBefore: row.rating_before === null ? null : Number(row.rating_before),
      ratingAfter: row.rating_after === null ? null : Number(row.rating_after),
      hasReplay: Number(row.has_replay ?? 0) === 1,
    }));
  }

  /**
   * Ходы игрока в матче вместе с сидом поля — этого достаточно, чтобы
   * прокрутить партию заново. Чужие матчи не отдаём.
   */
  async duelReplay(
    duelId: string,
    userId: string,
  ): Promise<{ seed: number; moves: string; score: number; opponentName: string | null } | undefined> {
    const result = await this.client.execute({
      sql: `SELECT d.seed, mine.moves, mine.score,
                   COALESCE(theirs.name, u.name) AS opponent_name
            FROM duel_players mine
            JOIN duels d ON d.id = mine.duel_id
            LEFT JOIN duel_players theirs
              ON theirs.duel_id = mine.duel_id AND theirs.user_id <> mine.user_id
            LEFT JOIN users u ON u.id = theirs.user_id
            WHERE mine.duel_id = ? AND mine.user_id = ?`,
      args: [duelId, userId],
    });
    const row = result.rows[0];
    if (!row || row.moves === null) return undefined;
    return {
      seed: Number(row.seed),
      moves: String(row.moves),
      score: Number(row.score),
      opponentName: row.opponent_name === null ? null : String(row.opponent_name),
    };
  }

  /**
   * Случайная запись для призрака, по возможности близкая по силе к
   * указанному счёту. Свои же записи исключаем: играть против себя странно.
   */
  async pickGhostRun(
    excludeUserId: string,
    targetScore: number,
  ): Promise<{ name: string; seed: number; score: number; log: string } | undefined> {
    const result = await this.client.execute({
      sql: `SELECT u.name, d.seed, p.score, p.log
            FROM duel_players p
            JOIN duels d ON d.id = p.duel_id
            JOIN users u ON u.id = p.user_id
            WHERE p.user_id <> ? AND p.log <> '[]' AND p.score > 0 AND p.ghost = 0
            ORDER BY ABS(p.score - ?) ASC, RANDOM()
            LIMIT 5`,
      args: [excludeUserId, targetScore],
    });
    if (result.rows.length === 0) return undefined;
    // Из ближайших по силе берём случайную — иначе соперник всегда один и тот же.
    const row = result.rows[Math.floor(Math.random() * result.rows.length)]!;
    return {
      name: String(row.name),
      seed: Number(row.seed),
      score: Number(row.score),
      log: String(row.log),
    };
  }

  /** Рейтинг игрока; для новичка — стартовые значения. */
  async ratingOf(userId: string): Promise<PlayerRating> {
    const result = await this.client.execute({
      sql: 'SELECT rating, deviation, volatility, rated_at, rated_games FROM users WHERE id = ?',
      args: [userId],
    });
    const row = result.rows[0];
    if (!row) return { ...newRating(), ratedAt: null, games: 0 };
    return {
      rating: Number(row.rating),
      deviation: Number(row.deviation),
      volatility: Number(row.volatility),
      ratedAt: row.rated_at === null ? null : String(row.rated_at),
      games: Number(row.rated_games),
    };
  }

  /** Сохраняет новый рейтинг и засчитывает ещё один рейтинговый матч. */
  async saveRating(userId: string, rating: Rating): Promise<void> {
    await this.client.execute({
      sql: `UPDATE users
            SET rating = ?, deviation = ?, volatility = ?,
                rated_at = datetime('now'), rated_games = rated_games + 1
            WHERE id = ?`,
      args: [rating.rating, rating.deviation, rating.volatility, userId],
    });
  }

  /** Запоминает, как матч сдвинул рейтинг — для истории и экрана результата. */
  async saveRatingChange(
    duelId: string,
    userId: string,
    before: number,
    after: number,
  ): Promise<void> {
    await this.client.execute({
      sql: 'UPDATE duel_players SET rating_before = ?, rating_after = ? WHERE duel_id = ? AND user_id = ?',
      args: [before, after, duelId, userId],
    });
  }

  /** Таблица лидеров по рейтингу: только прошедшие калибровку. */
  async ratingLeaderboard(limit: number): Promise<{ name: string; rating: number }[]> {
    const result = await this.client.execute({
      sql: `SELECT name, rating FROM users
            WHERE rated_games >= ?
            ORDER BY rating DESC, name ASC
            LIMIT ?`,
      args: [PLACEMENT_GAMES, limit],
    });
    return result.rows.map((row) => ({ name: String(row.name), rating: Number(row.rating) }));
  }

  /** Место игрока в рейтинге: 1 + число тех, кто выше. До калибровки — null. */
  async ratingRank(userId: string): Promise<number | null> {
    const me = await this.client.execute({
      sql: 'SELECT rating, rated_games FROM users WHERE id = ?',
      args: [userId],
    });
    const row = me.rows[0];
    if (!row || Number(row.rated_games) < PLACEMENT_GAMES) return null;
    const above = await this.client.execute({
      sql: 'SELECT COUNT(*) AS above FROM users WHERE rated_games >= ? AND rating > ?',
      args: [PLACEMENT_GAMES, Number(row.rating)],
    });
    return Number(above.rows[0]!.above) + 1;
  }

  /** Средний счёт игрока в дуэлях — ориентир для подбора призрака. */
  async averageDuelScore(userId: string): Promise<number | undefined> {
    const result = await this.client.execute({
      sql: 'SELECT AVG(score) AS avg FROM duel_players WHERE user_id = ?',
      args: [userId],
    });
    const value = result.rows[0]?.avg;
    return value === null || value === undefined ? undefined : Number(value);
  }

  /**
   * Сводка дуэлей игрока: сыграно и выиграно. У матчей, сыгранных до
   * появления колонки outcome, исход восстанавливаем по счёту.
   */
  async duelRecord(userId: string): Promise<{ played: number; won: number }> {
    const result = await this.client.execute({
      sql: `SELECT
              COUNT(*) AS played,
              SUM(CASE
                    WHEN mine.outcome IS NOT NULL
                      THEN (CASE WHEN mine.outcome = 'win' THEN 1 ELSE 0 END)
                    WHEN mine.score > COALESCE(theirs.score, -1) THEN 1
                    ELSE 0
                  END) AS won
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

  /** Заводит игрока вместе с первым способом входа. */
  /** Сводка по вызову дня: сколько дней сыграно и лучший результат. */
  async dailyRecord(userId: string): Promise<{ played: number; best: number | null }> {
    const result = await this.client.execute({
      sql: 'SELECT COUNT(*) AS played, MAX(score) AS best FROM daily_runs WHERE user_id = ?',
      args: [userId],
    });
    const row = result.rows[0];
    return {
      played: Number(row?.played ?? 0),
      best: row?.best === null || row?.best === undefined ? null : Number(row.best),
    };
  }

  async createUser(id: string, name: string, identity: Identity): Promise<UserRow> {
    await this.client.batch(
      [
        { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', args: [id, name] },
        {
          sql: 'INSERT INTO identities (kind, external_id, user_id) VALUES (?, ?, ?)',
          args: [identity.kind, identity.externalId, id],
        },
      ],
      'write',
    );
    return { id, name };
  }

  /** Игрок по способу входа: с этого начинается любая авторизация. */
  async userByIdentity(kind: IdentityKind, externalId: string): Promise<UserRow | undefined> {
    const result = await this.client.execute({
      sql: `SELECT u.id, u.name FROM identities i
            JOIN users u ON u.id = i.user_id
            WHERE i.kind = ? AND i.external_id = ?`,
      args: [kind, externalId],
    });
    const row = result.rows[0];
    return row ? { id: String(row.id), name: String(row.name) } : undefined;
  }

  /**
   * Привязывает способ входа к существующему аккаунту.
   *
   * Занятую личность к другому игроку не переносим и аккаунты не сливаем:
   * слияние — это дыра, через которую можно вести две учётки и оставлять
   * ту, где рейтинг удачнее. Честнее отказать и объяснить.
   */
  async linkIdentity(
    userId: string,
    identity: Identity,
  ): Promise<'linked' | 'already-linked' | 'taken'> {
    const existing = await this.client.execute({
      sql: 'SELECT user_id FROM identities WHERE kind = ? AND external_id = ?',
      args: [identity.kind, identity.externalId],
    });
    const owner = existing.rows[0];
    if (owner) return String(owner.user_id) === userId ? 'already-linked' : 'taken';

    await this.client.execute({
      sql: 'INSERT INTO identities (kind, external_id, user_id) VALUES (?, ?, ?)',
      args: [identity.kind, identity.externalId, userId],
    });
    return 'linked';
  }

  /** Все способы входа игрока — для личного кабинета. */
  async identitiesOf(userId: string): Promise<{ kind: IdentityKind; linkedAt: string }[]> {
    const result = await this.client.execute({
      sql: 'SELECT kind, linked_at FROM identities WHERE user_id = ? ORDER BY linked_at ASC',
      args: [userId],
    });
    return result.rows.map((row) => ({
      kind: String(row.kind) as IdentityKind,
      linkedAt: String(row.linked_at),
    }));
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
