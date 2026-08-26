import { randomInt } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';
import {
  cleanMarks,
  goldMark,
  isArt,
  isGoldMark,
  isOwnMark,
  newRating,
  PLACEMENT_GAMES,
  type Rating,
} from '@doton/core';
import type { BoardPeriod, DuelKind } from '@doton/protocol';
import { MIN_MOVE_GAP } from './limits.js';

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
  /** На чём играли: у заказов своя механика и свой рейтинг. */
  kind: DuelKind;
  ratingBefore: number | null;
  ratingAfter: number | null;
  hasReplay: boolean;
}

/** Строка поиска службы: то, чем игрока можно узнать в списке. */
export interface AdminFoundRow {
  id: string;
  name: string;
  code: string | null;
  rating: number;
  tokens: number;
  seenAt: string | null;
  identities: string[];
  ban?: { until: string | null; reason: string };
}

/** Участие игрока в турнире дня. */
export interface TourneyEntryRow {
  rounds: number;
  score: number;
  place: number | null;
  prize: number | null;
}

/** Строка таблицы турнира. */
export interface TourneyRow {
  id: string;
  name: string;
  score: number;
  rounds: number;
  place: number | null;
  prize: number | null;
  mark: string | null;
  art?: string;
}

/** Строка личной истории турниров: свой день целиком. */
export interface TourneyHistoryRow {
  day: string;
  rounds: number;
  score: number;
  place: number | null;
  prize: number | null;
  paid: number;
  entered: number;
  pool: number;
  settled: boolean;
}

/** Строка очереди жалоб. */
export interface AdminReportRow {
  targetId: string;
  targetName: string;
  count: number;
  lastAt: string;
  art: string | null;
  ban?: { until: string | null; reason: string };
}

