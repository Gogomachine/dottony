import { nextInt, seedRng, type RngState } from '@doton/core';
import { seedOf } from './dials.js';
import {
  BODY_ANOMALIES,
  COLOR_MUTATIONS,
  mutationCount,
  type BehaviourMutation,
  type BodyAnomaly,
  type ColorMutation,
  type Creature,
} from './creature.js';
import { BEHAVIOUR_LADDER, COLORS, type Behaviour, type Color } from './species.js';

/**
 * Лаборатория: три стекла, посев и скрещивание.
 *
 * Активно одновременно **одно** стекло — инкубатор, в нём идёт рост. Два
 * других — слоты хранения: существо третьей стадии в них законсервировано,
 * ухода не требует и погибнуть не может.
 *
 * Отсюда весь ритм игры. Два слота — это ровно одна пара для скрещивания:
 * копить взрослых нельзя, и когда оба заняты, а в инкубаторе кто-то дорос,
 * игрок обязан решить — скрестить или отправить в коллекцию. Дефицит места
 * создаёт решения без таймеров и напоминаний.
 */

/**
 * Цена точки в жетонах DOTOSCOPE. Первая — бесплатно.
 *
 * Дорого нарочно: точку не покупают, точку **выводят**. Обычный путь новой
 * жизни — скрещивание, оно даёт точку само и ничего не стоит; покупка нужна
 * тому, у кого линия оборвалась, и она обязана быть дороже, чем «купить
 * ещё одну, раз эта не нравится». Два прибора одной компании и один
 * кошелёк: две тысячи — это заметный кусок игры в точки, и потерять
 * культуру после этого по-настоящему обидно.
 */
export const SEED_PRICE = 2000;

/** Сколько стоит очередная точка: первая в жизни лаборатории — даром. */
export function seedCost(seeded: number): number {
  return seeded <= 0 ? 0 : SEED_PRICE;
}

/**
 * Какого цвета выпала точка при посеве.
 *
 * Все четыре равновероятны: цвет — это не редкость, а характер. Редкость
 * живёт в форме (узкие зоны шкал) и в мутациях; делать вдобавок редкими
 * сами цвета значило бы, что четверть игры почти никто не увидит, а
 * поведений у нас ровно четыре и показать надо все.
 */
export function seedColor(seed: number): Color {
  const roll = nextInt(seedRng(seed >>> 0), COLORS.length);
  return COLORS[roll.value] ?? 'yellow';
}

/** Шанс новой мутации на каждый свободный слот при скрещивании двух чистых. */
export const MUTATION_CHANCE = 0.04;

/**
 * Скрытый счётчик неудач: на этом по счёту безрезультатном скрещивании
 * мутация выпадает гарантированно.
 *
 * Игроку он не показывается и сбрасывается при срабатывании. Средняя
 * редкость от него почти не меняется, но хвост распределения обрубается —
 * и никто не сидит месяцами с пустыми руками, что при цикле в трое суток
 * означало бы полгода игры впустую.
 */
export const MISS_GUARANTEE = 6;

/** Больше двух занятых слотов на существо не бывает: третий перемножил бы редкость. */
export const MAX_MUTATIONS = 2;

/**
 * Редкость мутационных окрасов, в долях. «Молоко» — самый частый из
 * редких, «магма» — вершина лестницы.
 */
const COLOR_WEIGHTS: Readonly<Record<ColorMutation, number>> = {
  milk: 40,
  patina: 27,
  ultraviolet: 18,
  glass: 10,
  magma: 5,
};

/** Бросок из взвешенного списка. */
function pick<T extends string>(state: RngState, weights: Readonly<Record<T, number>>): { value: T; state: RngState } {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  const roll = nextInt(state, total);
  let seen = 0;
  for (const [value, weight] of entries) {
    seen += weight;
    if (roll.value < seen) return { value, state: roll.state };
  }
  return { value: entries[entries.length - 1]![0], state: roll.state };
}

/** Бросок с долей: `true` примерно в `chance` случаях. */
function chance(state: RngState, odds: number): { value: boolean; state: RngState } {
  const roll = nextInt(state, 10_000);
  return { value: roll.value < Math.round(odds * 10_000), state: roll.state };
}

