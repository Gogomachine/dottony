import { TOURNEY_TZ_HOURS } from '@doton/core';
import { cleanDials, resetDials, type Dials } from './dials.js';
import { CARE_DIALS, axesOf, comfortOf, dialFits, envFits, type CareDial } from './species.js';
import { speciesOf, type Creature, type Stage } from './creature.js';

/**
 * Лабораторные сутки: уход, рост и гибель.
 *
 * Всё время здесь считает сервер. Иначе перевод часов на телефоне ломает
 * суточный цикл — и ломает бесплатно: сдвинул дату вперёд, собрал неделю
 * роста за минуту.
 */

/**
 * Пояс лаборатории — тот же, что у турнира и смены в DOTOSCOPE.
 *
 * Два прибора одной компании обязаны считать сутки одинаково: игрок ходит
 * между ними в один вечер, и «новый день» у них должен наступать в один миг.
 * Иначе получается, что в приборе уже завтра, а в лаборатории ещё сегодня.
 */
export const LAB_TZ_HOURS = TOURNEY_TZ_HOURS;

/** Смещённое на пояс лаборатории время — по нему считается день. */
function local(now: Date): Date {
  return new Date(now.getTime() + LAB_TZ_HOURS * 3600_000);
}

/** Лабораторный день — `ГГГГ-ММ-ДД`. Он же ключ суточного сброса. */
export function labDay(now: Date = new Date()): string {
  return local(now).toISOString().slice(0, 10);
}

/** Час по поясу лаборатории: 0–23. */
export function labHour(now: Date = new Date()): number {
  return local(now).getUTCHours();
}

/**
 * Когда прибор напоминает о сбросе.
 *
 * Не в полночь, хотя сброс происходит именно там: разбудить человека в тот
 * час, когда он всё равно ничего не сделает, — не напоминание, а помеха.
 * Утро того же дня — первый час, когда напоминание можно выполнить.
 *
 * До вечера — потолок, а не второе окно: хостинг спит, и напоминание может
 * выйти сильно позже своего часа. Пришедшее в полночь «сегодня надо зайти»
 * было бы уже неправдой, поэтому после этого часа прибор молчит до утра.
 */
export const TELL_HOUR = 9;
export const TELL_UNTIL = 22;

/** Когда эти лабораторные сутки кончатся — по настоящим часам. */
export function labDayEnd(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000 - LAB_TZ_HOURS * 3600_000);
}

