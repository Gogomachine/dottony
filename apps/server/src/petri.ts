import { randomUUID } from 'node:crypto';
import {
  DIALS,
  GROW_DAYS,
  NEGLECT_DEATH,
  advance,
  breed,
  breedable,
  cleanDials,
  dialsOf,
  feed,
  grown,
  hintFor,
  labDay,
  moodOf,
  paceOf,
  seedCost,
  seedOf,
  setDials,
  speciesOf,
  type Creature,
  type Dial,
  type Dials,
  type Hint,
  type DayLog,
  type Incubator,
  type LabView,
} from '@doton/petri';
import type { PetriCreatureRow, PetriWire, Store } from './db.js';

/**
 * Лаборатория на сервере: сборка состояния, досчёт суток и действия.
 *
 * Всё время считает эта сторона. Иначе перевод часов на телефоне ломает
 * суточный цикл бесплатно: сдвинул дату вперёд — собрал неделю роста за
 * минуту. По той же причине здесь и результат скрещивания: клиент его
 * только показывает.
 *
 * Досчёт ленивый — при первом взгляде, а не по таймеру. Хостинг засыпает, и
 * таймер на нём обещание, а не механизм; зато сид лаборатории и день дают
 * положения тумблеров за любые прошлые сутки, поэтому пропущенные дни
 * считаются задним числом ровно так же, как считались бы вживую.
 */

/** Где лежит существо. Инкубатор один, стёкол хранения два. */
export const INC = 'inc';
export const SLOTS = ['slot1', 'slot2'] as const;
export const SHELF = 'shelf';

type Place = string;

/** Из строки базы — в существо. Составные поля лежат текстом. */
function toCreature(wire: PetriWire): Creature {
  return {
    id: wire.id,
    generation: wire.generation,
    color: wire.color as Creature['color'],
    colorMutation: wire.colorMutation as Creature['colorMutation'],
    behaviour: wire.behaviour as Creature['behaviour'],
    behaviourMutation:
      wire.behaviourMutation === null
        ? null
        : (JSON.parse(wire.behaviourMutation) as Creature['behaviourMutation']),
    bodyAnomaly: wire.bodyAnomaly as Creature['bodyAnomaly'],
    axes: wire.axes === null ? null : (JSON.parse(wire.axes) as Creature['axes']),
    stage: wire.stage as Creature['stage'],
    parents: wire.parents,
    bredAt: wire.bredAt,
    createdAt: wire.createdAt,
  };
}

function toWire(creature: Creature): PetriWire {
  return {
    id: creature.id,
    generation: creature.generation,
    color: creature.color,
    colorMutation: creature.colorMutation,
    behaviour: creature.behaviour,
    behaviourMutation:
      creature.behaviourMutation === null ? null : JSON.stringify(creature.behaviourMutation),
    bodyAnomaly: creature.bodyAnomaly,
    axes: creature.axes === null ? null : JSON.stringify(creature.axes),
    stage: creature.stage,
    parents: creature.parents,
    bredAt: creature.bredAt,
    createdAt: creature.createdAt,
  };
}

/** Лаборатория целиком, как она сейчас в базе. */
interface Lab {
  inc: Incubator;
  /** Что случилось, пока не заходили: по строке на досчитанные сутки. */
  news: DayLog[];
  slots: [Creature | null, Creature | null];
  collection: Creature[];
  seeded: number;
  misses: number;
  bred: number;
}

function placed(rows: PetriCreatureRow[], place: Place): PetriCreatureRow | undefined {
  return rows.find((row) => row.place === place);
}

/**
 * Собрать лабораторию и **досчитать её до сегодня**.
 *
 * Это единственная дверь внутрь: каждое действие начинается с неё, потому
 * что действовать в позавчерашней лаборатории нельзя — покормить существо,
 * которое два дня назад погибло, прибор не должен даже пытаться.
 */
