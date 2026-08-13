import { randomInt } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';
import { cleanMarks, newRating, PLACEMENT_GAMES, type Rating } from '@doton/core';
import type { BoardPeriod } from '@doton/protocol';
import { MIN_MOVE_GAP, MOVE_SLACK } from './limits.js';

export type { BoardPeriod };

/** Без похожих друг на друга символов: код диктуют вслух. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeFriendCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return code;
}

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

/** Какая из двух таблиц рекордов: спринт или челлендж комбо. */
type Board = 'sprint' | 'order';

export interface Identity {
  kind: IdentityKind;
  externalId: string;
}

export interface FriendRow {
  id: string;
  name: string;
  code: string | null;
  rating: number;
  ratedGames: number;
}

export interface RecentOpponentRow {
  name: string;
  code: string;
  playedAt: string;
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
        // Спринт: у игрока хранится только лучший заход — таблица про
        // рекорд, а не про число попыток. Ходы лежат рядом с числом, чтобы
        // рекорд оставался доказуемым и после того, как его засчитали.
        `CREATE TABLE IF NOT EXISTS sprint_runs (
           user_id TEXT PRIMARY KEY REFERENCES users(id),
           score INTEGER NOT NULL,
           seed INTEGER NOT NULL,
           moves TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (datetime('now'))
         )`,
        `CREATE INDEX IF NOT EXISTS idx_sprint_runs_score ON sprint_runs (score DESC)`,
        // Таблица дня — отдельная от вечной: у каждого игрока хранится его
        // лучший заход за конкретный день. Ходы тут не держим — заход уже
        // пересчитан ядром при отправке, а доказуемая копия лежит в вечной
        // строке. Иначе журнал рос бы на каждый день каждого игрока.
        `CREATE TABLE IF NOT EXISTS sprint_days (
           user_id TEXT NOT NULL REFERENCES users(id),
           day TEXT NOT NULL,
           score INTEGER NOT NULL,
           seed INTEGER NOT NULL,
           created_at TEXT NOT NULL DEFAULT (datetime('now')),
           PRIMARY KEY (user_id, day)
         )`,
        `CREATE INDEX IF NOT EXISTS idx_sprint_days ON sprint_days (day, score DESC)`,
        // Заказы: у игрока хранится только лучший заход. Ходы лежат рядом
        // с числом — рекорд должен оставаться доказуемым и после того, как
        // его засчитали.
        `CREATE TABLE IF NOT EXISTS order_runs (
           user_id TEXT PRIMARY KEY REFERENCES users(id),
           score INTEGER NOT NULL,
           orders INTEGER NOT NULL DEFAULT 0,
           seed INTEGER NOT NULL,
           moves TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (datetime('now'))
         )`,
        `CREATE INDEX IF NOT EXISTS idx_order_runs_score ON order_runs (score DESC)`,
        `CREATE TABLE IF NOT EXISTS order_days (
           user_id TEXT NOT NULL REFERENCES users(id),
           day TEXT NOT NULL,
           score INTEGER NOT NULL,
           orders INTEGER NOT NULL DEFAULT 0,
           seed INTEGER NOT NULL,
           created_at TEXT NOT NULL DEFAULT (datetime('now')),
           PRIMARY KEY (user_id, day)
         )`,
        `CREATE INDEX IF NOT EXISTS idx_order_days ON order_days (day, score DESC)`,
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
        // Дружба взаимная: обе строки пишутся разом. Заявок и подтверждений
        // нет — на нашем масштабе это лишний экран, а добавить можно только
        // того, чей код тебе дали, или того, с кем ты только что играл.
        // Одноразовый код привязки: игрок в браузере получает его, а
        // подтверждает уже в Telegram — на другом устройстве.
        `CREATE TABLE IF NOT EXISTS link_tokens (
           token TEXT PRIMARY KEY,
           user_id TEXT NOT NULL REFERENCES users(id),
           created_at TEXT NOT NULL DEFAULT (datetime('now'))
         )`,
        `CREATE TABLE IF NOT EXISTS friends (
           user_id TEXT NOT NULL REFERENCES users(id),
           friend_id TEXT NOT NULL REFERENCES users(id),
           created_at TEXT NOT NULL DEFAULT (datetime('now')),
           PRIMARY KEY (user_id, friend_id)
         )`,
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

