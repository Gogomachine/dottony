import { describe, expect, it } from 'vitest';
import {
  CARE_DIALS,
  DIALS,
  HATCH_HOURS,
  SCALE,
  advance,
  axesOf,
  bodyOf,
  bodyOfSpecies,
  boundsOf,
  viewBoxOf,
  comfortOf,
  dayVerdict,
  dialFits,
  envFits,
  feed,
  formOdds,
  hintFor,
  HINT_REACH,
  labDay,
  labDayShift,
  moodOf,
  resetDials,
  setDials,
  speciesId,
  speciesOfColor,
  zoneOf,
  zoneMiddle,
  GROW_DAYS,
  NEGLECT_DEATH,
  MAX_MUTATIONS,
  MISS_GUARANTEE,
  SEED_PRICE,
  breed,
  breedable,
  mutationCount,
  seedCost,
  type Creature,
  type Dials,
  type BreedOptions,
  type Incubator,
  type Species,
} from './index.js';

/**
 * Часы теста: девять утра в лаборатории. Полсуток от них — тот же день,
 * а не полночь, и вылупление не приходится проверять на границе.
 */
const START = new Date('2026-03-15T06:00:00Z');
const at = (hours: number): Date => new Date(START.getTime() + hours * 3600_000);

/** Точка, только что посеянная: формы у неё ещё нет. */
function seeded(species: Species, day = labDay(START)): Incubator {
  const creature: Creature = {
    id: 'c1',
    generation: 1,
    color: species.color,
    colorMutation: null,
    behaviour: 'cling',
    behaviourMutation: null,
    bodyAnomaly: null,
    axes: null,
    stage: 1,
    parents: null,
    bredAt: null,
    createdAt: START.toISOString(),
  };
  return {
    seed: 4242,
    creature,
    dials: null,
    day,
    feeds: 0,
    neglect: 0,
    goodDays: 0,
    immortal: false,
    lostAt: null,
  };
}

/** Тумблеры на рецепт этого вида — так из точки вылупляют нужную форму. */
function recipe(species: Species): Dials {
  return {
    temp: zoneMiddle('temp', species.axes.temp),
    humidity: zoneMiddle('humidity', species.axes.humidity),
    medium: zoneMiddle('medium', species.axes.medium),
  };
}

/**
 * Вылупить нужную форму: выставить рецепт и выждать положенные часы. Форму
 * выбирают тумблеры в миг вылупления, поэтому «посеял и перемотал» дало бы
 * ту форму, которую подсказал случайный сброс, а не ту, что нужна тесту.
 */
function hatched(species: Species): Incubator {
  const start = setDials(seeded(species), recipe(species));
  return advance(start, at(HATCH_HOURS)).inc;
}

/**
 * Тумблеры ровно в комфорт этого вида — так ухаживает знающий игрок.
 * Питательная среда в уходе не участвует: после вылупления её тумблера на
 * корпусе нет вовсе, и ставим её как попало нарочно.
 */
function comfy(species: Species): Dials {
  const comfort = comfortOf(species);
  return { temp: comfort.temp.at, humidity: comfort.humidity.at, medium: 0 };
}

/** Один день ухода: выставил среду, покормил — и сутки кончились. */
function tended(inc: Incubator, species: Species, hours: number): Incubator {
  return advance(feed(setDials(inc, comfy(species))), at(hours)).inc;
}

const YELLOW: Species = { color: 'yellow', axes: { temp: 1, humidity: 1, medium: 1 } };