export async function openLab(store: Store, userId: string, now = new Date()): Promise<Lab> {
  const today = labDay(now);
  // Сид лаборатории даётся раз и навсегда: по нему считается суточный сброс
  // тумблеров за любые прошлые сутки, и поменять его — значит переписать
  // прошлое.
  const row = await store.petriLab(userId, seedOf(userId, 0x5eed), today);
  const rows = await store.petriCreatures(userId);
  const inside = placed(rows, INC);

  const before: Incubator = {
    seed: row.seed,
    creature: inside === undefined ? null : toCreature(inside.creature),
    dials: row.dials === null ? null : (JSON.parse(row.dials) as Dials),
    day: row.day,
    feeds: row.feeds,
    neglect: row.neglect,
    goodDays: row.goodDays,
    // Первый питомец бессмертен: он туториальный, и учиться читать
    // поведение ценой недели выращивания — плохая сделка.
    immortal: row.seeded <= 1,
    lostAt: inside?.lostAt ?? null,
  };

  const moved = advance(before, today);
  const after = moved.inc;
  if (moved.log.length > 0) {
    await store.petriSaveLab(userId, {
      day: after.day,
      dials: after.dials === null ? null : JSON.stringify(after.dials),
      feeds: after.feeds,
      neglect: after.neglect,
      goodDays: after.goodDays,
    });
    const creature = after.creature;
    if (creature !== null) {
      await store.petriGrew(
        creature.id,
        creature.stage,
        creature.axes === null ? null : JSON.stringify(creature.axes),
        after.lostAt,
      );
    }
  }

  return {
    inc: after,
    news: moved.log,
    slots: [
      slotCreature(rows, SLOTS[0]),
      slotCreature(rows, SLOTS[1]),
    ],
    collection: rows
      .filter((entry) => entry.place === SHELF)
      .map((entry) => toCreature(entry.creature)),
    seeded: row.seeded,
    misses: row.misses,
    bred: row.bred,
  };
}

function slotCreature(rows: PetriCreatureRow[], place: Place): Creature | null {
  const found = placed(rows, place);
  return found === undefined ? null : toCreature(found.creature);
}

/** Что показать игроку. Комфорт сюда не попадает — он остаётся на сервере. */
export function labView(lab: Lab, tokens: number): LabView {
  const inc = lab.inc;
  const creature = inc.creature;
  const species = creature === null ? null : speciesOf(creature);
  let hints: Record<Dial, Hint> | null = null;
  // Стрелки — только у того, кто уже вылупился: точке среда безразлична,
  // ей тумблеры выбирают форму, а не условия.
  if (species !== null && creature?.stage === 2 && inc.lostAt === null) {
    const dials = dialsOf(inc);
    hints = {} as Record<Dial, Hint>;
    for (const dial of DIALS) hints[dial] = hintFor(species, dial, dials[dial]);
  }
  return {
    day: inc.day,
    incubator: {
      creature,
      dials: dialsOf(inc),
      set: inc.dials !== null,
      feeds: inc.feeds,
      mood: moodOf(inc),
      pace: paceOf(inc),
      neglect: inc.neglect,
      death: NEGLECT_DEATH,
      goodDays: inc.goodDays,
      grow: GROW_DAYS,
      lostAt: inc.lostAt,
      hints,
    },
    slots: lab.slots,
    collection: lab.collection,
    seedCost: seedCost(lab.seeded),
    tokens,
    // Новости показываются один раз — при том взгляде, который сутки и
    // досчитал. Хранить их незачем: прибор рассказывает, что было ночью, а
    // не ведёт летопись.
    news: lab.news,
  };
}

export type LabError =
  /** В инкубаторе уже кто-то есть. */
  | 'busy'
  /** Инкубатор пуст: ухаживать не за кем. */
  | 'empty'
  /** Не хватило жетонов на точку. */
  | 'poor'
  /** Ещё не выросло, или уже не то. */
  | 'not-grown'
  /** Некуда положить: оба стекла заняты. */
  | 'no-room'
  /** Скрестить некого: нужны двое взрослых на стёклах хранения. */
  | 'no-pair';