    // Бот не может написать первым тому, кто его не запускал, — отмечаем,
    // кому писать можно, чтобы не считать отказ доставки поломкой.
    await this.addColumnIfMissing('identities', 'bot_started', 'INTEGER NOT NULL DEFAULT 0');
    // Наработка прибора: сумма потенциала за всё время. scored_at нужен, чтобы
    // проверять темп досылов из режимов, которые сервер не пересчитывает.
    await this.addColumnIfMissing('users', 'total_score', 'INTEGER NOT NULL DEFAULT 0');
    await this.addColumnIfMissing('users', 'scored_at', 'TEXT');
    // Смайлик на пропуске — единственное, что игрок рисует о себе сам.
    await this.addColumnIfMissing('users', 'avatar', 'TEXT');
    // Шильдики корпуса: три номера из каталога ядра, одной строкой. Своей
    // таблицы они не стоят — это три коротких значения, живущих с игроком.
    await this.addColumnIfMissing('users', 'marks', 'TEXT');
    // Код друга: короткий, его диктуют вслух и шлют ссылкой.
    await this.addColumnIfMissing('users', 'friend_code', 'TEXT');
    // Заявки на цвет резонанса: общие для матча, поэтому лежат на дуэли,
    // а не на игроке. Без них реплей взял бы цвет фазы из сида и разошёлся
    // бы со счётом. У матчей, сыгранных до заявок, колонка пуста.
    await this.addColumnIfMissing('duels', 'claims', 'TEXT');
    await this.client.execute(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_friend_code ON users (friend_code)',
    );
    await this.backfillFriendCodes();

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

  /** Выдаёт код тем, кто завёлся до появления кодов. */
  private async backfillFriendCodes(): Promise<void> {
    const rows = await this.client.execute('SELECT id FROM users WHERE friend_code IS NULL');
    for (const row of rows.rows) {
      await this.assignFriendCode(String(row.id));
    }
  }