/** Соседний день: `+1` — завтрашний, `-1` — вчерашний. */
export function labDayShift(day: string, days: number): string {
  const shifted = new Date(`${day}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Сколько суток прошло от одного дня до другого. */
export function labDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Сколько часов точка лежит точкой.
 *
 * Полсуток, а не сутки: первая стадия — это не уход, а рецепт. Игрок
 * выставил три тумблера и ждёт, что из них выйдет; растягивать ожидание
 * первого своего существа на целые сутки значило бы взять с новичка день
 * ни за что. Двенадцать часов дают то самое «поставил вечером — утром
 * посмотрел», ради которого прибор и открывают.
 *
 * Часы тут настоящие, а не лабораторные сутки: полсуток не ложатся на
 * границу дня никак.
 */
export const HATCH_HOURS = 12;

/**
 * Сколько часов идёт вторая стадия.
 *
 * Полтора дня от точки до взрослого: полсуток на вылупление и сутки на
 * рост. Часы, а не календарные сутки, — по той же причине, что и у
 * вылупления: «поставил вечером — утром посмотрел» работает только тогда,
 * когда прибор считает от мига, а не от полуночи.
 *
 * Сутки эти настоящие, но не даровые, и держат их два правила:
 *
 * 1. Небрежные сутки отодвигают срок ещё на столько же (`advance`). Иначе
 *    время шло бы само, а голод и чужая среда не стоили бы ничего: до
 *    гибели за одни сутки роста дело не доходит.
 * 2. Взрослеет существо не по будильнику, а в первый час после срока,
 *    когда оно сыто и стоит в своих условиях (`growing`). Иначе срок,
 *    выпавший на ночь после сброса тумблеров, проходил бы вообще без
 *    всякого ухода.
 */
export const GROW_HOURS = 24;

/**
 * Сколько суток небрежения до гибели.
 *
 * Смерть за один пропущенный день недопустима: тумблеры сбрасываются сами,
 * и игрок терял бы неделю выращивания по причинам, не относящимся к игре.
 * Трое суток — это два вечера, когда «не дошли руки», и один, когда уже
 * видно, что плохо: потеря должна быть заслуженной, а не календарной.
 */
export const NEGLECT_DEATH = 3;

/** Инкубатор: единственное активное стекло прибора. */
export interface Incubator {
  /**
   * Сид инкубатора. По нему считается суточный сброс тумблеров — и потому
   * он не меняется никогда: сброс за прошлые сутки должен пересчитываться
   * так же, как считался тогда.
   */
  seed: number;
  /** Кто растёт. Пусто — стекло чистое, нужен посев. */
  creature: Creature | null;
  /**
   * Что выставил игрок. У точки это **рецепт**: из него выйдет форма, и
   * суточный сброс его не трогает — иначе прибор перемешивал бы замес,
   * который человек уже сделал. У вылупившегося это уход, и сбрасывается
   * он каждые сутки.
   */
  dials: Dials | null;
  /** День, до которого прибор уже досчитан. */
  day: string;
  /** Сколько раз кормили сегодня. Ноль — голод, два и больше — перекорм. */
  feeds: number;
  /** Суток небрежения подряд. */
  neglect: number;
  /**
   * Когда существо готово повзрослеть — миг по настоящим часам.
   *
   * Ставится при вылуплении и отодвигается за каждые небрежные сутки.
   * Хранится срок, а не остаток: между двумя взглядами на прибор может
   * пройти неделя, и срок за неё надо пересчитать задним числом — ровно
   * так же, как пересчитываются пропущенные сутки.
   */
  growAt: string | null;
  /**
   * Первый питомец бессмертен: он туториальный. На нём учатся читать
   * поведение, и учиться этому ценой недели выращивания — плохая сделка.
   */
  immortal: boolean;
  /** Когда погиб. Пока жив — `null`. */
  lostAt: string | null;
}

/** Как прибор оценил прошедшие сутки. */
export type DayVerdict =
  /** Точка: она не ест и не мёрзнет — ей нужны только сутки. */
  | 'point'
  /** Взрослая форма законсервирована: сутки ей ничего не делают. */
  | 'stable'
  | 'good'
  | 'hungry'
  | 'stuffed'
  | 'wrong-env';

/** Что видно на существе прямо сейчас — по одному признаку за раз. */
export type Mood = 'fine' | 'cold' | 'hot' | 'dry' | 'wet' | 'hungry' | 'stuffed';

/** Положения тумблеров: выставленные игроком или те, что дал сброс. */
export function dialsOf(inc: Incubator): Dials {
  return inc.dials ?? resetDials(inc.seed, inc.day);
}

/** Живо ли существо и есть ли за кем ухаживать. */
export function alive(inc: Incubator): boolean {
  return inc.creature !== null && inc.lostAt === null;
}

/** Когда точка вылупится — миг по настоящим часам. Не точка — `null`. */
export function hatchTime(creature: Creature | null): Date | null {
  if (creature === null || creature.stage !== 1) return null;
  const born = Date.parse(creature.createdAt);
  if (Number.isNaN(born)) return null;
  return new Date(born + HATCH_HOURS * 3600_000);
}

/**
 * Всё ли хорошо у существа прямо сейчас: сыто, не перекормлено и стоит в
 * своих условиях.
 *
 * Те же три условия, по которым судятся сутки, — но спрошенные в эту самую
 * минуту. По ним прибор решает, пускать ли во взрослую форму: срок мог
 * выпасть на ночь после сброса тумблеров, и взрослеть в такой час значило
 * бы вырасти без всякого ухода.
 */
export function growing(inc: Incubator): boolean {
  const creature = inc.creature;
  if (creature === null || creature.stage !== 2 || inc.lostAt !== null) return false;
  const species = speciesOf(creature);
  if (species === null) return false;
  if (inc.feeds !== 1) return false;
  return envFits(species, dialsOf(inc));
}

/** Дошёл ли срок взросления к этому мигу. */
export function growDue(inc: Incubator, now: Date): boolean {
  if (inc.growAt === null || inc.creature?.stage !== 2 || inc.lostAt !== null) return false;
  const due = Date.parse(inc.growAt);
  return !Number.isNaN(due) && now.getTime() >= due;
}

/**
 * Повзрослеть, если срок дошёл и уход на этот миг в порядке.
 *
 * Спрашивается не только при досчёте суток, но и после каждого действия:
 * тот, кто покормил просроченное существо, должен увидеть взрослую форму в
 * ответе на свою же кормёжку, а не при следующем взгляде на прибор.
 */
export function ripen(inc: Incubator, now: Date): Incubator {
  const creature = inc.creature;
  if (creature === null || !growDue(inc, now) || !growing(inc)) return inc;
  return { ...inc, creature: { ...creature, stage: 3 }, growAt: null };
}

/**
 * Чем кончились сутки. Проверяется ровно то, что было к их концу: тумблеры
 * стоят до полуночи, и «выставил, а потом сбил» — это сбитые тумблеры.
 */
export function dayVerdict(inc: Incubator): DayVerdict {
  const creature = inc.creature;
  if (creature === null || inc.lostAt !== null) return 'stable';
  if (creature.stage === 1) return 'point';
  if (creature.stage === 3) return 'stable';
  const species = speciesOf(creature);
  // Формы нет — значит, это ещё точка, как бы ни была помечена стадия.
  if (species === null) return 'point';
  if (inc.feeds >= 2) return 'stuffed';
  if (inc.feeds === 0) return 'hungry';
  return envFits(species, dialsOf(inc)) ? 'good' : 'wrong-env';
}

/**
 * Что показать игроку прямо сейчас.
 *
 * Признак один: у существа нет шкал здоровья, и весь разговор идёт
 * поведением. Поэтому и здесь возвращается **одно** состояние — то, что
 * хуже всего, — а не список из трёх жалоб сразу.
 */
export function moodOf(inc: Incubator): Mood {
  const creature = inc.creature;
  if (creature === null || creature.stage !== 2 || inc.lostAt !== null) return 'fine';
  const species = speciesOf(creature);
  if (species === null) return 'fine';
  if (inc.feeds >= 2) return 'stuffed';
  if (inc.feeds === 0) return 'hungry';
  const comfort = comfortOf(species);
  const dials = dialsOf(inc);
  // Порядок опроса — он же порядок важности: холод виден раньше сырости, и
  // говорить сразу обо всём значит не сказать ничего.
  const said: Record<CareDial, [Mood, Mood]> = {
    temp: ['cold', 'hot'],
    humidity: ['dry', 'wet'],
  };
  for (const dial of CARE_DIALS) {
    if (dialFits(comfort[dial], dials[dial])) continue;
    const pair = said[dial];
    return dials[dial] < comfort[dial].at ? pair[0] : pair[1];
  }
  return 'fine';
}

/**
 * Во сколько раз медленнее идёт цикл анимации.
 *
 * Скорость цикла — основной индикатор состояния, и он один несёт всю
 * обратную связь по уходу. Числа тут не украшение: замедление меньше
 * четверти глаз не ловит, и подсказка перестаёт работать.
 */
export function paceOf(inc: Incubator): number {
  const mood = moodOf(inc);
  if (mood === 'fine') return 1;
  if (mood === 'hungry') return 0.65;
  if (mood === 'stuffed') return 0.5;
  return 0.8;
}

/** Что случилось за одни сутки — прибор рассказывает это вернувшемуся. */
export interface DayLog {
  day: string;
  verdict: DayVerdict;
  /** Стадия, на которую перешли в конце этих суток; `null` — осталась та же. */
  grew: Stage | null;
  lost: boolean;
}

/**
 * Досчитать прибор до сегодняшнего дня.
 *
 * Ленивый досчёт, а не тик по таймеру: хостинг засыпает, и таймер на нём —
 * обещание, а не механизм. Зато сид инкубатора и день дают положения
 * тумблеров за любые прошлые сутки (см. `resetDials`), поэтому пропущенные
 * дни считаются задним числом ровно так же, как считались бы вживую.
 */
export function advance(inc: Incubator, now: Date): { inc: Incubator; log: DayLog[] } {
  const log: DayLog[] = [];
  let state: Incubator = { ...inc };
  const today = labDay(now);

  /**
   * Вылупление: форму выбирают тумблеры в этот самый миг.
   *
   * Рецепт израсходован — тумблеры сбрасываются и кормёжка обнуляется:
   * дальше это уже не замес, а уход, и мерки у него другие. Третий тумблер
   * с этого момента и вовсе уходит с корпуса, уступая место кормёжке.
   */
  const hatch = (at: Date): void => {
    const creature = state.creature;
    if (creature === null) return;
    state = {
      ...state,
      creature: { ...creature, stage: 2, axes: axesOf(dialsOf(state)) },
      dials: null,
      feeds: 0,
      // Сутки роста отсчитываются от вылупления, а не от полуночи: прибор
      // обещал срок в часах и обязан его держать.
      growAt: new Date(at.getTime() + GROW_HOURS * 3600_000).toISOString(),
      neglect: 0,
    };
  };

  /** Когда вылупится, если ещё точка и жива. */
  const ripeAt = (): Date | null => (state.lostAt === null ? hatchTime(state.creature) : null);

  /**
   * Повзрослеть, если срок дошёл и уход на этот миг в порядке.
   *
   * Возвращает `true`, если взрослая форма наступила именно сейчас. Отказ
   * ничего не отодвигает: небрежное просто ждёт следующего часа, когда
   * станет сытым и попадёт в свои условия.
   */
  const mature = (at: Date): boolean => {
    const next = ripen(state, at);
    if (next === state) return false;
    state = next;
    return true;
  };

  /** Небрежные сутки отодвигают срок ещё на столько же. */
  const postpone = (): void => {
    if (state.growAt === null) return;
    const due = Date.parse(state.growAt);
    if (Number.isNaN(due)) return;
    state = { ...state, growAt: new Date(due + GROW_HOURS * 3600_000).toISOString() };
  };

  // Часы могли уйти назад (перевод времени, чужая машина) — тогда считать
  // нечего: назад прибор не живёт.
  let passed = labDaysBetween(state.day, today);
  // Потолок на случай очень давнего возвращения: гибель наступает на третьи
  // сутки, и дальше считать нечего, но цикл обязан кончаться и без неё.
  passed = Math.max(0, Math.min(passed, 400));

  for (let i = 0; i < passed; i++) {
    const day = state.day;
    const end = labDayEnd(day);
    // Вылупление внутри этих суток: тогда они не судятся как уход. Точка
    // часть дня была точкой, и спрашивать с неё кормёжку не за что.
    const at = ripeAt();
    const hatched = at !== null && at.getTime() <= end.getTime();
    if (hatched && at !== null) hatch(at);
    // Взросление — до суда над сутками: к полуночи оно либо состоялось (и
    // тогда сутки уже не про уход), либо срок ещё не дошёл.
    const matured = mature(end);
    const verdict = hatched ? 'point' : dayVerdict(state);
    const grew: Stage | null = hatched ? 2 : matured ? 3 : null;
    let lost = false;
    const creature = state.creature;

    if (creature !== null && state.lostAt === null && !hatched) {
      if (verdict === 'good') {
        state = { ...state, neglect: Math.max(0, state.neglect - 1) };
      } else if (verdict !== 'stable' && verdict !== 'point') {
        const neglect = state.neglect + 1;
        state = { ...state, neglect };
        // Небрежные сутки не просто не в зачёт: они стоят суток роста.
        postpone();
        if (neglect >= NEGLECT_DEATH && !state.immortal) {
          state = { ...state, lostAt: day };
          lost = true;
        }
      }
    }

    // Новые сутки: тумблеры сбрасываются сами, кормёжка обнуляется. Это и
    // есть та ежедневная рутина, ради которой прибор открывают. Точке сброс
    // не грозит: её тумблеры — рецепт, а не уход.
    const point = state.creature?.stage === 1;
    state = {
      ...state,
      day: labDayShift(day, 1),
      dials: point ? state.dials : null,
      feeds: point ? state.feeds : 0,
    };
    log.push({ day, verdict, grew, lost });
    if (lost) break;
  }

  // Если оборвались на гибели, до сегодня всё равно надо дойти: мёртвому
  // стеклу сутки ничего не делают.
  state = { ...state, day: today };
  // И наконец — текущие, ещё не кончившиеся сутки: человек должен увидеть
  // и форму, и взрослый рост в тот час, когда они наступили, а не в полночь.
  const at = ripeAt();
  if (at !== null && at.getTime() <= now.getTime()) {
    hatch(at);
    log.push({ day: today, verdict: 'point', grew: 2, lost: false });
  }
  if (mature(now)) {
    log.push({ day: today, verdict: 'stable', grew: 3, lost: false });
  }
  return { inc: state, log };
}

/** Выставить тумблеры. Возвращает прибор с новыми положениями. */
export function setDials(inc: Incubator, dials: Dials): Incubator {
  return { ...inc, dials: cleanDials(dials) };
}

/**
 * Покормить.
 *
 * Границы две, и обе вредны. Первая кормёжка за сутки — норма, вторая уже
 * перекорм: «сколько раз нажал» — единственная мера, которую видно и на
 * приборе, и в базе, и её не приходится объяснять.
 */
export function feed(inc: Incubator): Incubator {
  if (!alive(inc) || inc.creature?.stage !== 2) return inc;
  return { ...inc, feeds: inc.feeds + 1 };
}