/**
 * Какая мутация поведения выпала.
 *
 * Лестница по количеству движения: прилип → по краю → по стеклу → прыгает.
 * Мутация на соседнюю ступень частая, через одну — реже, на
 * противоположный конец — самая редкая, и прыгающий стебель оказывается на
 * вершине сам, без ручной таблицы. Ниже всех — частичная: своё поведение
 * остаётся, чужое приходит на несколько минут в сутки.
 */
function rollBehaviour(state: RngState, own: Behaviour): { value: BehaviourMutation; state: RngState } {
  const here = BEHAVIOUR_LADDER.indexOf(own);
  const weights: { to: Behaviour; partial: boolean; weight: number }[] = [];
  for (const to of BEHAVIOUR_LADDER) {
    if (to === own) continue;
    const distance = Math.abs(BEHAVIOUR_LADDER.indexOf(to) - here);
    weights.push({ to, partial: true, weight: [0, 34, 20, 8][distance] ?? 8 });
    weights.push({ to, partial: false, weight: [0, 22, 11, 5][distance] ?? 5 });
  }
  const total = weights.reduce((sum, option) => sum + option.weight, 0);
  const roll = nextInt(state, total);
  let seen = 0;
  for (const option of weights) {
    seen += option.weight;
    if (roll.value < seen) return { value: { to: option.to, partial: option.partial }, state: roll.state };
  }
  const last = weights[weights.length - 1]!;
  return { value: { to: last.to, partial: last.partial }, state: roll.state };
}

/** Три слота мутации — каждый бросается отдельно. */
export type Slot = 'color' | 'behaviour' | 'anomaly';

const SLOTS: readonly Slot[] = ['color', 'behaviour', 'anomaly'];

interface Mutations {
  color: ColorMutation | null;
  behaviour: BehaviourMutation | null;
  anomaly: BodyAnomaly | null;
}

function mutationsOf(creature: Creature): Mutations {
  return {
    color: creature.colorMutation,
    behaviour: creature.behaviourMutation,
    anomaly: creature.bodyAnomaly,
  };
}

function taken(mutations: Mutations): Slot[] {
  return SLOTS.filter((slot) => mutations[slot] !== null);
}

export interface BreedOptions {
  /** Сид: результат считает сервер, и он обязан считаться одинаково. */
  seed: number;
  /** Сколько скрещиваний подряд не дали мутации — скрытый счётчик. */
  misses: number;
  /** Первое скрещивание игрока: ему мутация обещана. */
  promised: boolean;
  id: string;
  at: string;
}

export interface BreedResult {
  child: Creature;
  /** Появилась ли **новая** мутация — по ней и ведётся счётчик неудач. */
  fresh: boolean;
  /** Слот, который сгорел, когда мутаций набралось три. */
  burned: Slot | null;
}

/**
 * Скрестить двух взрослых.
 *
 * Наследуется всё: мутации родителей переходят ребёнку всегда. Разные слоты
 * складываются, один и тот же — пятьдесят на пятьдесят, а если суммарно
 * выходит три, одна сгорает **случайно**. Именно случайно: сгорай самая
 * частая, игроки за неделю свели бы всё к одной оптимальной
 * последовательности скрещиваний.
 *
 * Формы у ребёнка нет: он рождается точкой, и какая из 27 форм вылупится,
 * решат тумблеры — как и у всякой точки. Скрещивание передаёт родство и
 * мутации, а не тело.
 *
 * Мутант тратит своё единственное скрещивание и оставляет ровно одного
 * наследника: число мутантов в мире не растёт, и каждое поколение линии
 * требует чистого расходника, выращенного полностью.
 */
