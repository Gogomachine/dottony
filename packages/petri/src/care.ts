import { TOURNEY_TZ_HOURS } from '@doton/core';
import { DIALS, cleanDials, resetDials, type Dial, type Dials } from './dials.js';
import { comfortOf, dialFits, envFits } from './species.js';
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
 * Сколько хороших суток на второй стадии до взрослой формы.
 *
 * Три дня от точки до взрослого: сутки на вылупление и двое на рост. Это
 * рычаг темпа, и он тут не случайно самый доступный: при одном инкубаторе
 * одно скрещивание — это два выращивания подряд, и каждый лишний день
 * цикла отодвигает первую самостоятельную мутацию на недели.
 *
 * Считаются **хорошие** сутки, а не календарные: небрежный день не
 * засчитывается вовсе. Иначе «нормальный уход» из условия роста
 * превращается в украшение — расти можно и мимоходом.
 */
export const GROW_DAYS = 2;

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
  /** Что выставил игрок сегодня. `null` — не трогал, тумблеры как сбросило. */
  dials: Dials | null;
  /** День, до которого прибор уже досчитан. */
  day: string;
  /** Сколько раз кормили сегодня. Ноль — голод, два и больше — перекорм. */
  feeds: number;
  /** Суток небрежения подряд. */
  neglect: number;
  /** Хороших суток на второй стадии. */
  goodDays: number;
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
export type Mood = 'fine' | 'cold' | 'hot' | 'dry' | 'wet' | 'thin' | 'rich' | 'hungry' | 'stuffed';

/** Положения тумблеров: выставленные игроком или те, что дал сброс. */
export function dialsOf(inc: Incubator): Dials {
  return inc.dials ?? resetDials(inc.seed, inc.day);
}

/** Живо ли существо и есть ли за кем ухаживать. */
export function alive(inc: Incubator): boolean {
  return inc.creature !== null && inc.lostAt === null;
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
  if (inc.feeds >= 2) return 'stuffed';
  if (inc.feeds === 0) return 'hungry';
  return envFits(speciesOf(creature), dialsOf(inc)) ? 'good' : 'wrong-env';
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
  if (inc.feeds >= 2) return 'stuffed';
  if (inc.feeds === 0) return 'hungry';
  const comfort = comfortOf(speciesOf(creature));
  const dials = dialsOf(inc);
  // Порядок опроса — он же порядок важности: холод виден раньше, чем состав
  // среды, и говорить сразу обо всём значит не сказать ничего.
  const said: Record<Dial, [Mood, Mood]> = {
    temp: ['cold', 'hot'],
    humidity: ['dry', 'wet'],
    medium: ['thin', 'rich'],
  };
  for (const dial of DIALS) {
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
export function advance(inc: Incubator, today: string): { inc: Incubator; log: DayLog[] } {
  const log: DayLog[] = [];
  let state: Incubator = { ...inc };
  // Часы могли уйти назад (перевод времени, чужая машина) — тогда считать
  // нечего: назад прибор не живёт.
  let passed = labDaysBetween(state.day, today);
  if (passed <= 0) return { inc: state, log };
  // Потолок на случай очень давнего возвращения: гибель наступает на третьи
  // сутки, и дальше считать нечего, но цикл обязан кончаться и без неё.
  passed = Math.min(passed, 400);

  for (let i = 0; i < passed; i++) {
    const day = state.day;
    const verdict = dayVerdict(state);
    let grew: Stage | null = null;
    let lost = false;
    const creature = state.creature;

    if (creature !== null && state.lostAt === null) {
      if (verdict === 'point') {
        // Точка живёт ровно сутки: тумблеры своё дело уже сделали — они
        // выбрали форму, а не условия.
        state = { ...state, creature: { ...creature, stage: 2 }, goodDays: 0 };
        grew = 2;
      } else if (verdict === 'good') {
        const goodDays = state.goodDays + 1;
        state = { ...state, goodDays, neglect: Math.max(0, state.neglect - 1) };
        if (goodDays >= GROW_DAYS) {
          state = { ...state, creature: { ...creature, stage: 3 } };
          grew = 3;
        }
      } else if (verdict !== 'stable') {
        const neglect = state.neglect + 1;
        state = { ...state, neglect };
        if (neglect >= NEGLECT_DEATH && !state.immortal) {
          state = { ...state, lostAt: day };
          lost = true;
        }
      }
    }

    // Новые сутки: тумблеры сбрасываются сами, кормёжка обнуляется. Это и
    // есть та ежедневная рутина, ради которой прибор открывают.
    state = { ...state, day: labDayShift(day, 1), dials: null, feeds: 0 };
    log.push({ day, verdict, grew, lost });
    if (lost) break;
  }

  // Если оборвались на гибели, до сегодня всё равно надо дойти: мёртвому
  // стеклу сутки ничего не делают.
  state = { ...state, day: today };
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