describe('шкалы и формы', () => {
  it('двадцать семь форм на цвет, и все различаются ключом', () => {
    const all = speciesOfColor('yellow');
    expect(all).toHaveLength(27);
    expect(new Set(all.map(speciesId)).size).toBe(27);
  });

  it('положение тумблера попадает в зону, а зона — в ось формы', () => {
    // Края узкие, середина широкая: обычная форма попадается сама, редкую
    // приходится искать нарочно.
    expect(zoneOf('temp', 0)).toBe(0);
    expect(zoneOf('temp', SCALE)).toBe(2);
    expect(zoneOf('temp', 450)).toBe(1);
    const axes = axesOf({ temp: 100, humidity: 500, medium: 900 });
    expect(axes).toEqual({ temp: 0, humidity: 1, medium: 2 });
  });

  it('редкость формы считается из ширины зон, а не из отдельной таблицы', () => {
    const common = formOdds({ color: 'yellow', axes: { temp: 1, humidity: 1, medium: 1 } });
    const rare = formOdds({ color: 'yellow', axes: { temp: 0, humidity: 0, medium: 0 } });
    expect(common).toBeGreaterThan(rare * 4);
    // Все двадцать семь долей вместе дают ровно единицу: ни одна комбинация
    // не потеряна и ни одна не посчитана дважды.
    const total = speciesOfColor('yellow').reduce((sum, species) => sum + formOdds(species), 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

describe('комфорт', () => {
  it('у вида он свой, всегда один и тот же и не совпадает с зоной рождения', () => {
    const first = comfortOf(YELLOW);
    const second = comfortOf({ color: 'yellow', axes: { ...YELLOW.axes } });
    expect(second).toEqual(first);

    // Разные виды — разные требования: иначе таблицы сообщества были бы
    // одной строкой на всю игру.
    const others = speciesOfColor('yellow').map((species) => comfortOf(species).temp.at);
    expect(new Set(others).size).toBeGreaterThan(15);

    // И знание рецепта не даёт знания ухода: хотя бы у части видов комфорт
    // лежит вне той зоны, из которой они вылупились.
    const elsewhere = speciesOfColor('yellow').filter(
      (species) => zoneOf('temp', comfortOf(species).temp.at) !== species.axes.temp,
    );
    expect(elsewhere.length).toBeGreaterThan(10);
  });

  it('подсказка называет сторону издали и молчит вблизи', () => {
    // Стрелка, работающая вплотную, находится перебором за полминуты:
    // крути тумблер, пока она не перевернётся, — и вот точная граница.
    // Поэтому вблизи прибор говорит только «рядом».
    const comfort = comfortOf(YELLOW);
    const { at, span } = comfort.temp;
    expect(hintFor(YELLOW, 'temp', at)).toBe('fits');
    expect(hintFor(YELLOW, 'temp', at - span - 1)).toBe('near');
    expect(hintFor(YELLOW, 'temp', at + span + 1)).toBe('near');
    expect(hintFor(YELLOW, 'temp', at - span * (HINT_REACH + 2))).toBe('more');
    expect(hintFor(YELLOW, 'temp', at + span * (HINT_REACH + 2))).toBe('less');
  });

  it('среда хороша по обоим тумблерам ухода, а третий её не касается', () => {
    const comfort = comfortOf(YELLOW);
    expect(envFits(YELLOW, comfy(YELLOW))).toBe(true);
    for (const dial of CARE_DIALS) {
      const off = { ...comfy(YELLOW), [dial]: comfort[dial].at + comfort[dial].span + 1 };
      expect(envFits(YELLOW, off as Dials)).toBe(false);
    }
    // Питательная среда своё дело сделала при вылуплении: крутить её после
    // некуда — тумблера нет, — и на уход она не влияет никак.
    expect(envFits(YELLOW, { ...comfy(YELLOW), medium: SCALE })).toBe(true);
  });
});

describe('суточный сброс', () => {
  it('одни и те же сутки дают одни и те же положения, соседние — разные', () => {
    // Сброс не хранится, а считается: прибор досчитывает пропущенные сутки
    // задним числом и обязан знать, как тогда стояли тумблеры.
    expect(resetDials(77, '2026-03-15')).toEqual(resetDials(77, '2026-03-15'));
    expect(resetDials(77, '2026-03-15')).not.toEqual(resetDials(77, '2026-03-16'));
    expect(resetDials(77, '2026-03-15')).not.toEqual(resetDials(78, '2026-03-15'));
  });

  it('положения лежат на шкале и не липнут к одному концу', () => {
    const seen: number[] = [];
    for (let i = 0; i < 60; i++) {
      const dials = resetDials(1, labDayShift('2026-01-01', i));
      for (const dial of DIALS) {
        expect(dials[dial]).toBeGreaterThanOrEqual(0);
        expect(dials[dial]).toBeLessThanOrEqual(SCALE);
      }
      seen.push(dials.temp);
    }
    const half = seen.filter((value) => value > SCALE / 2).length;
    expect(half).toBeGreaterThan(15);
    expect(half).toBeLessThan(45);
  });

  it('случайный сброс почти никогда не попадает в комфорт сам', () => {
    // Если бы попадал, ухаживать было бы незачем: прибор ухаживал бы сам.
    let lucky = 0;
    for (let i = 0; i < 300; i++) {
      if (envFits(YELLOW, resetDials(9, labDayShift('2026-01-01', i)))) lucky++;
    }
    expect(lucky).toBeLessThan(10);
  });
});

describe('рост и уход', () => {
  /** Конец k-х суток ухода в часах от начала: сутки кончаются в полночь. */
  const careDay = (k: number): number => 16 + 24 * k;

  /** Тумблеры заведомо мимо комфорта — чтобы сутки были небрежными наверняка. */
  const wrong = (species: Species): Dials => {
    const comfort = comfortOf(species);
    return {
      temp: comfort.temp.at > SCALE / 2 ? 0 : SCALE,
      humidity: comfort.humidity.at > SCALE / 2 ? 0 : SCALE,
      medium: 0,
    };
  };

  it('точка вылупляется за полсуток, а не за сутки', () => {
    // Первая стадия — не уход, а рецепт: игрок выставил тумблеры и ждёт,
    // что из них выйдет. Брать за это ожидание целые сутки не за что.
    const inc = setDials(seeded(YELLOW), recipe(YELLOW));
    expect(dayVerdict(inc)).toBe('point');
    expect(advance(inc, at(HATCH_HOURS - 1)).inc.creature?.stage).toBe(1);
    const after = advance(inc, at(HATCH_HOURS)).inc;
    expect(after.creature?.stage).toBe(2);
    expect(after.creature?.axes).toEqual(YELLOW.axes);
    expect(after.lostAt).toBeNull();
    // Рецепт израсходован: тумблеры сброшены, и начинается уход.
    expect(after.dials).toBeNull();
    expect(after.feeds).toBe(0);
  });

  it('точке тумблеры не сбрасывают: они и есть рецепт', () => {
    // Полсуток почти всегда перешагивают полночь. Если бы сброс трогал
    // точку, форму выбирал бы прибор, а не человек: поставил вечером —
    // получил утром неизвестно что.
    const born = at(8);
    const seed = seeded(YELLOW);
    const late = {
      ...seed,
      creature: { ...seed.creature!, createdAt: born.toISOString() },
      dials: recipe(YELLOW),
    };
    const after = advance(late, at(8 + HATCH_HOURS + 1)).inc;
    expect(after.creature?.stage).toBe(2);
    expect(after.creature?.axes).toEqual(YELLOW.axes);
  });

  it('взрослая форма приходит за хорошие сутки, а не за календарные', () => {
    let inc = hatched(YELLOW);
    expect(inc.creature?.stage).toBe(2);
    for (let i = 0; i < GROW_DAYS; i++) inc = tended(inc, YELLOW, careDay(i));
    expect(inc.creature?.stage).toBe(3);
  });

  it('небрежные сутки в зачёт роста не идут', () => {
    let inc = hatched(YELLOW);
    // Кормили, но среду выставили мимо — сутки потрачены зря.
    inc = advance(feed(setDials(inc, wrong(YELLOW))), at(careDay(0))).inc;
    expect(inc.creature?.stage).toBe(2);
    expect(inc.goodDays).toBe(0);
    expect(inc.neglect).toBe(1);
  });

  it('перекорм так же плох, как голод', () => {
    const inc = setDials(hatched(YELLOW), comfy(YELLOW));
    expect(dayVerdict(feed(inc))).toBe('good');
    expect(dayVerdict(feed(feed(inc)))).toBe('stuffed');
    expect(dayVerdict(inc)).toBe('hungry');
    expect(moodOf(feed(feed(inc)))).toBe('stuffed');
    expect(moodOf(feed(inc))).toBe('fine');
  });

  it('гибель наступает на третьи сутки небрежения, а не на первые', () => {
    // Тумблеры сбрасываются сами: смерть за один пропущенный день значила бы
    // потерю выращивания по причинам, не относящимся к игре.
    const start = setDials(hatched(YELLOW), wrong(YELLOW));
    for (let skipped = 0; skipped < NEGLECT_DEATH - 1; skipped++) {
      expect(advance(start, at(careDay(skipped))).inc.lostAt).toBeNull();
    }
    const dead = advance(start, at(careDay(NEGLECT_DEATH - 1)));
    expect(dead.inc.lostAt).not.toBeNull();
    expect(dead.log.some((entry) => entry.lost)).toBe(true);
    expect(dead.inc.day).toBe(labDay(at(careDay(NEGLECT_DEATH - 1))));
  });

  it('хорошие сутки отводят от гибели', () => {
    let inc = advance(setDials(hatched(YELLOW), wrong(YELLOW)), at(careDay(0))).inc;
    expect(inc.neglect).toBe(1);
    inc = tended(inc, YELLOW, careDay(1));
    expect(inc.neglect).toBe(0);
  });

  it('первый питомец не погибает: на нём учатся', () => {
    const start = { ...hatched(YELLOW), immortal: true };
    const long = advance(start, at(careDay(29))).inc;
    expect(long.lostAt).toBeNull();
    expect(long.creature?.stage).toBe(2);
  });

  it('прибор не живёт назад и не считает те же сутки дважды', () => {
    const inc = hatched(YELLOW);
    expect(advance(inc, START).inc).toEqual(inc);
    expect(advance(inc, at(HATCH_HOURS)).log).toHaveLength(0);
  });

  it('новые сутки сбрасывают и тумблеры, и кормёжку', () => {
    let inc = feed(setDials(hatched(YELLOW), comfy(YELLOW)));
    expect(inc.dials).not.toBeNull();
    inc = advance(inc, at(careDay(0))).inc;
    expect(inc.dials).toBeNull();
    expect(inc.feeds).toBe(0);
  });

  it('взрослая форма законсервирована: сутки ей ничего не делают', () => {
    let inc = hatched(YELLOW);
    for (let i = 0; i < GROW_DAYS; i++) inc = tended(inc, YELLOW, careDay(i));
    expect(inc.creature?.stage).toBe(3);
    const later = advance(inc, at(careDay(GROW_DAYS + 20))).inc;
    expect(later.lostAt).toBeNull();
    expect(later.creature?.stage).toBe(3);
  });

  it('состояние называет то, что хуже всего, — по одному признаку за раз', () => {
    // Кормим по разу от одного и того же дня: вторая кормёжка была бы уже
    // перекормом, и он перекрыл бы собой всё остальное.
    const day = hatched(YELLOW);
    expect(moodOf(feed(setDials(day, { ...comfy(YELLOW), temp: 0 })))).toBe('cold');
    expect(moodOf(feed(setDials(day, { ...comfy(YELLOW), humidity: SCALE })))).toBe('wet');
    // Холод виден раньше сырости: говорить сразу обо всём — значит не
    // сказать ничего.
    expect(moodOf(feed(setDials(day, { temp: 0, humidity: SCALE, medium: 0 })))).toBe('cold');
  });
});

describe('тела', () => {
  it('у всех двадцати семи форм одна оснастка: крепление снизу, голова сверху', () => {
    // Цикл движения принадлежит поведению, а не телу: любой корпус обязан
    // подставляться в чужой цикл без переделки — иначе мутация поведения
    // потребует перерисовать всё.
    for (const species of speciesOfColor('yellow')) {
      const shape = bodyOfSpecies(species);
      expect(shape.anchor).toEqual({ x: 50, y: 96 });
      expect(shape.head.y).toBeLessThan(shape.anchor.y - 20);
      expect(shape.parts.filter((part) => part.kind === 'eye')).toHaveLength(2);
      expect(shape.height).toBeGreaterThan(20);
    }
  });

  it('каждая ось видна в теле', () => {
    const bare = bodyOfSpecies({ color: 'yellow', axes: { temp: 1, humidity: 1, medium: 0 } });
    const one = bodyOfSpecies({ color: 'yellow', axes: { temp: 1, humidity: 1, medium: 1 } });
    const many = bodyOfSpecies({ color: 'yellow', axes: { temp: 1, humidity: 1, medium: 2 } });
    const stalks = (shape: { parts: { kind: string }[] }): number =>
      shape.parts.filter((part) => part.kind === 'stalk').length;
    // Питательная среда — отростки: голое тело, один вырост, ветвление.
    expect(stalks(bare)).toBe(0);
    expect(stalks(one)).toBe(1);
    expect(stalks(many)).toBeGreaterThanOrEqual(6);

    // Температура — контур: сколы бывают только на «остром» краю шкалы.
    const sharp = bodyOfSpecies({ color: 'yellow', axes: { temp: 0, humidity: 1, medium: 0 } });
    const smooth = bodyOfSpecies({ color: 'yellow', axes: { temp: 1, humidity: 1, medium: 0 } });
    expect(sharp.parts.some((part) => part.kind === 'tri')).toBe(true);
    expect(smooth.parts.some((part) => part.kind === 'tri')).toBe(false);

    // Влажность — силуэт: тонкий, каплевидный, раздутый.
    const thin = bodyOfSpecies({ color: 'yellow', axes: { temp: 1, humidity: 0, medium: 0 } });
    const fat = bodyOfSpecies({ color: 'yellow', axes: { temp: 1, humidity: 2, medium: 0 } });
    expect(thin.width).toBeLessThan(fat.width);
    expect(thin.height).toBeGreaterThan(fat.height);
  });

  it('взрослая форма крупнее и со вторым цветом', () => {
    const young = bodyOfSpecies(YELLOW);
    const grown = bodyOfSpecies(YELLOW, true);
    expect(grown.width).toBeGreaterThan(young.width * 1.3);
    expect(grown.parts.some((part) => part.kind !== 'eye' && part.role === 'accent')).toBe(true);
    expect(young.parts.some((part) => part.kind !== 'eye' && part.role === 'accent')).toBe(false);
    // Крепление не уезжает: тело растёт вверх от стекла, а не сквозь него.
    expect(grown.anchor).toEqual(young.anchor);
  });
});

describe('лабораторные сутки', () => {
  it('день считается по поясу лаборатории, а не по часам телефона', () => {
    // Полночь в Москве — три часа ночи по Гринвичу минус пояс: в 21:30 UTC
    // в лаборатории уже завтра.
    expect(labDay(new Date('2026-03-15T20:30:00Z'))).toBe('2026-03-15');
    expect(labDay(new Date('2026-03-15T21:30:00Z'))).toBe('2026-03-16');
  });

  it('соседний день считается через границу месяца', () => {
    expect(labDayShift('2026-02-28', 1)).toBe('2026-03-01');
    expect(labDayShift('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('портрет', () => {
  it('целиком помещается в своё поле — и у взрослой формы тоже', () => {
    // В чашке тело обрезает стенка, и это правильно. А портрет обязан
    // показывать существо целиком: у каталога срезало усики, пока поле
    // считалось на глаз.
    for (const species of speciesOfColor('yellow')) {
      for (const grown of [false, true]) {
        const shape = bodyOfSpecies(species, grown);
        const box = boundsOf(shape);
        const [x, y, w, h] = viewBoxOf(shape).split(' ').map(Number) as [number, number, number, number];
        expect(x).toBeLessThanOrEqual(box.x);
        expect(y).toBeLessThanOrEqual(box.y);
        expect(x + w).toBeGreaterThanOrEqual(box.x + box.w);
        expect(y + h).toBeGreaterThanOrEqual(box.y + box.h);
      }
    }
  });
});

/** Взрослое существо, готовое к скрещиванию. */
function adult(id: string, extra: Partial<Creature> = {}): Creature {
  return {
    id,
    generation: 1,
    color: 'yellow',
    colorMutation: null,
    behaviour: 'cling',
    behaviourMutation: null,
    bodyAnomaly: null,
    axes: { temp: 1, humidity: 1, medium: 1 },
    stage: 3,
    parents: null,
    bredAt: null,
    createdAt: '2026-03-15T09:00:00Z',
    ...extra,
  };
}

const pair = (seed: number, a: Creature, b: Creature, extra: Partial<BreedOptions> = {}) =>
  breed(a, b, { seed, misses: 0, promised: false, id: `k${seed}`, at: '2026-03-20T09:00:00Z', ...extra });

describe('скрещивание', () => {
  it('ребёнок рождается точкой: форму ему выберут тумблеры', () => {
    const child = pair(1, adult('a'), adult('b')).child;
    expect(child.stage).toBe(1);
    expect(child.axes).toBeNull();
    expect(child.parents).toEqual(['a', 'b']);
    expect(child.generation).toBe(2);
    expect(child.bredAt).toBeNull();
  });

  it('мутации наследуются всегда', () => {
    const mutant = adult('a', { colorMutation: 'magma' });
    for (let seed = 0; seed < 40; seed++) {
      expect(pair(seed, mutant, adult('b')).child.colorMutation).toBe('magma');
    }
  });

  it('один и тот же слот у обоих — пятьдесят на пятьдесят', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const child = pair(seed, adult('a', { colorMutation: 'magma' }), adult('b', { colorMutation: 'milk' })).child;
      seen.add(String(child.colorMutation));
    }
    expect(seen).toEqual(new Set(['magma', 'milk']));
  });

  it('трёх мутаций не бывает: одна сгорает, и сгорает случайно', () => {
    // Сгорай самая частая, игроки за неделю свели бы всё к одной
    // оптимальной последовательности скрещиваний.
    const burned = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const result = pair(
        seed,
        adult('a', { colorMutation: 'milk', bodyAnomaly: 'third-eye' }),
        adult('b', { behaviourMutation: { to: 'bounce', partial: false } }),
      );
      expect(mutationCount(result.child)).toBe(MAX_MUTATIONS);
      expect(result.burned).not.toBeNull();
      burned.add(String(result.burned));
    }
    expect(burned.size).toBeGreaterThan(1);
  });

  it('чистая пара мутирует примерно раз из десяти', () => {
    let fresh = 0;
    const runs = 2000;
    for (let seed = 0; seed < runs; seed++) {
      if (pair(seed, adult('a'), adult('b')).fresh) fresh++;
    }
    // Три слота по четыре процента — около одиннадцати с половиной.
    expect(fresh / runs).toBeGreaterThan(0.07);
    expect(fresh / runs).toBeLessThan(0.17);
  });

  it('обещанная мутация приходит и первому скрещиванию, и после череды пустых', () => {
    // Скрытый счётчик обрубает хвост распределения: при цикле в трое суток
    // «не повезло полгода» означало бы полгода игры впустую.
    for (let seed = 0; seed < 20; seed++) {
      expect(pair(seed, adult('a'), adult('b'), { promised: true }).fresh).toBe(true);
      expect(pair(seed, adult('a'), adult('b'), { misses: MISS_GUARANTEE - 1 }).fresh).toBe(true);
    }
  });

  it('новая мутация не перебивает наследство', () => {
    // Занятый слот уже занят тем, что растили: перебить его значило бы
    // потерять линию ради случайности.
    for (let seed = 0; seed < 200; seed++) {
      const child = pair(seed, adult('a', { colorMutation: 'magma' }), adult('b'), { promised: true }).child;
      expect(child.colorMutation).toBe('magma');
    }
  });

  it('скрещивание одно на существо', () => {
    expect(breedable(adult('a'), adult('b'))).toBe(true);
    expect(breedable(adult('a', { bredAt: '2026-03-19' }), adult('b'))).toBe(false);
    expect(breedable(adult('a'), adult('b', { stage: 2 }))).toBe(false);
    expect(breedable(adult('a'), null)).toBe(false);
  });

  it('частичная мутация поведения — самая частая ступень', () => {
    let partial = 0;
    let full = 0;
    for (let seed = 0; seed < 400; seed++) {
      const child = pair(seed, adult('a'), adult('b'), { promised: true }).child;
      const mutation = child.behaviourMutation;
      if (mutation === null) continue;
      if (mutation.partial) partial++;
      else full++;
      // Своё поведение чужим не бывает: подменяют на другое.
      expect(mutation.to).not.toBe(child.behaviour);
    }
    expect(partial).toBeGreaterThan(full);
    // Полная подмена всё-таки случается — иначе лестницы бы не было.
    expect(full).toBeGreaterThan(0);
  });
});

describe('посев', () => {
  it('первая точка бесплатна, следующие стоят своё', () => {
    expect(seedCost(0)).toBe(0);
    expect(seedCost(1)).toBe(SEED_PRICE);
    expect(seedCost(9)).toBe(SEED_PRICE);
  });
});

describe('аномалии тела', () => {
  const withAnomaly = (anomaly: Creature['bodyAnomaly'], stage: 1 | 2 = 2): Creature =>
    adult('m', { bodyAnomaly: anomaly, stage, axes: stage === 1 ? null : { temp: 1, humidity: 1, medium: 1 } });
  const eyes = (creature: Creature): number =>
    bodyOf(creature).parts.filter((part) => part.kind === 'eye').length;

  it('видны на теле, а не только в базе', () => {
    // Мутация, которой не видно, — это запись в базе, а не мутация. Первое
    // же обещанное скрещивание выдаёт её новому игроку, и он обязан её
    // увидеть.
    expect(eyes(withAnomaly(null))).toBe(2);
    expect(eyes(withAnomaly('one-eye'))).toBe(1);
    expect(eyes(withAnomaly('third-eye'))).toBe(3);
    expect(eyes(withAnomaly('stalk-eyes'))).toBe(2);
    // Глаза на стебельках — это ещё и стебельки: без них они просто уехали.
    const stalks = (creature: Creature): number =>
      bodyOf(creature).parts.filter((part) => part.kind === 'stalk').length;
    expect(stalks(withAnomaly('stalk-eyes'))).toBeGreaterThan(stalks(withAnomaly(null)));
  });

  it('видны уже у точки: они достаются по родству, а не растут', () => {
    expect(eyes(withAnomaly('third-eye', 1))).toBe(3);
    expect(eyes(withAnomaly(null, 1))).toBe(2);
  });

  it('кривые отростки растут вкривь', () => {
    const straight = bodyOf(withAnomaly(null));
    const crooked = bodyOf(withAnomaly('crooked'));
    const angles = (shape: { parts: { kind: string }[] }): string =>
      JSON.stringify(shape.parts.filter((part) => part.kind === 'stalk'));
    expect(angles(crooked)).not.toBe(angles(straight));
  });
});