export function breed(a: Creature, b: Creature, options: BreedOptions): BreedResult {
  let state = seedRng(seedOf(`${a.id}:${b.id}:${options.id}`, options.seed));

  const mine = mutationsOf(a);
  const theirs = mutationsOf(b);
  const child: Mutations = { color: null, behaviour: null, anomaly: null };

  for (const slot of SLOTS) {
    const first = mine[slot];
    const second = theirs[slot];
    if (first !== null && second !== null) {
      // Один и тот же слот у обоих — пятьдесят на пятьдесят.
      const coin = nextInt(state, 2);
      state = coin.state;
      child[slot] = (coin.value === 0 ? first : second) as never;
    } else if (first !== null || second !== null) {
      child[slot] = (first ?? second) as never;
    }
  }

  /*
   * Новые мутации бросаются только в свободные слоты, и только пока их
   * меньше двух.
   *
   * Занятый слот уже занят наследством, и перебивать его значило бы терять
   * то, что растили. А потолок в два слота проверяется **до** броска, а не
   * после: иначе свежая мутация выбивала бы наследственную сгоранием — и
   * подарок оборачивался бы потерей линии.
   */
  let fresh = false;
  const free = SLOTS.filter((slot) => child[slot] === null);
  for (const slot of free) {
    if (taken(child).length >= MAX_MUTATIONS) break;
    const roll = chance(state, MUTATION_CHANCE);
    state = roll.state;
    if (!roll.value) continue;
    const put = rollSlot(state, slot, a);
    state = put.state;
    child[slot] = put.value as never;
    fresh = true;
  }

  // Обещанная мутация: первое скрещивание игрока и скрытый счётчик неудач.
  // Оба обещают одно и то же — что рано или поздно человек увидит, ради
  // чего всё это.
  const owed = options.promised || options.misses + 1 >= MISS_GUARANTEE;
  if (!fresh && owed && taken(child).length < MAX_MUTATIONS) {
    const empty = SLOTS.filter((slot) => child[slot] === null);
    if (empty.length > 0) {
      const which = nextInt(state, empty.length);
      state = which.state;
      const slot = empty[which.value]!;
      const put = rollSlot(state, slot, a);
      state = put.state;
      child[slot] = put.value as never;
      fresh = true;
    }
  }

  // Три мутации — одна сгорает. Случайно, а не по редкости. Сюда попадают
  // только наследственные: родитель с двумя слотами и родитель с третьим.
  let burned: Slot | null = null;
  const occupied = taken(child);
  if (occupied.length > MAX_MUTATIONS) {
    const which = nextInt(state, occupied.length);
    state = which.state;
    burned = occupied[which.value]!;
    child[burned] = null as never;
  }

  // Цвет — от одного из родителей: окрас и поведение живут в разных слотах,
  // и базовый цвет тут ни при чём.
  const coin = nextInt(state, 2);
  state = coin.state;
  const parent = coin.value === 0 ? a : b;

  return {
    child: {
      id: options.id,
      generation: Math.max(a.generation, b.generation) + 1,
      color: parent.color,
      colorMutation: child.color,
      behaviour: parent.behaviour,
      behaviourMutation: child.behaviour,
      bodyAnomaly: child.anomaly,
      axes: null,
      stage: 1,
      parents: [a.id, b.id],
      bredAt: null,
      createdAt: options.at,
    },
    fresh,
    burned,
  };
}

function rollSlot(
  state: RngState,
  slot: Slot,
  parent: Creature,
): { value: ColorMutation | BehaviourMutation | BodyAnomaly; state: RngState } {
  if (slot === 'color') return pick(state, COLOR_WEIGHTS);
  if (slot === 'behaviour') return rollBehaviour(state, parent.behaviour);
  const roll = nextInt(state, BODY_ANOMALIES.length);
  return { value: BODY_ANOMALIES[roll.value]!, state: roll.state };
}

/** Готово ли существо к тому, чтобы его переложили или скрестили. */
export function grown(creature: Creature | null): boolean {
  return creature !== null && creature.stage === 3;
}

/** Можно ли скрестить эту пару. */
export function breedable(a: Creature | null, b: Creature | null): boolean {
  if (!grown(a) || !grown(b)) return false;
  // Скрещивание одно на существо: занято — линия уже продолжена.
  if (a!.bredAt !== null || b!.bredAt !== null) return false;
  return a!.id !== b!.id;
}

/** Сколько занятых слотов у существа — короткая мера его редкости. */
export { mutationCount };