/**
 * Посев: новая точка в инкубатор.
 *
 * Первая бесплатно, дальше по цене. Дорого нарочно — точку не покупают,
 * точку выводят; покупка нужна тому, у кого линия оборвалась.
 */
export async function seedLab(
  store: Store,
  userId: string,
  lab: Lab,
  now = new Date(),
): Promise<LabError | Creature> {
  if (lab.inc.creature !== null && lab.inc.lostAt === null) return 'busy';
  const price = seedCost(lab.seeded);
  if (!(await store.petriPay(userId, price))) return 'poor';
  // Погибшее уходит со стекла, но не в коллекцию: коллекция — это то, что
  // вырастили, а не кладбище.
  if (lab.inc.creature !== null) {
    await store.petriMove(userId, lab.inc.creature.id, 'lost', 'gone');
  }
  const creature: Creature = {
    id: randomUUID(),
    generation: 1,
    // Пока лаборатория сеет только жёлтых: диалекты остальных цветов идут
    // следующим заходом, и выдавать точку, которой не во что вылупиться,
    // было бы нечестно.
    color: 'yellow',
    colorMutation: null,
    behaviour: 'cling',
    behaviourMutation: null,
    bodyAnomaly: null,
    axes: null,
    stage: 1,
    parents: null,
    bredAt: null,
    createdAt: now.toISOString(),
  };
  await store.petriAdd(userId, toWire(creature), INC);
  // Новая точка начинает свои сутки с чистого листа: чужая кормёжка и чужие
  // тумблеры ей не наследуются.
  await store.petriSaveLab(userId, {
    day: lab.inc.day,
    dials: lab.inc.dials === null ? null : JSON.stringify(lab.inc.dials),
    feeds: 0,
    neglect: 0,
    goodDays: 0,
  });
  return creature;
}

/** Выставить тумблеры. */
export async function setLabDials(store: Store, userId: string, lab: Lab, dials: Dials): Promise<Lab> {
  const inc = setDials(lab.inc, cleanDials(dials));
  await store.petriSaveLab(userId, {
    day: inc.day,
    dials: JSON.stringify(inc.dials),
    feeds: inc.feeds,
    neglect: inc.neglect,
    goodDays: inc.goodDays,
  });
  return { ...lab, inc };
}

/** Покормить. Вторая кормёжка за сутки — уже перекорм, и она тоже считается. */
export async function feedLab(store: Store, userId: string, lab: Lab): Promise<Lab | LabError> {
  if (lab.inc.creature === null || lab.inc.lostAt !== null) return 'empty';
  if (lab.inc.creature.stage !== 2) return 'not-grown';
  const inc = feed(lab.inc);
  await store.petriSaveLab(userId, {
    day: inc.day,
    dials: inc.dials === null ? null : JSON.stringify(inc.dials),
    feeds: inc.feeds,
    neglect: inc.neglect,
    goodDays: inc.goodDays,
  });
  return { ...lab, inc };
}

/**
 * Переложить взрослого из инкубатора на стекло хранения.
 *
 * Стёкол два, и это ровно одна пара для скрещивания. Копить взрослых
 * нельзя: когда оба заняты, а в инкубаторе кто-то дорос, игрок обязан
 * решить — скрестить или отправить в коллекцию.
 */
export async function storeLab(store: Store, userId: string, lab: Lab): Promise<Lab | LabError> {
  const creature = lab.inc.creature;
  if (creature === null || lab.inc.lostAt !== null) return 'empty';
  if (!grown(creature)) return 'not-grown';
  const free = SLOTS.findIndex((_, index) => lab.slots[index] === null);
  if (free < 0) return 'no-room';
  if (!(await store.petriMove(userId, creature.id, INC, SLOTS[free]!))) return 'no-room';
  await store.petriSaveLab(userId, {
    day: lab.inc.day,
    dials: lab.inc.dials === null ? null : JSON.stringify(lab.inc.dials),
    feeds: 0,
    neglect: 0,
    goodDays: 0,
  });
  const slots: [Creature | null, Creature | null] = [...lab.slots];
  slots[free] = creature;
  return { ...lab, inc: { ...lab.inc, creature: null, feeds: 0, neglect: 0, goodDays: 0 }, slots };
}

