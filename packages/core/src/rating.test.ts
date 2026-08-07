import { describe, expect, it } from 'vitest';
import {
  decayDeviation,
  leagueOf,
  newRating,
  nextLeague,
  updateRating,
  DEFAULT_DEVIATION,
  DEFAULT_RATING,
  LEAGUES,
} from './rating.js';

describe('updateRating', () => {
  it('победа поднимает рейтинг, поражение опускает', () => {
    const player = newRating();
    const opponent = newRating();
    const won = updateRating(player, opponent, 'win');
    const lost = updateRating(player, opponent, 'loss');
    expect(won.rating).toBeGreaterThan(DEFAULT_RATING);
    expect(lost.rating).toBeLessThan(DEFAULT_RATING);
  });

  it('ничья с равным почти не двигает рейтинг', () => {
    const drawn = updateRating(newRating(), newRating(), 'draw');
    expect(Math.abs(drawn.rating - DEFAULT_RATING)).toBeLessThanOrEqual(1);
  });

  it('победа над сильным даёт больше, чем над слабым', () => {
    const player = { rating: 1500, deviation: 100, volatility: 0.06 };
    const strong = { rating: 1900, deviation: 100, volatility: 0.06 };
    const weak = { rating: 1200, deviation: 100, volatility: 0.06 };
    const overStrong = updateRating(player, strong, 'win').rating - player.rating;
    const overWeak = updateRating(player, weak, 'win').rating - player.rating;
    expect(overStrong).toBeGreaterThan(overWeak);
  });

  it('поражение от слабого наказывает сильнее, чем от сильного', () => {
    const player = { rating: 1500, deviation: 100, volatility: 0.06 };
    const strong = { rating: 1900, deviation: 100, volatility: 0.06 };
    const weak = { rating: 1200, deviation: 100, volatility: 0.06 };
    const toStrong = player.rating - updateRating(player, strong, 'loss').rating;
    const toWeak = player.rating - updateRating(player, weak, 'loss').rating;
    expect(toWeak).toBeGreaterThan(toStrong);
  });

  it('у новичка рейтинг двигается резче, чем у наигранного', () => {
    const rookie = newRating();
    const veteran = { rating: 1500, deviation: 50, volatility: 0.06 };
    const opponent = { rating: 1500, deviation: 50, volatility: 0.06 };
    const rookieGain = updateRating(rookie, opponent, 'win').rating - rookie.rating;
    const veteranGain = updateRating(veteran, opponent, 'win').rating - veteran.rating;
    expect(rookieGain).toBeGreaterThan(veteranGain);
  });

  it('с матчами неуверенность падает, но не ниже порога', () => {
    let rating = newRating();
    const opponent = newRating();
    for (let i = 0; i < 40; i++) {
      rating = updateRating(rating, opponent, i % 2 === 0 ? 'win' : 'loss');
    }
    expect(rating.deviation).toBeLessThan(DEFAULT_DEVIATION);
    expect(rating.deviation).toBeGreaterThanOrEqual(30);
  });

  it('не мутирует исходные значения', () => {
    const player = newRating();
    const snapshot = { ...player };
    updateRating(player, newRating(), 'win');
    expect(player).toEqual(snapshot);
  });

  it('серия побед поднимает игрока в следующую лигу', () => {
    let rating = newRating();
    const opponent = { rating: 1700, deviation: 80, volatility: 0.06 };
    for (let i = 0; i < 10; i++) rating = updateRating(rating, opponent, 'win');
    expect(rating.rating).toBeGreaterThan(1600);
    expect(leagueOf(rating.rating).key).not.toBe('apprentice');
  });
});

describe('decayDeviation', () => {
  it('простой повышает неуверенность, но не выше стартовой', () => {
    const settled = { rating: 1700, deviation: 60, volatility: 0.06 };
    const afterWeek = decayDeviation(settled, 7);
    const afterYear = decayDeviation(settled, 365);
    expect(afterWeek.deviation).toBeGreaterThan(settled.deviation);
    expect(afterYear.deviation).toBeLessThanOrEqual(DEFAULT_DEVIATION);
    expect(afterWeek.rating).toBe(settled.rating);
  });

  it('без простоя ничего не меняет', () => {
    const rating = { rating: 1700, deviation: 60, volatility: 0.06 };
    expect(decayDeviation(rating, 0)).toEqual(rating);
  });
});

describe('лиги', () => {
  it('новичок стартует в первой лиге', () => {
    expect(leagueOf(DEFAULT_RATING).key).toBe('apprentice');
  });

  it('границы лиг идут по возрастанию и покрывают шкалу', () => {
    for (let i = 1; i < LEAGUES.length; i++) {
      expect(LEAGUES[i]!.from).toBeGreaterThan(LEAGUES[i - 1]!.from);
    }
    expect(leagueOf(0).key).toBe('apprentice');
    expect(leagueOf(99_999).key).toBe(LEAGUES[LEAGUES.length - 1]!.key);
  });

  it('на границе игрок уже в новой лиге', () => {
    const junior = LEAGUES.find((league) => league.key === 'junior')!;
    expect(leagueOf(junior.from).key).toBe('junior');
    expect(leagueOf(junior.from - 1).key).toBe('apprentice');
  });

  it('подсказывает следующую лигу и разрыв до неё', () => {
    const next = nextLeague(1550);
    expect(next).toMatchObject({ gap: 50 });
    expect(next!.league.key).toBe('junior');
    expect(nextLeague(99_999)).toBeNull();
  });
});
