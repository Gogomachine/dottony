import { describe, expect, it } from 'vitest';
import {
  DIALS,
  SCALE,
  advance,
  axesOf,
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
  labDay,
  labDayShift,
  moodOf,
  resetDials,
  setDials,
  speciesId,
  speciesOfColor,
  zoneOf,
  GROW_DAYS,
  NEGLECT_DEATH,
  type Creature,
  type Dials,
  type Incubator,
  type Species,
} from './index.js';

/** Существо в инкубаторе, каким его заводит посев. */
function seeded(species: Species, day = '2026-03-15'): Incubator {
  const creature: Creature = {
    id: 'c1',
    generation: 1,
    color: species.color,
    colorMutation: null,
    behaviour: 'cling',
    behaviourMutation: null,
    bodyAnomaly: null,
    axes: species.axes,
    stage: 1,
    parents: null,
    bredAt: null,
    createdAt: `${day}T09:00:00Z`,
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

/** Тумблеры ровно в комфорт этого вида — так ухаживает знающий игрок. */
function comfy(species: Species): Dials {
  const comfort = comfortOf(species);
  return { temp: comfort.temp.at, humidity: comfort.humidity.at, medium: comfort.medium.at };
}

/** Один день ухода: выставил среду, покормил — и сутки кончились. */
function tended(inc: Incubator, species: Species): Incubator {
  return advance(feed(setDials(inc, comfy(species))), labDayShift(inc.day, 1)).inc;
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

  it('подсказка называет сторону, но не число', () => {
    const comfort = comfortOf(YELLOW);
    expect(hintFor(YELLOW, 'temp', comfort.temp.at)).toBe(0);
    expect(hintFor(YELLOW, 'temp', comfort.temp.at - comfort.temp.span - 1)).toBe(1);
    expect(hintFor(YELLOW, 'temp', comfort.temp.at + comfort.temp.span + 1)).toBe(-1);
  });

  it('среда хороша, только когда хороши все три тумблера', () => {
    const comfort = comfortOf(YELLOW);
    expect(envFits(YELLOW, comfy(YELLOW))).toBe(true);
    for (const dial of DIALS) {
      const off = { ...comfy(YELLOW), [dial]: comfort[dial].at + comfort[dial].span + 1 };
      expect(envFits(YELLOW, off as Dials)).toBe(false);
    }
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
  it('точка вылупляется за сутки, и тумблеры ей не указ', () => {
    // Тумблеры своё дело уже сделали: они выбрали форму, а не условия.
    const inc = seeded(YELLOW);
    expect(dayVerdict(inc)).toBe('point');
    const after = advance(inc, labDayShift(inc.day, 1)).inc;
    expect(after.creature?.stage).toBe(2);
    expect(after.lostAt).toBeNull();
  });

  it('взрослая форма приходит за хорошие сутки, а не за календарные', () => {
    let inc = advance(seeded(YELLOW), '2026-03-16').inc;
    expect(inc.creature?.stage).toBe(2);
    for (let i = 0; i < GROW_DAYS; i++) inc = tended(inc, YELLOW);
    expect(inc.creature?.stage).toBe(3);
  });

  it('небрежные сутки в зачёт роста не идут', () => {
    let inc = advance(seeded(YELLOW), '2026-03-16').inc;
    // Кормили, но среду не выставили — сутки потрачены зря.
    inc = advance(feed(inc), labDayShift(inc.day, 1)).inc;
    expect(inc.creature?.stage).toBe(2);
    expect(inc.goodDays).toBe(0);
    expect(inc.neglect).toBe(1);
  });

  it('перекорм так же плох, как голод', () => {
    let inc = advance(seeded(YELLOW), '2026-03-16').inc;
    inc = setDials(inc, comfy(YELLOW));
    expect(dayVerdict(feed(inc))).toBe('good');
    expect(dayVerdict(feed(feed(inc)))).toBe('stuffed');
    expect(dayVerdict(inc)).toBe('hungry');
    expect(moodOf(feed(feed(inc)))).toBe('stuffed');
    expect(moodOf(feed(inc))).toBe('fine');
  });

  it('гибель наступает на третьи сутки небрежения, а не на первые', () => {
    // Тумблеры сбрасываются сами: смерть за один пропущенный день значила бы
    // потерю недели выращивания по причинам, не относящимся к игре.
    const start = advance(seeded(YELLOW), '2026-03-16').inc;
    const day = start.day;
    for (let skipped = 1; skipped < NEGLECT_DEATH; skipped++) {
      const gone = advance(start, labDayShift(day, skipped)).inc;
      expect(gone.lostAt).toBeNull();
    }
    const dead = advance(start, labDayShift(day, NEGLECT_DEATH));
    expect(dead.inc.lostAt).not.toBeNull();
    expect(dead.log.some((entry) => entry.lost)).toBe(true);
    // Досчитали до сегодня, даже оборвавшись на гибели.
    expect(dead.inc.day).toBe(labDayShift(day, NEGLECT_DEATH));
  });

  it('хорошие сутки отводят от гибели', () => {
    let inc = advance(seeded(YELLOW), '2026-03-16').inc;
    inc = advance(inc, labDayShift(inc.day, 1)).inc;
    expect(inc.neglect).toBe(1);
    inc = tended(inc, YELLOW);
    expect(inc.neglect).toBe(0);
  });

  it('первый питомец не погибает: на нём учатся', () => {
    const start = { ...advance(seeded(YELLOW), '2026-03-16').inc, immortal: true };
    const long = advance(start, labDayShift(start.day, 30)).inc;
    expect(long.lostAt).toBeNull();
    expect(long.creature?.stage).toBe(2);
  });

  it('прибор не живёт назад и не считает те же сутки дважды', () => {
    const inc = advance(seeded(YELLOW), '2026-03-16').inc;
    expect(advance(inc, '2026-03-15').inc).toEqual(inc);
    expect(advance(inc, inc.day).log).toHaveLength(0);
  });

  it('новые сутки сбрасывают и тумблеры, и кормёжку', () => {
    let inc = advance(seeded(YELLOW), '2026-03-16').inc;
    inc = feed(setDials(inc, comfy(YELLOW)));
    expect(inc.dials).not.toBeNull();
    inc = advance(inc, labDayShift(inc.day, 1)).inc;
    expect(inc.dials).toBeNull();
    expect(inc.feeds).toBe(0);
  });

  it('взрослая форма законсервирована: сутки ей ничего не делают', () => {
    let inc = advance(seeded(YELLOW), '2026-03-16').inc;
    for (let i = 0; i < GROW_DAYS; i++) inc = tended(inc, YELLOW);
    expect(inc.creature?.stage).toBe(3);
    const later = advance(inc, labDayShift(inc.day, 20)).inc;
    expect(later.lostAt).toBeNull();
    expect(later.creature?.stage).toBe(3);
  });

  it('состояние называет то, что хуже всего, — по одному признаку за раз', () => {
    // Кормим по разу от одного и того же дня: вторая кормёжка была бы уже
    // перекормом, и он перекрыл бы собой всё остальное.
    const day = advance(seeded(YELLOW), '2026-03-16').inc;
    expect(moodOf(feed(setDials(day, { ...comfy(YELLOW), temp: 0 })))).toBe('cold');
    expect(moodOf(feed(setDials(day, { ...comfy(YELLOW), humidity: SCALE })))).toBe('wet');
    // Холод виден раньше состава среды: говорить сразу обо всём — значит не
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