/** Запись журнала службы. */
export interface AdminLogRow {
  at: string;
  admin: string;
  target: string;
  targetName: string;
  action: string;
  detail: string;
  reason: string;
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
        // Журнал службы: кто из служащих, что, с кем и почему сделал.
        // Пишется на каждое действие над чужим аккаунтом и не стирается:
        // без него отменить чужое решение нечем, а спорить не с чем.
        `CREATE TABLE IF NOT EXISTS admin_log (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           at TEXT NOT NULL DEFAULT (datetime('now')),
           admin_id TEXT NOT NULL,
           admin_name TEXT NOT NULL,
           target_id TEXT NOT NULL,
           target_name TEXT NOT NULL,
           action TEXT NOT NULL,
           detail TEXT NOT NULL DEFAULT '',
           reason TEXT NOT NULL
         )`,
        `CREATE INDEX IF NOT EXISTS idx_admin_log_at ON admin_log (at DESC)`,
        // Жалобы игроков. Разобранные не стираются: по ним видно, что на
        // человека уже жаловались и чем это кончилось.
        `CREATE TABLE IF NOT EXISTS reports (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           at TEXT NOT NULL DEFAULT (datetime('now')),
           from_user TEXT NOT NULL REFERENCES users(id),
           target_user TEXT NOT NULL REFERENCES users(id),
           handled_at TEXT,
           handled_by TEXT
         )`,
        // Один игрок — одна неразобранная жалоба на одного и того же: иначе
        // очередь набивается одним обиженным, а «сколько человек пожаловалось»
        // перестаёт что-либо значить.
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_open
           ON reports (from_user, target_user) WHERE handled_at IS NULL`,
        `CREATE INDEX IF NOT EXISTS idx_reports_target ON reports (target_user)`,
        // Турнир дня. Ключ — сам день в поясе турнира: другого у него нет,
        // и двух турниров в один день не бывает. Сид выдаётся при первом
        // обращении и дальше не меняется — он общий для всех участников.
        `CREATE TABLE IF NOT EXISTS tourneys (
           day TEXT PRIMARY KEY,
           seed INTEGER NOT NULL,
           created_at TEXT NOT NULL DEFAULT (datetime('now')),
           settled_at TEXT
         )`,
        // Участие: взнос уплачен, заходы сыграны, сумма очков и приз.
        `CREATE TABLE IF NOT EXISTS tourney_entries (
           day TEXT NOT NULL REFERENCES tourneys(day),
           user_id TEXT NOT NULL REFERENCES users(id),
           paid INTEGER NOT NULL,
           rounds INTEGER NOT NULL DEFAULT 0,
           score INTEGER NOT NULL DEFAULT 0,
           /* Когда сыгран последний заход: им и разрешается равенство очков. */
           last_at TEXT,
           place INTEGER,
           prize INTEGER,
           PRIMARY KEY (day, user_id)
         )`,
        `CREATE INDEX IF NOT EXISTS idx_tourney_entries_day
           ON tourney_entries (day, score DESC)`,
        // Заходы турнира хранятся с журналом ходов: рекорд должен оставаться
        // доказуемым и после того, как его засчитали, — как в таблицах.
        `CREATE TABLE IF NOT EXISTS tourney_rounds (
           day TEXT NOT NULL,
           user_id TEXT NOT NULL,
           round INTEGER NOT NULL,
           score INTEGER NOT NULL,
           moves TEXT NOT NULL,
           played_at TEXT NOT NULL DEFAULT (datetime('now')),
           PRIMARY KEY (day, user_id, round)
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
    // Второй рейтинг — для дуэлей на заказах. Отдельные колонки, а не общая
    // строка с признаком: навык в двух механиках разный, и смешать их в одно
    // число значило бы соврать обоим.
    await this.addColumnIfMissing('users', 'order_rating', 'INTEGER NOT NULL DEFAULT 1500');
    await this.addColumnIfMissing('users', 'order_deviation', 'INTEGER NOT NULL DEFAULT 350');
    await this.addColumnIfMissing('users', 'order_volatility', 'REAL NOT NULL DEFAULT 0.06');
    await this.addColumnIfMissing('users', 'order_rated_at', 'TEXT');
    await this.addColumnIfMissing('users', 'order_rated_games', 'INTEGER NOT NULL DEFAULT 0');
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
    // Смайлик на пропуске — единственное, что игрок рисует о себе сам.
    await this.addColumnIfMissing('users', 'avatar', 'TEXT');
    // Шильдики корпуса: три номера из каталога ядра, одной строкой. Своей
    // таблицы они не стоят — это три коротких значения, живущих с игроком.
    await this.addColumnIfMissing('users', 'marks', 'TEXT');
    // Свой шильдик: сто знаков листа. Лежит у игрока, а не в отдельной
    // таблице, — рисунок у него один, и живёт он ровно столько же.
    await this.addColumnIfMissing('users', 'art', 'TEXT');
    // Бан: до какого времени и за что. Пустой срок при непустой причине —
    // это «навсегда»; обе колонки пусты — прибор при игроке.
    await this.addColumnIfMissing('users', 'banned_until', 'TEXT');
    await this.addColumnIfMissing('users', 'banned_forever', 'INTEGER NOT NULL DEFAULT 0');
    await this.addColumnIfMissing('users', 'ban_reason', 'TEXT');
    // Когда игрока последний раз видели в приборе. По этому и решаем, куда
    // слать приглашение: в игру или, если его там нет, в Telegram.
    await this.addColumnIfMissing('users', 'seen_at', 'TEXT');
    // Приглашения на дуэль: живут минуту-другую и стираются. Хранить их
    // дольше незачем — комната столько не ждёт.
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS invites (
         to_user TEXT NOT NULL REFERENCES users(id),
         from_user TEXT NOT NULL REFERENCES users(id),
         room TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         PRIMARY KEY (to_user, from_user)
       )`,
    );
    // А вот выданные отметки — стоят: их список растёт, и каждая помнит,
    // когда её выдали. Выданное не отбирается, даже если рейтинг просел.
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS user_marks (
         user_id TEXT NOT NULL REFERENCES users(id),
         mark_id TEXT NOT NULL,
         earned_at TEXT NOT NULL DEFAULT (datetime('now')),
         PRIMARY KEY (user_id, mark_id)
       )`,
    );
    // Код друга: короткий, его диктуют вслух и шлют ссылкой.
    await this.addColumnIfMissing('users', 'friend_code', 'TEXT');
    // Смену имени игрок тратит один раз: имя приходит из Telegram, и одна
    // осознанная замена ему положена, а дальше по нему его знают соперники,
    // друзья и таблицы. Тем, кто завёлся раньше правила, замена не сгорает:
    // колонка по умолчанию нулевая, и их первая смена ещё впереди.
    await this.addColumnIfMissing('users', 'renamed', 'INTEGER NOT NULL DEFAULT 0');
    // Жетоны: валюта прибора. Копятся за доведённые до конца заходы и матчи,
    // тратятся на шильдики и замену имени. Рядом лежит время последней
    // выдачи — по нему держится темп начисления.
    await this.addColumnIfMissing('users', 'tokens', 'INTEGER NOT NULL DEFAULT 0');
    await this.addColumnIfMissing('users', 'tokens_at', 'TEXT');
    // Оправа полосы шильдиков — купленная, надетая. Пусто у всех, кто её не
    // покупал или снял: полоса без оправы — это обычная полоса.
    await this.addColumnIfMissing('users', 'frame', 'TEXT');
    // Заявки на цвет резонанса: общие для матча, поэтому лежат на дуэли,
    // а не на игроке. Без них реплей взял бы цвет фазы из сида и разошёлся
    // бы со счётом. У матчей, сыгранных до заявок, колонка пуста.
    await this.addColumnIfMissing('duels', 'kind', "TEXT NOT NULL DEFAULT 'chain'");
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
    kind: DuelKind,
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
          sql: 'INSERT INTO duels (id, seed, kind, claims) VALUES (?, ?, ?, ?)',
          args: [id, seed, kind, JSON.stringify(claims)],
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
      sql: `SELECT d.id, d.created_at, d.kind, mine.score, mine.outcome,
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
      // Реплей пока умеет только цепочки: в заказах ход — касание, и
      // прокрутка по нему собрала бы пустое поле. Лучше не предлагать.
      hasReplay: Number(row.has_replay ?? 0) === 1 && String(row.kind ?? 'chain') === 'chain',
      kind: (String(row.kind ?? 'chain') === 'order' ? 'order' : 'chain') as DuelKind,
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
  ): Promise<
    | { name: string; seed: number; score: number; log: string; marks: (string | null)[]; art: string | null }
    | undefined
  > {
    const result = await this.client.execute({
      sql: `SELECT u.name, u.marks, u.art, d.seed, p.score, p.log
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
      // Запись живого игрока носит его же корпус: она и есть он.
      marks: this.parseMarks(row.marks),
      art: isArt(row.art) ? row.art : null,
    };
  }

  /**
   * Имена колонок рейтинга для механики. Дуэли две, и рейтинга тоже два:
   * цепочки живут в исходных колонках, заказы — в своих.
   */
  private ratingColumns(kind: DuelKind): {
    rating: string;
    deviation: string;
    volatility: string;
    ratedAt: string;
    games: string;
  } {
    const prefix = kind === 'order' ? 'order_' : '';
    return {
      rating: `${prefix}rating`,
      deviation: `${prefix}deviation`,
      volatility: `${prefix}volatility`,
      ratedAt: `${prefix}rated_at`,
      games: `${prefix}rated_games`,
    };
  }

  /**
   * Случайный чужой заход заказов — материал для призрака в дуэли на
   * заказах. Свои же заходы исключаем: играть против себя странно.
   */
  async pickOrderRun(
    excludeUserId: string,
  ): Promise<
    | { name: string; seed: number; score: number; moves: string; marks: (string | null)[]; art: string | null }
    | undefined
  > {
    const result = await this.client.execute({
      sql: `SELECT u.name, u.marks, u.art, r.seed, r.score, r.moves
            FROM order_runs r JOIN users u ON u.id = r.user_id
            WHERE r.user_id <> ? AND r.score > 0
            ORDER BY RANDOM()
            LIMIT 1`,
      args: [excludeUserId],
    });
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      name: String(row.name),
      seed: Number(row.seed),
      score: Number(row.score),
      moves: String(row.moves),
      marks: this.parseMarks(row.marks),
      art: isArt(row.art) ? row.art : null,
    };
  }

  /** Рейтинг игрока в этой механике; для новичка — стартовые значения. */
  async ratingOf(userId: string, kind: DuelKind = 'chain'): Promise<PlayerRating> {
    const col = this.ratingColumns(kind);
    const result = await this.client.execute({
      sql: `SELECT ${col.rating} AS rating, ${col.deviation} AS deviation,
                   ${col.volatility} AS volatility, ${col.ratedAt} AS rated_at,
                   ${col.games} AS rated_games
            FROM users WHERE id = ?`,
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
  async saveRating(userId: string, rating: Rating, kind: DuelKind = 'chain'): Promise<void> {
    const col = this.ratingColumns(kind);
    await this.client.execute({
      sql: `UPDATE users
            SET ${col.rating} = ?, ${col.deviation} = ?, ${col.volatility} = ?,
                ${col.ratedAt} = datetime('now'), ${col.games} = ${col.games} + 1
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
    kind: DuelKind = 'chain',
  ): Promise<{ name: string; rating: number; mark: string | null; art?: string }[]> {
    const col = this.ratingColumns(kind);
    const [result, holders] = await Promise.all([
      this.client.execute({
        sql: `SELECT id, name, ${col.rating} AS rating, marks, art FROM users
            WHERE ${col.games} >= ?
            ORDER BY ${col.rating} DESC, name ASC
            LIMIT ?`,
        args: [PLACEMENT_GAMES, limit],
      }),
      this.champions(),
    ]);
    return result.rows.map((row) => {
      const mark = this.firstMark(row.marks, holders.get(String(row.id)) ?? []);
      return { name: String(row.name), rating: Number(row.rating), mark, ...this.ownArt(mark, row.art) };
    });
  }

  /** Место игрока в рейтинге: 1 + число тех, кто выше. До калибровки — null. */
  async ratingRank(userId: string, kind: DuelKind = 'chain'): Promise<number | null> {
    const col = this.ratingColumns(kind);
    const me = await this.client.execute({
      sql: `SELECT ${col.rating} AS rating, ${col.games} AS rated_games FROM users WHERE id = ?`,
      args: [userId],
    });
    const row = me.rows[0];
    if (!row || Number(row.rated_games) < PLACEMENT_GAMES) return null;
    const above = await this.client.execute({
      sql: `SELECT COUNT(*) AS above FROM users WHERE ${col.games} >= ? AND ${col.rating} > ?`,
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
  ): Promise<{ name: string; value: number; orders: number; mark: string | null; art?: string }[]> {
    const { table, where } = this.source(board, period);
    // Заказы в спринтовых таблицах не хранятся — там их и не спрашивают.
    const extra = board === 'order' ? 'r.orders' : '0 AS orders';
    const [result, holders] = await Promise.all([
      this.client.execute({
        sql: `SELECT u.id, u.name, u.marks, u.art, r.score AS value, ${extra}
            FROM ${table} r JOIN users u ON u.id = r.user_id
            WHERE ${where}
            ORDER BY r.score DESC, r.created_at ASC, r.rowid ASC
            LIMIT ?`,
        args: [limit],
      }),
      this.champions(),
    ]);
    return result.rows.map((row) => {
      const mark = this.firstMark(row.marks, holders.get(String(row.id)) ?? []);
      return {
        name: String(row.name),
        value: Number(row.value),
        orders: Number(row.orders),
        mark,
        ...this.ownArt(mark, row.art),
      };
    });
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
  ): Promise<{ name: string; score: number; orders: number; mark: string | null; art?: string }[]> {
    const rows = await this.top('order', limit, period);
    return rows.map((row) => ({
      name: row.name,
      score: row.value,
      orders: row.orders,
      mark: row.mark,
      ...this.ownArt(row.mark, row.art),
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
  ): Promise<{ name: string; score: number; mark: string | null; art?: string }[]> {
    const rows = await this.top('sprint', limit, period);
    return rows.map((row) => ({
      name: row.name,
      score: row.value,
      mark: row.mark,
      ...this.ownArt(row.mark, row.art),
    }));
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
  /**
   * Картинка к шильдику в строке списка. Едет только со своим рисунком и
   * только у того, кто его и правда носит: у остальных её нет вовсе — не
   * пустая строка, а нет. Таблица на полсотни строк не должна возить сотню
   * лишних знаков ни за кого.
   */
  private ownArt(mark: string | null, raw: unknown): { art?: string } {
    if (!isOwnMark(mark)) return {};
    const art = raw === null || raw === undefined ? '' : String(raw);
    return isArt(art) ? { art } : {};
  }

  private firstMark(raw: unknown, gold: readonly string[] = []): string | null {
    return this.keepGold(this.parseMarks(raw), gold).find((id) => id !== null) ?? null;
  }

  /**
   * Гасит золото, которого у игрока уже нет. Выбор в базе не трогаем: место
   * можно и вернуть, и тогда шильдик встанет обратно в ту же ячейку.
   */
  private keepGold(marks: (string | null)[], gold: readonly string[]): (string | null)[] {
    return marks.map((id) => (id !== null && isGoldMark(id) && !gold.includes(id) ? null : id));
  }

  /**
   * Кто сейчас возглавляет вечные таблицы. Отсюда и берётся золото: держать
   * его в базе нельзя — оно меняет хозяина в тот же миг, когда меняется
   * первая строка таблицы.
   */
  private async champions(): Promise<Map<string, string[]>> {
    const boards: Board[] = ['order', 'sprint'];
    const holders = new Map<string, string[]>();
    for (const board of boards) {
      const { table, where } = this.source(board, 'all');
      const result = await this.client.execute({
        // Время записи хранится с точностью до секунды, и два одинаковых
        // рекорда в одну секунду встают в произвольном порядке — а золото
        // при этом перескакивает с одного на другого без всякой причины.
        // Номер строки разрешает ничью навсегда: кто записался первым, тот и
        // держит таблицу.
        sql: `SELECT user_id FROM ${table}
              WHERE score > 0 AND ${where}
              ORDER BY score DESC, created_at ASC, rowid ASC
              LIMIT 1`,
        args: [],
      });
      const row = result.rows[0];
      if (!row) continue;
      const id = String(row.user_id);
      holders.set(id, [...(holders.get(id) ?? []), goldMark(board)]);
    }
    return holders;
  }

  /** Золотые шильдики игрока прямо сейчас. */
  async goldMarks(userId: string): Promise<string[]> {
    return (await this.champions()).get(userId) ?? [];
  }

  /**
   * Весь корпус игрока из хранимой строки. Каталог мог с тех пор смениться —
   * приводим к нему на чтении, а не надеемся на то, что записано.
   */
  private parseMarks(raw: unknown): (string | null)[] {
    if (typeof raw !== 'string') return cleanMarks([]);
    try {
      const parsed: unknown = JSON.parse(raw);
      return cleanMarks(Array.isArray(parsed) ? (parsed as (string | null)[]) : []);
    } catch {
      return cleanMarks([]);
    }
  }

  /**
   * Отмечает, что игрок сейчас в приборе. Зовём это на опросе приглашений:
   * он идёт, пока игра открыта, и других поводов трогать строку нет.
   */
  async touchSeen(userId: string): Promise<void> {
    await this.client.execute({
      sql: `UPDATE users SET seen_at = datetime('now') WHERE id = ?`,
      args: [userId],
    });
  }

  /** Открыта ли у игрока игра прямо сейчас — по свежести последнего опроса. */
  async isOnline(userId: string, withinSeconds = 30): Promise<boolean> {
    const result = await this.client.execute({
      sql: `SELECT seen_at FROM users
            WHERE id = ? AND seen_at IS NOT NULL
              AND seen_at > datetime('now', ?)`,
      args: [userId, `-${withinSeconds} seconds`],
    });
    return result.rows.length > 0;
  }

  /**
   * Кладёт приглашение. От одного и того же друга оно одно: позвал заново —
   * заменил прежнее, а не насыпал очередь.
   */
  async addInvite(toUser: string, fromUser: string, room: string): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO invites (to_user, from_user, room) VALUES (?, ?, ?)
            ON CONFLICT (to_user, from_user) DO UPDATE
              SET room = excluded.room, created_at = datetime('now')`,
      args: [toUser, fromUser, room],
    });
  }

  /**
   * Свежие приглашения игроку. Протухшие не показываем и заодно чистим:
   * отдельная уборка ради двух строк не нужна.
   */
  async invitesFor(
    userId: string,
    liveSeconds = 90,
  ): Promise<{ from: string; mark: string | null; art?: string; room: string }[]> {
    await this.client.execute({
      sql: `DELETE FROM invites WHERE created_at <= datetime('now', ?)`,
      args: [`-${liveSeconds} seconds`],
    });
    const [result, holders] = await Promise.all([
      this.client.execute({
        sql: `SELECT u.id, u.name, u.marks, u.art, i.room
            FROM invites i JOIN users u ON u.id = i.from_user
            WHERE i.to_user = ?
            ORDER BY i.created_at DESC`,
        args: [userId],
      }),
      this.champions(),
    ]);
    return result.rows.map((row) => {
      const mark = this.firstMark(row.marks, holders.get(String(row.id)) ?? []);
      return { from: String(row.name), mark, ...this.ownArt(mark, row.art), room: String(row.room) };
    });
  }

  /** Снимает приглашение: его приняли, отклонили или комната закрылась. */
  async dropInvite(toUser: string, room: string): Promise<void> {
    await this.client.execute({
      sql: 'DELETE FROM invites WHERE to_user = ? AND room = ?',
      args: [toUser, room],
    });
  }

  /** Отметки, выданные игроку за игру. */
  async earnedMarks(userId: string): Promise<string[]> {
    const result = await this.client.execute({
      sql: 'SELECT mark_id FROM user_marks WHERE user_id = ?',
      args: [userId],
    });
    return result.rows.map((row) => String(row.mark_id));
  }

  /**
   * Выдаёт отметку. Повторная выдача ничего не меняет: отметка помнит свой
   * первый раз — тот, за который её и получили.
   */
  async grantMark(userId: string, markId: string): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO user_marks (user_id, mark_id) VALUES (?, ?)
            ON CONFLICT (user_id, mark_id) DO NOTHING`,
      args: [userId, markId],
    });
  }

  /**
   * Шильдики игрока: три ячейки, пустая — null. Золото, которое он уже не
   * держит, гаснет прямо здесь — иначе оно уехало бы сопернику на корпус.
   */
  async marksOf(userId: string): Promise<(string | null)[]> {
    const [result, gold] = await Promise.all([
      this.client.execute({
        sql: 'SELECT marks FROM users WHERE id = ?',
        args: [userId],
      }),
      this.goldMarks(userId),
    ]);
    return this.keepGold(this.parseMarks(result.rows[0]?.marks), gold);
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

  /**
   * Меняет имя, если замена ещё не потрачена. Проверка стоит в самом
   * запросе, а не рядом с ним: два одновременных нажатия иначе прошли бы
   * оба — оба увидели бы нетронутый признак и оба записали бы своё имя.
   *
   * Возвращает false, если замена уже была: снаружи это отказ, а не ошибка.
   */
  async renameUser(id: string, name: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: 'UPDATE users SET name = ?, renamed = 1 WHERE id = ? AND renamed = 0',
      args: [name, id],
    });
    return result.rowsAffected > 0;
  }

  /**
   * Выдаёт жетон за доведённый до конца заход — но не чаще, чем раз в
   * `gapSeconds`. Проверка стоит в самом запросе, а не рядом с ним: два
   * захода, досланные разом, иначе прошли бы оба — оба увидели бы старое
   * время и оба записали бы по жетону.
   *
   * Возвращает false, если жетон не положен: снаружи это не ошибка, а
   * обычный ответ — заход засчитан, а жетон за него уже был.
   */
  async grantToken(id: string, gapSeconds: number): Promise<boolean> {
    const result = await this.client.execute({
      sql: `UPDATE users
               SET tokens = tokens + 1, tokens_at = datetime('now')
             WHERE id = ?
               AND (tokens_at IS NULL OR tokens_at <= datetime('now', ?))`,
      args: [id, `-${gapSeconds} seconds`],
    });
    return result.rowsAffected > 0;
  }

  // ---------- Турнир ----------

  /**
   * Турнир дня: заводится при первом обращении и дальше только читается.
   * Сид выдаётся здесь же — один на всех, кто придёт в этот день.
   *
   * Гонки двух первых игроков не боимся: ключ дня уникален, и второй
   * `INSERT` просто не проходит — сид остаётся тот, что записался первым.
   */
  async tourneyOf(day: string): Promise<{ seed: number; settled: boolean }> {
    await this.client.execute({
      sql: `INSERT INTO tourneys (day, seed) VALUES (?, ?) ON CONFLICT DO NOTHING`,
      args: [day, randomInt(0, 0xffffffff)],
    });
    const rows = await this.client.execute({
      sql: 'SELECT seed, settled_at FROM tourneys WHERE day = ?',
      args: [day],
    });
    const row = rows.rows[0]!;
    return { seed: Number(row.seed), settled: row.settled_at !== null };
  }

  /** Участие игрока в турнире дня; null — не входил. */
  async tourneyEntry(day: string, userId: string): Promise<TourneyEntryRow | null> {
    const rows = await this.client.execute({
      sql: `SELECT rounds, score, place, prize FROM tourney_entries
             WHERE day = ? AND user_id = ?`,
      args: [day, userId],
    });
    const row = rows.rows[0];
    if (!row) return null;
    return {
      rounds: Number(row.rounds),
      score: Number(row.score),
      place: row.place === null ? null : Number(row.place),
      prize: row.prize === null ? null : Number(row.prize),
    };
  }

  /**
   * Взнос за вход. Списываем тем же порядком, что и покупку: сначала
   * запись об участии (она уникальна и не даст войти дважды), потом деньги
   * с условием в самом запросе, и если денег не хватило — запись убираем.
   * Ошибаться прибор должен в пользу того, кто за ним сидит.
   */
  async tourneyEnter(day: string, userId: string, fee: number): Promise<'ok' | 'poor' | 'in'> {
    const joined = await this.client.execute({
      sql: `INSERT INTO tourney_entries (day, user_id, paid) VALUES (?, ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [day, userId, fee],
    });
    if (joined.rowsAffected === 0) return 'in';
    const paid = await this.client.execute({
      sql: 'UPDATE users SET tokens = tokens - ? WHERE id = ? AND tokens >= ?',
      args: [fee, userId, fee],
    });
    if (paid.rowsAffected === 0) {
      await this.client.execute({
        sql: 'DELETE FROM tourney_entries WHERE day = ? AND user_id = ?',
        args: [day, userId],
      });
      return 'poor';
    }
    return 'ok';
  }

  /**
   * Начинает заход: раунд тратится здесь, а не в конце.
   *
   * Иначе турнира не получается вовсе. Заход, который засчитывается только
   * по истечении трёх минут, можно бросить на любой секунде и начать
   * заново — и тогда «три захода» превращаются в «сколько угодно попыток,
   * в зачёт три лучших». Раунд, потраченный на старте, делает неудачный
   * заход настоящей потерей: доигрывать его или нет — выбор игрока, но
   * раунд уже израсходован.
   */
  async tourneyStart(day: string, userId: string, round: number): Promise<boolean> {
    const started = await this.client.execute({
      sql: `INSERT INTO tourney_rounds (day, user_id, round, score, moves)
            VALUES (?, ?, ?, 0, '') ON CONFLICT DO NOTHING`,
      args: [day, userId, round],
    });
    if (started.rowsAffected === 0) return false;
    await this.countTourney(day, userId);
    return true;
  }

  /**
   * Дописывает счёт в начатый заход. Дописать можно только тот, что ещё не
   * доигран: пустой журнал ходов и есть признак начатого. Второй присыл в
   * тот же раунд ничего не меняет.
   */
  async tourneyFinish(day: string, userId: string, score: number, moves: string): Promise<boolean> {
    const saved = await this.client.execute({
      sql: `UPDATE tourney_rounds SET score = ?, moves = ?, played_at = datetime('now')
             WHERE day = ? AND user_id = ? AND moves = ''`,
      args: [score, moves, day, userId],
    });
    if (saved.rowsAffected === 0) return false;
    await this.countTourney(day, userId);
    return true;
  }

  /** Счета сыгранных заходов по порядку — их видно в своей карточке турнира. */
  async tourneyScores(day: string, userId: string): Promise<number[]> {
    const rows = await this.client.execute({
      sql: `SELECT score FROM tourney_rounds WHERE day = ? AND user_id = ? ORDER BY round ASC`,
      args: [day, userId],
    });
    return rows.rows.map((row) => Number(row.score));
  }

  /** Пересчитывает число заходов и сумму очков участника по его заходам. */
  private async countTourney(day: string, userId: string): Promise<void> {
    await this.client.execute({
      sql: `UPDATE tourney_entries
               SET rounds = (SELECT COUNT(*) FROM tourney_rounds r
                              WHERE r.day = tourney_entries.day AND r.user_id = tourney_entries.user_id),
                   score = (SELECT COALESCE(SUM(r.score), 0) FROM tourney_rounds r
                              WHERE r.day = tourney_entries.day AND r.user_id = tourney_entries.user_id),
                   last_at = datetime('now')
             WHERE day = ? AND user_id = ?`,
      args: [day, userId],
    });
  }

  /**
   * Таблица турнира: сыгравшие сверху, по сумме очков. Равенство очков
   * разрешается временем последнего захода — выше тот, кто закончил раньше:
   * он раньше показал этот результат, и ждать его повторения не пришлось.
   */
  async tourneyBoard(day: string, limit = 50): Promise<TourneyRow[]> {
    const rows = await this.client.execute({
      sql: `SELECT u.id, u.name, u.marks, u.art, e.score, e.rounds, e.prize, e.place
              FROM tourney_entries e JOIN users u ON u.id = e.user_id
             WHERE e.day = ?
             ORDER BY e.rounds = 0, e.score DESC, e.last_at ASC
             LIMIT ?`,
      args: [day, limit],
    });
    const holders = await this.champions();
    return rows.rows.map((row) => {
      const mark = this.firstMark(row.marks, holders.get(String(row.id)) ?? []);
      return {
        id: String(row.id),
        name: String(row.name),
        score: Number(row.score),
        rounds: Number(row.rounds),
        prize: row.prize === null ? null : Number(row.prize),
        place: row.place === null ? null : Number(row.place),
        mark,
        ...this.ownArt(mark, row.art),
      };
    });
  }

  /** Сколько народу вошло и сколько из них сыграло хотя бы заход. */
  async tourneyCount(day: string): Promise<{ entered: number; scorers: number; pool: number }> {
    const rows = await this.client.execute({
      sql: `SELECT COUNT(*) AS entered,
                   SUM(CASE WHEN rounds > 0 THEN 1 ELSE 0 END) AS scorers,
                   COALESCE(SUM(paid), 0) AS pool
              FROM tourney_entries WHERE day = ?`,
      args: [day],
    });
    const row = rows.rows[0]!;
    return {
      entered: Number(row.entered ?? 0),
      scorers: Number(row.scorers ?? 0),
      pool: Number(row.pool ?? 0),
    };
  }

  /**
   * Турниры игрока, новые сверху. Это его собственная история: за какой
   * день он платил, сколько заходов сыграл, какое место занял и что из
   * котла получил.
   *
   * Котёл и число участников считаем тем же запросом, а не отдельным на
   * каждый день: строка истории без котла — просто место без веса, а
   * тридцать запросов ради тридцати чисел прибор бы не пережил.
   */
  async tourneyHistory(userId: string, limit = 30): Promise<TourneyHistoryRow[]> {
    const rows = await this.client.execute({
      sql: `SELECT e.day, e.rounds, e.score, e.place, e.prize, e.paid,
                   (SELECT COUNT(*) FROM tourney_entries a WHERE a.day = e.day) AS entered,
                   (SELECT COALESCE(SUM(a.paid), 0) FROM tourney_entries a WHERE a.day = e.day) AS pool,
                   t.settled_at
              FROM tourney_entries e JOIN tourneys t ON t.day = e.day
             WHERE e.user_id = ?
             ORDER BY e.day DESC
             LIMIT ?`,
      args: [userId, limit],
    });
    return rows.rows.map((row) => ({
      day: String(row.day),
      rounds: Number(row.rounds),
      score: Number(row.score),
      place: row.place === null ? null : Number(row.place),
      prize: row.prize === null ? null : Number(row.prize),
      paid: Number(row.paid),
      entered: Number(row.entered),
      pool: Number(row.pool),
      settled: row.settled_at !== null,
    }));
  }

  /** Дни, которые пора считать: время итогов пришло, а котёл ещё цел. */
  async tourneysToSettle(today: string): Promise<string[]> {
    const rows = await this.client.execute({
      sql: 'SELECT day FROM tourneys WHERE settled_at IS NULL AND day <= ? ORDER BY day ASC',
      args: [today],
    });
    return rows.rows.map((row) => String(row.day));
  }

  /**
   * Раздаёт котёл. Места и призы сначала записываются участникам, потом
   * жетоны начисляются, и только затем турнир помечается посчитанным:
   * пометка последней — если оборвётся посередине, следующий запуск
   * посчитает тот же день заново, а не пропустит его.
   *
   * Повторной раздачи при этом не будет: призы кладутся тем же числом, а
   * начисление идёт по колонке `prize`, которую мы только что и записали.
   */
  async tourneySettle(day: string, prizes: { userId: string; place: number; prize: number }[]): Promise<void> {
    for (const { userId, place, prize } of prizes) {
      await this.client.execute({
        sql: 'UPDATE tourney_entries SET place = ?, prize = ? WHERE day = ? AND user_id = ?',
        args: [place, prize, day, userId],
      });
      if (prize > 0) {
        await this.client.execute({
          sql: 'UPDATE users SET tokens = tokens + ? WHERE id = ?',
          args: [prize, userId],
        });
      }
    }
    await this.client.execute({
      sql: `UPDATE tourneys SET settled_at = datetime('now') WHERE day = ? AND settled_at IS NULL`,
      args: [day],
    });
  }

  // ---------- Служба ----------

  /**
   * Есть ли у игрока вход из Telegram с таким номером. По этому и решается,
   * служащий он или нет: список номеров лежит в настройках сервера, а не в
   * базе, — права даёт тот, у кого доступ к серверу, и отобрать их можно,
   * не заходя в игру.
   */
  async telegramIdsOf(userId: string): Promise<string[]> {
    const rows = await this.client.execute({
      sql: `SELECT external_id FROM identities WHERE user_id = ? AND kind = 'telegram'`,
      args: [userId],
    });
    return rows.rows.map((row) => String(row.external_id));
  }

  /**
   * Поиск игрока службой. Одной строкой ищем по всему, чем игрока вообще
   * можно назвать: имя, код друга, номер в Telegram, номер аккаунта.
   * Точные совпадения идут первыми — по коду друга ищут именно того, кого
   * назвали, а не всех похожих.
   */
  async findPlayers(query: string, limit = 20): Promise<AdminFoundRow[]> {
    const rows = await this.client.execute({
      sql: `SELECT u.id, u.name, u.friend_code, u.rating, u.tokens, u.seen_at,
                   u.banned_until, u.banned_forever, u.ban_reason,
                   (SELECT GROUP_CONCAT(i.kind) FROM identities i WHERE i.user_id = u.id) AS kinds,
                   (u.friend_code = ?) AS by_code,
                   (u.id = ?) AS by_id,
                   EXISTS (SELECT 1 FROM identities i
                            WHERE i.user_id = u.id AND i.kind = 'telegram' AND i.external_id = ?)
                     AS by_telegram
              FROM users u
             WHERE u.friend_code = ? OR u.id = ? OR u.name LIKE ? OR by_telegram
             ORDER BY by_code DESC, by_id DESC, by_telegram DESC, u.rating DESC
             LIMIT ?`,
      args: [
        query.toUpperCase(),
        query,
        query,
        query.toUpperCase(),
        query,
        `%${query}%`,
        limit,
      ],
    });
    return rows.rows.map((row) => {
      const forever = Number(row.banned_forever) === 1;
      const until = row.banned_until === null || row.banned_until === undefined ? null : String(row.banned_until);
      return {
        id: String(row.id),
        name: String(row.name),
        code: row.friend_code === null ? null : String(row.friend_code),
        rating: Number(row.rating ?? 0),
        tokens: Number(row.tokens ?? 0),
        seenAt: row.seen_at === null || row.seen_at === undefined ? null : String(row.seen_at),
        identities: row.kinds === null || row.kinds === undefined ? [] : String(row.kinds).split(','),
        ...(forever || until !== null
          ? { ban: { until: forever ? null : until, reason: row.ban_reason === null ? '' : String(row.ban_reason) } }
          : {}),
      };
    });
  }

  /**
   * Кто сейчас наказан. Читается один раз при старте: список короткий, а
   * спрашивать базу на каждый запрос игрока ради редкой записи — дорого.
   * Дальше его держит в памяти сервер, обновляя при каждом бане и снятии.
   */
  async bans(): Promise<Map<string, { until: string | null; reason: string }>> {
    // Заодно прибираем отсиженное: срок вышел — записи о нём быть не должно.
    // Место для уборки выбрано это, а не проверка на каждый запрос: чистить
    // базу посреди чужого хода незачем, а при старте это один запрос.
    await this.client.execute(
      `UPDATE users SET banned_until = NULL, ban_reason = NULL
        WHERE banned_forever = 0 AND banned_until IS NOT NULL AND banned_until <= datetime('now')`,
    );
    const rows = await this.client.execute(
      `SELECT id, banned_until, banned_forever, ban_reason FROM users
        WHERE banned_forever = 1 OR banned_until IS NOT NULL`,
    );
    const out = new Map<string, { until: string | null; reason: string }>();
    for (const row of rows.rows) {
      out.set(String(row.id), {
        until: Number(row.banned_forever) === 1 ? null : String(row.banned_until),
        reason: row.ban_reason === null ? '' : String(row.ban_reason),
      });
    }
    return out;
  }

  /** Наказывает игрока: срок в днях, null — навсегда. */
  async ban(id: string, days: number | null, reason: string): Promise<string | null> {
    if (days === null) {
      await this.client.execute({
        sql: `UPDATE users SET banned_forever = 1, banned_until = NULL, ban_reason = ? WHERE id = ?`,
        args: [reason, id],
      });
      return null;
    }
    await this.client.execute({
      sql: `UPDATE users
               SET banned_forever = 0, banned_until = datetime('now', ?), ban_reason = ?
             WHERE id = ?`,
      args: [`+${days} days`, reason, id],
    });
    const rows = await this.client.execute({
      sql: 'SELECT banned_until FROM users WHERE id = ?',
      args: [id],
    });
    const until = rows.rows[0]?.banned_until;
    return until === null || until === undefined ? null : String(until);
  }

  /** Снимает бан. Причину снятия хранит журнал службы, а не игрок. */
  async unban(id: string): Promise<void> {
    await this.client.execute({
      sql: `UPDATE users SET banned_forever = 0, banned_until = NULL, ban_reason = NULL WHERE id = ?`,
      args: [id],
    });
  }

  /**
   * Принимает жалобу. Повторная от того же на того же ничего не меняет:
   * очередь — про то, сколько человек пожаловалось, а не сколько раз нажали.
   */
  async addReport(fromUser: string, targetUser: string): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO reports (from_user, target_user) VALUES (?, ?)
            ON CONFLICT DO NOTHING`,
      args: [fromUser, targetUser],
    });
  }

  /** Неразобранные жалобы, сгруппированные по тому, на кого жалуются. */
  async openReports(limit = 50): Promise<AdminReportRow[]> {
    const rows = await this.client.execute({
      sql: `SELECT r.target_user AS id, u.name, u.art,
                   u.banned_until, u.banned_forever, u.ban_reason,
                   COUNT(*) AS n, MAX(r.at) AS last_at
              FROM reports r JOIN users u ON u.id = r.target_user
             WHERE r.handled_at IS NULL
             GROUP BY r.target_user
             ORDER BY n DESC, last_at DESC
             LIMIT ?`,
      args: [limit],
    });
    return rows.rows.map((row) => {
      const forever = Number(row.banned_forever) === 1;
      const until = row.banned_until === null || row.banned_until === undefined ? null : String(row.banned_until);
      return {
        targetId: String(row.id),
        targetName: String(row.name),
        count: Number(row.n),
        lastAt: String(row.last_at),
        art: isArt(row.art) ? row.art : null,
        ...(forever || until !== null
          ? { ban: { until: forever ? null : until, reason: row.ban_reason === null ? '' : String(row.ban_reason) } }
          : {}),
      };
    });
  }

  /** Помечает жалобы на игрока разобранными. Записи остаются — они история. */
  async clearReports(targetUser: string, byAdmin: string): Promise<number> {
    const result = await this.client.execute({
      sql: `UPDATE reports SET handled_at = datetime('now'), handled_by = ?
             WHERE target_user = ? AND handled_at IS NULL`,
      args: [byAdmin, targetUser],
    });
    return result.rowsAffected;
  }

  /** Имя игрока — для журнала: по одному номеру аккаунта в нём не разобраться. */
  async nameOf(userId: string): Promise<string | null> {
    const rows = await this.client.execute({
      sql: 'SELECT name FROM users WHERE id = ?',
      args: [userId],
    });
    const name = rows.rows[0]?.name;
    return name === undefined || name === null ? null : String(name);
  }

  /**
   * Служба меняет имя без оглядки на «замену раз в жизни»: она снимает
   * непристойное имя, а не тратит право игрока. Право при этом возвращаем —
   * игрок за чужое решение платить не должен.
   */
  async renameByService(id: string, name: string): Promise<void> {
    await this.client.execute({
      sql: 'UPDATE users SET name = ?, renamed = 0 WHERE id = ?',
      args: [name, id],
    });
  }

  /**
   * Снимает рисунок с пропуска. Место под свой шильдик не отбираем: оно
   * куплено за жетоны, а снимаем мы картинку, а не покупку, — игрок рисует
   * новую.
   */
  async clearArt(id: string): Promise<void> {
    await this.client.execute({
      sql: 'UPDATE users SET art = NULL WHERE id = ?',
      args: [id],
    });
  }

  /** Записывает действие службы. Пишется всегда — и когда всё прошло, и когда нет. */
  async logAdmin(entry: {
    adminId: string;
    adminName: string;
    targetId: string;
    targetName: string;
    action: string;
    detail: string;
    reason: string;
  }): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO admin_log (admin_id, admin_name, target_id, target_name, action, detail, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        entry.adminId,
        entry.adminName,
        entry.targetId,
        entry.targetName,
        entry.action,
        entry.detail,
        entry.reason,
      ],
    });
  }

  /** Последние записи журнала — новые сверху. */
  async adminLog(limit = 50): Promise<AdminLogRow[]> {
    const rows = await this.client.execute({
      sql: `SELECT at, admin_name, target_id, target_name, action, detail, reason
              FROM admin_log ORDER BY id DESC LIMIT ?`,
      args: [limit],
    });
    return rows.rows.map((row) => ({
      at: String(row.at),
      admin: String(row.admin_name),
      target: String(row.target_id),
      targetName: String(row.target_name),
      action: String(row.action),
      detail: String(row.detail),
      reason: String(row.reason),
    }));
  }

  /**
   * Служебная наладка: ставит жетоны числом, а не начислением.
   *
   * Здесь нет ни окна между начислениями, ни проверки, за что платят: это
   * не игровой путь, и попасть сюда можно только со служебным ключом (см.
   * `/api/service/*` в `app.ts`). Игровой путь — `grantToken`.
   */
  async setTokens(id: string, tokens: number): Promise<void> {
    await this.client.execute({
      sql: 'UPDATE users SET tokens = ? WHERE id = ?',
      args: [Math.max(0, Math.round(tokens)), id],
    });
  }

  /** Служебная наладка: ставит рейтинг и число сыгранных рейтинговых матчей. */
  async setRating(id: string, rating: number, games: number, kind: DuelKind): Promise<void> {
    const col = this.ratingColumns(kind);
    await this.client.execute({
      sql: `UPDATE users SET ${col.rating} = ?, ${col.games} = ? WHERE id = ?`,
      args: [Math.round(rating), Math.max(0, Math.round(games)), id],
    });
  }

  /**
   * Служебная наладка: снимает с игрока всё нажитое — выданное, купленное,
   * надетое и нарисованное. Нужна ровно затем, чтобы посмотреть прибор
   * глазами новичка, не заводя новый аккаунт.
   */
  async clearBelongings(id: string): Promise<void> {
    await this.client.execute({ sql: 'DELETE FROM user_marks WHERE user_id = ?', args: [id] });
    await this.client.execute({
      sql: 'UPDATE users SET marks = NULL, frame = NULL, art = NULL, tokens = 0 WHERE id = ?',
      args: [id],
    });
  }

  /**
   * Покупка за жетоны — наклейки или оправы: выдаёт её и списывает цену,
   * или не делает ничего. Купленное лежит там же, где выданное за игру:
   * прибор помнит одним списком всё, что игроку положено носить.
   *
   * Возвращает, чем кончилось: `owned` — эта наклейка у игрока уже есть,
   * `poor` — не хватило жетонов. Снаружи и то и другое — отказ, а не ошибка.
   *
   * Транзакции здесь нет намеренно: `client.transaction()` берёт своё
   * подключение, а с `url: ':memory:'` — вместе с ним и свою пустую базу,
   * так что после неё сервер перестаёт видеть даже таблицу users. Поэтому
   * порядок держит сам себя:
   *
   * 1. Спрашиваем разом счёт и есть ли уже такая наклейка — обычный отказ
   *    отвечает по делу и ничего не трогает. «Она у тебя уже есть» здесь
   *    важнее, чем «не хватает жетонов»: у хозяина наклейки денег тоже
   *    может не быть, и цена того, что он и так носит, ему ни о чём.
   * 2. Выдаём наклейку. Строка уникальная, поэтому двух покупок одной и той
   *    же не бывает даже с двух устройств разом: второй INSERT не проходит,
   *    и платить по нему уже не за что.
   * 3. Списываем цену с условием в самом запросе. Если счёт всё-таки успел
   *    уйти между шагами, выданное отбираем обратно.
   *
   * Порядок выбран так, что редкий обрыв между шагами оставляет игроку
   * наклейку, а не забирает жетоны: ошибаться прибор должен в пользу того,
   * кто за ним сидит.
   */
  async buyItem(userId: string, itemId: string, price: number): Promise<'ok' | 'poor' | 'owned'> {
    const state = await this.client.execute({
      sql: `SELECT tokens,
                   EXISTS (SELECT 1 FROM user_marks WHERE user_id = u.id AND mark_id = ?) AS owned
              FROM users u WHERE u.id = ?`,
      args: [itemId, userId],
    });
    const row = state.rows[0];
    if (!row) return 'poor';
    if (Number(row.owned) === 1) return 'owned';
    if (Number(row.tokens) < price) return 'poor';

    const given = await this.client.execute({
      sql: `INSERT INTO user_marks (user_id, mark_id) VALUES (?, ?)
            ON CONFLICT (user_id, mark_id) DO NOTHING`,
      args: [userId, itemId],
    });
    if (given.rowsAffected === 0) return 'owned';
    const paid = await this.client.execute({
      sql: 'UPDATE users SET tokens = tokens - ? WHERE id = ? AND tokens >= ?',
      args: [price, userId, price],
    });
    if (paid.rowsAffected === 0) {
      await this.client.execute({
        sql: 'DELETE FROM user_marks WHERE user_id = ? AND mark_id = ?',
        args: [userId, itemId],
      });
      return 'poor';
    }
    return 'ok';
  }

  /**
   * Свой рисунок игрока; null — не рисовал или запись испорчена. Битую
   * запись читаем как пустую: шильдик без картинки лучше, чем упавший
   * ответ на весь пропуск.
   */
  async artOf(id: string): Promise<string | null> {
    const rows = await this.client.execute({
      sql: 'SELECT art FROM users WHERE id = ?',
      args: [id],
    });
    const art = rows.rows[0]?.art;
    return isArt(art) ? art : null;
  }

  async setArt(id: string, art: string): Promise<void> {
    await this.client.execute({
      sql: 'UPDATE users SET art = ? WHERE id = ?',
      args: [art, id],
    });
  }

  /** Надетая оправа полосы; null — снята или не куплена. */
  async frameOf(id: string): Promise<string | null> {
    const rows = await this.client.execute({
      sql: 'SELECT frame FROM users WHERE id = ?',
      args: [id],
    });
    const frame = rows.rows[0]?.frame;
    return frame === null || frame === undefined ? null : String(frame);
  }

  async setFrame(id: string, frame: string | null): Promise<void> {
    await this.client.execute({
      sql: 'UPDATE users SET frame = ? WHERE id = ?',
      args: [frame, id],
    });
  }

  /** Надетые оправы сразу нескольких игроков — для полосы соперника. */
  async framesOf(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const marks = ids.map(() => '?').join(', ');
    const rows = await this.client.execute({
      sql: `SELECT id, frame FROM users WHERE id IN (${marks}) AND frame IS NOT NULL`,
      args: [...ids],
    });
    return new Map(rows.rows.map((row) => [String(row.id), String(row.frame)]));
  }

  /** Сколько жетонов у игрока сейчас. */
  async tokensOf(id: string): Promise<number> {
    const rows = await this.client.execute({
      sql: 'SELECT tokens FROM users WHERE id = ?',
      args: [id],
    });
    return Number(rows.rows[0]?.tokens ?? 0);
  }

  /** Потрачена ли замена имени. */
  async renamed(id: string): Promise<boolean> {
    const rows = await this.client.execute({
      sql: 'SELECT renamed FROM users WHERE id = ?',
      args: [id],
    });
    return Number(rows.rows[0]?.renamed ?? 0) === 1;
  }

  close(): void {
    this.client.close();
  }
}