/** Отправить в коллекцию — из инкубатора или со стекла хранения. */
export async function shelveLab(
  store: Store,
  userId: string,
  lab: Lab,
  id: string,
): Promise<Lab | LabError> {
  const inc = lab.inc.creature;
  const slot = SLOTS.findIndex((_, index) => lab.slots[index]?.id === id);
  const from = inc !== null && inc.id === id ? INC : slot >= 0 ? SLOTS[slot]! : null;
  if (from === null) return 'empty';
  const creature = from === INC ? inc! : lab.slots[slot]!;
  // В коллекцию идёт только выросшее: точку и подростка отправлять туда
  // незачем — коллекция про то, что довели до конца.
  if (!grown(creature)) return 'not-grown';
  if (!(await store.petriMove(userId, id, from, SHELF))) return 'empty';
  if (from === INC) {
    await store.petriSaveLab(userId, {
      day: lab.inc.day,
      dials: lab.inc.dials === null ? null : JSON.stringify(lab.inc.dials),
      feeds: 0,
      neglect: 0,
      goodDays: 0,
    });
  }
  const slots: [Creature | null, Creature | null] = [...lab.slots];
  if (slot >= 0) slots[slot] = null;
  return {
    ...lab,
    inc: from === INC ? { ...lab.inc, creature: null, feeds: 0, neglect: 0, goodDays: 0 } : lab.inc,
    slots,
    collection: [creature, ...lab.collection],
  };
}

/**
 * Скрестить двоих со стёкол хранения.
 *
 * Нужен пустой инкубатор: результат — новая точка, и класть её некуда,
 * пока в стекле кто-то растёт. Оба родителя после этого уходят в
 * коллекцию, а их единственное скрещивание считается потраченным: число
 * мутантов в мире не растёт, и каждое поколение линии требует чистого
 * расходника, выращенного полностью.
 */
export async function breedLab(
  store: Store,
  userId: string,
  lab: Lab,
  now = new Date(),
): Promise<Lab | LabError> {
  const [first, second] = lab.slots;
  if (!breedable(first, second)) return 'no-pair';
  if (lab.inc.creature !== null && lab.inc.lostAt === null) return 'busy';
  const at = now.toISOString();
  const result = breed(first!, second!, {
    seed: lab.inc.seed,
    misses: lab.misses,
    // Первое скрещивание игрока не бывает пустым: он должен увидеть, ради
    // чего всё это, а не выяснить это через полгода.
    promised: lab.bred === 0,
    id: randomUUID(),
    at,
  });

  await store.petriBred(userId, [first!.id, second!.id], at);
  for (const parent of [first!, second!]) {
    await store.petriMove(userId, parent.id, placeOf(lab, parent.id), SHELF);
  }
  if (lab.inc.creature !== null) {
    await store.petriMove(userId, lab.inc.creature.id, 'lost', 'gone');
  }
  await store.petriAdd(userId, toWire(result.child), INC);
  await store.petriBredCount(userId, result.fresh);
  await store.petriSaveLab(userId, {
    day: lab.inc.day,
    dials: lab.inc.dials === null ? null : JSON.stringify(lab.inc.dials),
    feeds: 0,
    neglect: 0,
    goodDays: 0,
  });

  const bredParents = [first!, second!].map((parent) => ({ ...parent, bredAt: at }));
  return {
    ...lab,
    inc: { ...lab.inc, creature: result.child, feeds: 0, neglect: 0, goodDays: 0, lostAt: null },
    slots: [null, null],
    collection: [...bredParents, ...lab.collection],
    misses: result.fresh ? 0 : lab.misses + 1,
    bred: lab.bred + 1,
  };
}

function placeOf(lab: Lab, id: string): Place {
  const slot = SLOTS.findIndex((_, index) => lab.slots[index]?.id === id);
  return slot >= 0 ? SLOTS[slot]! : INC;
}

export type { Lab };
