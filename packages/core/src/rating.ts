/**
 * Рейтинг по Glicko-2.
 *
 * В отличие от Elo система хранит не только силу игрока, но и неуверенность
 * в ней (RD): у новичка и у вернувшегося после перерыва рейтинг двигается
 * резче, у наигранного — плавнее. Это важно для игры, где заходят редко.
 *
 * Реализация следует оригинальной работе Марка Гликмана; внутри вычисления
 * идут в «шкале Glicko-2» (µ, φ), наружу — в привычной шкале (1500 ± 350).
 */

/** Стартовые значения для нового игрока. */
export const DEFAULT_RATING = 1500;
export const DEFAULT_DEVIATION = 350;
export const DEFAULT_VOLATILITY = 0.06;

/**
 * Сколько матчей игрок «калибруется». Glicko специально двигает новичка
 * резко — за один бой рейтинг может уйти на пару сотен очков. Это верно
 * математически, но лига, выданная за одну победу, ничего не значит,
 * поэтому в таблицу и в лигу игрок попадает только после калибровки.
 */
export const PLACEMENT_GAMES = 5;

/** Насколько быстро система допускает скачки формы. */
const TAU = 0.5;
const SCALE = 173.7178;
const CONVERGENCE = 0.000001;

export interface Rating {
  rating: number;
  deviation: number;
  volatility: number;
}

export function newRating(): Rating {
  return {
    rating: DEFAULT_RATING,
    deviation: DEFAULT_DEVIATION,
    volatility: DEFAULT_VOLATILITY,
  };
}

/** Результат матча глазами игрока. */
export type Outcome = 'win' | 'loss' | 'draw';

function outcomeScore(outcome: Outcome): number {
  return outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0;
}

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function expected(mu: number, opponentMu: number, opponentPhi: number): number {
  return 1 / (1 + Math.exp(-g(opponentPhi) * (mu - opponentMu)));
}

/**
 * Пересчитывает рейтинг после одного матча.
 * Возвращает новое состояние; исходное не меняется.
 */
export function updateRating(player: Rating, opponent: Rating, outcome: Outcome): Rating {
  const mu = (player.rating - DEFAULT_RATING) / SCALE;
  const phi = player.deviation / SCALE;
  const opponentMu = (opponent.rating - DEFAULT_RATING) / SCALE;
  const opponentPhi = opponent.deviation / SCALE;

  const gPhi = g(opponentPhi);
  const e = expected(mu, opponentMu, opponentPhi);
  const score = outcomeScore(outcome);

  // Дисперсия и «неожиданность» результата.
  const v = 1 / (gPhi * gPhi * e * (1 - e));
  const delta = v * gPhi * (score - e);

  const volatility = nextVolatility(phi, v, delta, player.volatility);

  const phiStar = Math.sqrt(phi * phi + volatility * volatility);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * gPhi * (score - e);

  return {
    rating: Math.round(newMu * SCALE + DEFAULT_RATING),
    // Ниже 30 RD не опускаем: иначе рейтинг застывает и перестаёт реагировать.
    deviation: Math.max(30, Math.round(newPhi * SCALE)),
    volatility,
  };
}

/** Итерационный поиск новой волатильности (алгоритм Иллинойса). */
function nextVolatility(phi: number, v: number, delta: number, volatility: number): number {
  const a = Math.log(volatility * volatility);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const phi2 = phi * phi;
    const numerator = ex * (delta * delta - phi2 - v - ex);
    const denominator = 2 * (phi2 + v + ex) * (phi2 + v + ex);
    return numerator / denominator - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }

  let fA = f(A);
  let fB = f(B);
  let guard = 0;
  while (Math.abs(B - A) > CONVERGENCE && guard++ < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }

  return Math.exp(A / 2);
}

/**
 * Рост неуверенности за время простоя: чем дольше игрок не играл, тем
 * меньше система доверяет его рейтингу.
 */
export function decayDeviation(rating: Rating, idleDays: number): Rating {
  if (idleDays <= 0) return rating;
  const phi = rating.deviation / SCALE;
  // Один «период бездействия» — неделя без матчей.
  const periods = idleDays / 7;
  const phiStar = Math.sqrt(phi * phi + rating.volatility * rating.volatility * periods);
  return {
    ...rating,
    deviation: Math.min(DEFAULT_DEVIATION, Math.round(phiStar * SCALE)),
  };
}

// ---------- Лиги ----------

export interface League {
  key: string;
  name: string;
  /** Нижняя граница рейтинга. */
  from: number;
}

/**
 * Лиги — приборы возрастающей разрешающей силы: от лупы до обсерватории.
 * Границы подобраны так, чтобы новичок стартовал в середине «Лупы».
 */
export const LEAGUES: League[] = [
  { key: 'loupe', name: 'Лупа', from: 0 },
  { key: 'binocular', name: 'Бинокль', from: 1600 },
  { key: 'microscope', name: 'Микроскоп', from: 1750 },
  { key: 'telescope', name: 'Телескоп', from: 1900 },
  { key: 'observatory', name: 'Обсерватория', from: 2100 },
];

export function leagueOf(rating: number): League {
  let current = LEAGUES[0]!;
  for (const league of LEAGUES) {
    if (rating >= league.from) current = league;
  }
  return current;
}

/** Следующая лига и сколько до неё очков; null — если игрок на вершине. */
export function nextLeague(rating: number): { league: League; gap: number } | null {
  const higher = LEAGUES.find((league) => league.from > rating);
  return higher ? { league: higher, gap: higher.from - rating } : null;
}