  /**
   * Ставит игроку свободный код. Коллизия маловероятна, но в уникальный
   * индекс она бы упёрлась молча — поэтому пробуем несколько раз.
   */
  private async assignFriendCode(userId: string): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = makeFriendCode();
      try {
        await this.client.execute({
          sql: 'UPDATE users SET friend_code = ? WHERE id = ?',
          args: [code, userId],
        });
        return code;
      } catch {
        // Код занят — берём следующий.
      }
    }
    throw new Error('cannot assign friend code');
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
    claims: unknown = [],
  ): Promise<void> {
    await this.client.batch(
      [
        {
          sql: 'INSERT INTO duels (id, seed, claims) VALUES (?, ?, ?)',
          args: [id, seed, JSON.stringify(claims)],
        },
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
  ): Promise<
    | {
        seed: number;
        moves: string;
        score: number;
        opponentName: string | null;
        claims: string | null;
      }
    | undefined
  > {
    const result = await this.client.execute({
      sql: `SELECT d.seed, d.claims, mine.moves, mine.score,
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
      claims: row.claims === null || row.claims === undefined ? null : String(row.claims),
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
  async ratingLeaderboard(
    limit: number,
  ): Promise<{ name: string; rating: number; mark: string | null }[]> {
    const result = await this.client.execute({
      sql: `SELECT name, rating, marks FROM users
            WHERE rated_games >= ?
            ORDER BY rating DESC, name ASC
            LIMIT ?`,
      args: [PLACEMENT_GAMES, limit],
    });
    return result.rows.map((row) => ({
      name: String(row.name),
      rating: Number(row.rating),
      mark: this.firstMark(row.marks),
    }));
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
  /** Код друга: выдаётся при создании аккаунта, дальше не меняется. */
  async friendCodeOf(userId: string): Promise<string | null> {
    const result = await this.client.execute({
      sql: 'SELECT friend_code FROM users WHERE id = ?',
      args: [userId],
    });
    const code = result.rows[0]?.friend_code;
    return code === null || code === undefined ? null : String(code);
  }

  async userByFriendCode(code: string): Promise<UserRow | undefined> {
    const result = await this.client.execute({
      sql: 'SELECT id, name FROM users WHERE friend_code = ?',
      args: [code],
    });
    const row = result.rows[0];
    return row ? { id: String(row.id), name: String(row.name) } : undefined;
  }

  /** Дружба взаимная: одна кнопка добавляет обе стороны. */
  async addFriend(userId: string, friendId: string): Promise<void> {
    await this.client.batch(
      [
        {
          sql: 'INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)',
          args: [userId, friendId],
        },
        {
          sql: 'INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)',
          args: [friendId, userId],
        },
      ],
      'write',
    );
  }

  async removeFriend(userId: string, friendId: string): Promise<void> {
    await this.client.batch(
      [
        {
          sql: 'DELETE FROM friends WHERE user_id = ? AND friend_id = ?',
          args: [userId, friendId],
        },
        {
          sql: 'DELETE FROM friends WHERE user_id = ? AND friend_id = ?',
          args: [friendId, userId],
        },
      ],
      'write',
    );
  }

  async areFriends(userId: string, friendId: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: 'SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?',
      args: [userId, friendId],
    });
    return result.rows.length > 0;
  }

  /** Друзья по убыванию рейтинга — это и есть таблица среди своих. */
  async friendsOf(userId: string): Promise<FriendRow[]> {
    const result = await this.client.execute({
      sql: `SELECT u.id, u.name, u.friend_code, u.rating, u.rated_games
            FROM friends f JOIN users u ON u.id = f.friend_id
            WHERE f.user_id = ?
            ORDER BY u.rating DESC, u.name ASC`,
      args: [userId],
    });
    return result.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      code: row.friend_code === null ? null : String(row.friend_code),
      rating: Number(row.rating),
      ratedGames: Number(row.rated_games),
    }));
  }

  /**
   * Личный счёт со всеми, с кем игрок встречался. Одним запросом: иначе на
   * каждого друга уходил бы отдельный поход в базу.
   */
  async headToHead(userId: string): Promise<Map<string, { played: number; won: number }>> {
    const result = await this.client.execute({
      sql: `SELECT theirs.user_id AS opponent_id,
                   COUNT(*) AS played,
                   SUM(CASE
                         WHEN mine.outcome IS NOT NULL
                           THEN (CASE WHEN mine.outcome = 'win' THEN 1 ELSE 0 END)
                         WHEN mine.score > theirs.score THEN 1
                         ELSE 0
                       END) AS won
            FROM duel_players mine
            JOIN duel_players theirs
              ON theirs.duel_id = mine.duel_id AND theirs.user_id <> mine.user_id
            WHERE mine.user_id = ?
            GROUP BY theirs.user_id`,
      args: [userId],
    });
    return new Map(
      result.rows.map((row) => [
        String(row.opponent_id),
        { played: Number(row.played), won: Number(row.won ?? 0) },
      ]),
    );
  }

  /**
   * С кем игрок недавно играл, но ещё не дружит. Призраков не предлагаем:
   * за записью нет живого человека.
   */
  async recentOpponents(userId: string, limit: number): Promise<RecentOpponentRow[]> {
    const result = await this.client.execute({
      sql: `SELECT u.id, u.name, u.friend_code, MAX(d.created_at) AS last_at
            FROM duel_players mine
            JOIN duels d ON d.id = mine.duel_id
            JOIN duel_players theirs
              ON theirs.duel_id = mine.duel_id AND theirs.user_id <> mine.user_id
            JOIN users u ON u.id = theirs.user_id
            WHERE mine.user_id = ?
              AND theirs.ghost = 0
              AND u.friend_code IS NOT NULL
              AND theirs.user_id NOT IN (SELECT friend_id FROM friends WHERE user_id = ?)
            GROUP BY u.id
            ORDER BY last_at DESC
            LIMIT ?`,
      args: [userId, userId, limit],
    });
    return result.rows.map((row) => ({
      name: String(row.name),
      code: String(row.friend_code),
      playedAt: String(row.last_at),
    }));
  }

  /** Наработка прибора — сумма потенциала игрока за всё время. */
  async totalScore(userId: string): Promise<number> {
    const result = await this.client.execute({
      sql: 'SELECT total_score FROM users WHERE id = ?',
      args: [userId],
    });
    return Number(result.rows[0]?.total_score ?? 0);
  }

  /**
   * Засчитывает потенциал, который сервер посчитал сам: результат дуэли.
   * Проверять тут нечего — эти очки уже прошли через ядро.
   */
  async addTotal(userId: string, points: number): Promise<void> {
    if (points <= 0) return;
    await this.client.execute({
      sql: 'UPDATE users SET total_score = total_score + ? WHERE id = ?',
      args: [points, userId],
    });
  }

  /**
   * Засчитывает досыл из режима без конца партии. Такую партию сервер не
   * видел и пересчитать не может, поэтому проверяем правдоподобие темпа:
   * ходов не может быть больше, чем физически успел сделать человек с
   * прошлого досыла. Это не защита от упорного мошенника, но она рушит
   * простейшее «отправить миллион одним запросом».
   */
  async addScore(
    userId: string,
    points: number,
    moves: number,
  ): Promise<{ total: number } | 'too-fast'> {
    const result = await this.client.execute({
      sql: `SELECT total_score, scored_at,
                   (julianday('now') - julianday(COALESCE(scored_at, created_at))) * 86400
                     AS elapsed
            FROM users WHERE id = ?`,
      args: [userId],
    });
    const row = result.rows[0];
    if (!row) return 'too-fast';

    // Небольшой запас поверх окна: первый досыл приходит с накопленным
    // за сессию, а часы клиента и сервера могут разойтись.
    const elapsed = Math.max(0, Number(row.elapsed ?? 0));
    if (moves > elapsed / MIN_MOVE_GAP + MOVE_SLACK) return 'too-fast';

    await this.client.execute({
      sql: `UPDATE users
            SET total_score = total_score + ?, scored_at = datetime('now')
            WHERE id = ?`,
      args: [points, userId],
    });
    return { total: Number(row.total_score) + points };
  }

  /**
   * Таблицы рекордов живут в двух видах: вечная и сегодняшняя. Различаются
   * они только тем, откуда читать и чем ограничивать выборку, поэтому
   * запросы собираются в одном месте.
   *
   * Имена таблиц и колонок здесь — из замкнутого набора, а не из запроса
   * игрока: подставлять их в SQL строкой безопасно.
   */
  private source(board: Board, period: BoardPeriod): { table: string; where: string } {
    return period === 'day'
      ? { table: `${board}_days`, where: `day = date('now')` }
      : { table: `${board}_runs`, where: '1 = 1' };
  }

  /** Личный рекорд: 0 — заходов ещё не было. */
  private async best(board: Board, userId: string, period: BoardPeriod): Promise<number> {
    const { table, where } = this.source(board, period);
    const result = await this.client.execute({
      sql: `SELECT score AS value FROM ${table} WHERE user_id = ? AND ${where}`,
      args: [userId],
    });
    return Number(result.rows[0]?.value ?? 0);
  }

  /** Место в таблице: 1 + число рекордов строго выше. */
  private async rank(board: Board, userId: string, period: BoardPeriod): Promise<number | null> {
    const mine = await this.best(board, userId, period);
    if (mine === 0) return null;
    const { table, where } = this.source(board, period);
    const above = await this.client.execute({
      sql: `SELECT COUNT(*) AS above FROM ${table} WHERE score > ? AND ${where}`,
      args: [mine],
    });
    return Number(above.rows[0]!.above) + 1;
  }

  /** Верхушка таблицы. При равных рекордах выше тот, кто поставил раньше. */
  private async top(
    board: Board,
    limit: number,
    period: BoardPeriod,
  ): Promise<{ name: string; value: number; orders: number; mark: string | null }[]> {
    const { table, where } = this.source(board, period);
    // Заказы в спринтовых таблицах не хранятся — там их и не спрашивают.
    const extra = board === 'order' ? 'r.orders' : '0 AS orders';
    const result = await this.client.execute({
      sql: `SELECT u.name, u.marks, r.score AS value, ${extra}
            FROM ${table} r JOIN users u ON u.id = r.user_id
            WHERE ${where}
            ORDER BY r.score DESC, r.created_at ASC
            LIMIT ?`,
      args: [limit],
    });
    return result.rows.map((row) => ({
      name: String(row.name),
      value: Number(row.value),
      orders: Number(row.orders),
      mark: this.firstMark(row.marks),
    }));
  }

  /**
   * Рекорд дня: у игрока хранится лучший заход за сегодня. Заход слабее
   * сегодняшнего не сохраняем — таблица про рекорд, а не про попытки.
   */
  private async saveDay(
    board: Board,
    userId: string,
    value: number,
    seed: number,
    orders = 0,
  ): Promise<void> {
    const columns = board === 'order' ? ', orders' : '';
    const set = board === 'order' ? 'orders = excluded.orders,' : '';
    await this.client.execute({
      sql: `INSERT INTO ${board}_days (user_id, day, score, seed${columns})
            VALUES (?, date('now'), ?, ?${board === 'order' ? ', ?' : ''})
            ON CONFLICT (user_id, day) DO UPDATE
              SET score = excluded.score,
                  ${set}
                  seed = excluded.seed,
                  created_at = datetime('now')
              WHERE excluded.score > ${board}_days.score`,
      args: board === 'order' ? [userId, value, seed, orders] : [userId, value, seed],
    });
  }

  /** Личный рекорд заказов; 0 — заходов ещё не было. */
  async bestOrder(userId: string, period: BoardPeriod = 'all'): Promise<number> {
    return this.best('order', userId, period);
  }

  /** Сколько заказов было в рекордном заходе. */
  async ordersOf(userId: string, period: BoardPeriod = 'all'): Promise<number> {
    const { table, where } = this.source('order', period);
    const result = await this.client.execute({
      sql: `SELECT orders FROM ${table} WHERE user_id = ? AND ${where}`,
      args: [userId],
    });
    return Number(result.rows[0]?.orders ?? 0);
  }

  /**
   * Оставляет у игрока только лучший заход: таблица про рекорд, а не про
   * количество попыток. Заход слабее прежнего в вечную таблицу не идёт —
   * но в сегодняшнюю может: день считается отдельно.
   */
  async saveOrder(
    userId: string,
    score: number,
    orders: number,
    seed: number,
    movesJson: string,
  ): Promise<{ best: number; improved: boolean }> {
    await this.saveDay('order', userId, score, seed, orders);
    const previous = await this.bestOrder(userId);
    if (score <= previous) return { best: previous, improved: false };

    await this.client.execute({
      sql: `INSERT INTO order_runs (user_id, score, orders, seed, moves)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE
              SET score = excluded.score,
                  orders = excluded.orders,
                  seed = excluded.seed,
                  moves = excluded.moves,
                  created_at = datetime('now')`,
      args: [userId, score, orders, seed, movesJson],
    });
    return { best: score, improved: true };
  }

  async orderRank(userId: string, period: BoardPeriod = 'all'): Promise<number | null> {
    return this.rank('order', userId, period);
  }

  async orderTop(
    limit: number,
    period: BoardPeriod = 'all',
  ): Promise<{ name: string; score: number; orders: number; mark: string | null }[]> {
    const rows = await this.top('order', limit, period);
    return rows.map((row) => ({
      name: row.name,
      score: row.value,
      orders: row.orders,
      mark: row.mark,
    }));
  }

  /** Личный рекорд спринта; 0 — заходов ещё не было. */
  async bestSprint(userId: string, period: BoardPeriod = 'all'): Promise<number> {
    return this.best('sprint', userId, period);
  }

  /** Оставляет у игрока только лучший спринт: заход слабее не сохраняем. */
  async saveSprint(
    userId: string,
    score: number,
    seed: number,
    movesJson: string,
  ): Promise<{ best: number; improved: boolean }> {
    await this.saveDay('sprint', userId, score, seed);
    const previous = await this.bestSprint(userId);
    if (score <= previous) return { best: previous, improved: false };

    await this.client.execute({
      sql: `INSERT INTO sprint_runs (user_id, score, seed, moves)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE
              SET score = excluded.score,
                  seed = excluded.seed,
                  moves = excluded.moves,
                  created_at = datetime('now')`,
      args: [userId, score, seed, movesJson],
    });
    return { best: score, improved: true };
  }

  async sprintRank(userId: string, period: BoardPeriod = 'all'): Promise<number | null> {
    return this.rank('sprint', userId, period);
  }

  async sprintTop(
    limit: number,
    period: BoardPeriod = 'all',
  ): Promise<{ name: string; score: number; mark: string | null }[]> {
    const rows = await this.top('sprint', limit, period);
    return rows.map((row) => ({ name: row.name, score: row.value, mark: row.mark }));
  }

  async createUser(id: string, name: string, identity: Identity): Promise<UserRow> {
    await this.client.batch(
      [
        {
          sql: 'INSERT INTO users (id, name, friend_code) VALUES (?, ?, ?)',
          args: [id, name, makeFriendCode()],
        },
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

  /** Отмечает, что игрок нажал Start: теперь бот может ему писать. */
  async markBotStarted(telegramId: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE identities SET bot_started = 1 WHERE kind = 'telegram' AND external_id = ?",
      args: [telegramId],
    });
  }

  /**
   * Куда писать игроку в Telegram. null — либо Telegram не привязан, либо
   * бот не запущен: во втором случае API всё равно откажет.
   */
  async botChatOf(userId: string): Promise<string | null> {
    const result = await this.client.execute({
      sql: `SELECT external_id FROM identities
            WHERE user_id = ? AND kind = 'telegram' AND bot_started = 1`,
      args: [userId],
    });
    const row = result.rows[0];
    return row ? String(row.external_id) : null;
  }

  /** Выдаёт одноразовый код привязки. Старые коды того же игрока гасим. */
  async createLinkToken(userId: string, token: string): Promise<void> {
    await this.client.batch(
      [
        { sql: 'DELETE FROM link_tokens WHERE user_id = ?', args: [userId] },
        {
          sql: 'INSERT INTO link_tokens (token, user_id) VALUES (?, ?)',
          args: [token, userId],
        },
      ],
      'write',
    );
  }

  /**
   * Обменивает код на игрока и сразу его гасит: код одноразовый, а через
   * десять минут перестаёт действовать сам.
   */
  async consumeLinkToken(token: string): Promise<string | null> {
    const result = await this.client.execute({
      sql: `SELECT user_id FROM link_tokens
            WHERE token = ? AND created_at > datetime('now', '-10 minutes')`,
      args: [token],
    });
    const row = result.rows[0];
    await this.client.execute({ sql: 'DELETE FROM link_tokens WHERE token = ?', args: [token] });
    return row ? String(row.user_id) : null;
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

  /** Смайлик игрока; null — не ставил. */
  async avatarOf(userId: string): Promise<string | null> {
    const result = await this.client.execute({
      sql: 'SELECT avatar FROM users WHERE id = ?',
      args: [userId],
    });
    const value = result.rows[0]?.avatar;
    return value === null || value === undefined ? null : String(value);
  }

  /**
   * Первый занятый шильдик игрока — тот, что едет рядом с именем в чужие
   * таблицы. Хранится строкой, поэтому разбор в одном месте.
   */
  private firstMark(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return cleanMarks(parsed as (string | null)[]).find((id) => id !== null) ?? null;
    } catch {
      return null;
    }
  }

  /** Шильдики игрока: три ячейки, пустая — null. */
  async marksOf(userId: string): Promise<(string | null)[]> {
    const result = await this.client.execute({
      sql: 'SELECT marks FROM users WHERE id = ?',
      args: [userId],
    });
    const raw = result.rows[0]?.marks;
    if (typeof raw !== 'string') return cleanMarks([]);
    try {
      const parsed: unknown = JSON.parse(raw);
      // Каталог мог с тех пор смениться — приводим к нему на чтении.
      return cleanMarks(Array.isArray(parsed) ? (parsed as (string | null)[]) : []);
    } catch {
      return cleanMarks([]);
    }
  }

  async setMarks(userId: string, marks: (string | null)[]): Promise<void> {
    await this.client.execute({
      sql: 'UPDATE users SET marks = ? WHERE id = ?',
      args: [JSON.stringify(cleanMarks(marks)), userId],
    });
  }

  async setAvatar(userId: string, avatar: string): Promise<void> {
    await this.client.execute({
      sql: 'UPDATE users SET avatar = ? WHERE id = ?',
      args: [avatar, userId],
    });
  }

  async renameUser(id: string, name: string): Promise<void> {
    await this.client.execute({
      sql: 'UPDATE users SET name = ? WHERE id = ?',
      args: [name, id],
    });
  }

  close(): void {
    this.client.close();
  }
}
