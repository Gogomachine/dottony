/**
 * PETRIDOT — второй прибор ROUND THINGS INC.
 *
 * Лабораторный инкубатор: под стеклом чашка Петри, в ней ооза с глазами.
 * Игрок выставляет три параметра среды, ухаживает за культурой и выращивает
 * из точки существо; взрослых можно продать за жетоны DOTOSCOPE, отправить
 * в коллекцию или скрестить.
 *
 * Здесь — только правила и рисование тел: чистые функции без времени, без
 * сети и без базы. Часы, случайность и деньги живут на сервере, потому что
 * иначе перевод часов на телефоне ломает суточный цикл бесплатно.
 */

export {
  SCALE,
  DIALS,
  ZONE_EDGES,
  zoneOf,
  zoneMiddle,
  seedOf,
  clampDial,
  cleanDials,
  resetDials,
} from './dials.js';
export type { Dial, Dials, Zone } from './dials.js';

export {
  COLORS,
  CARE_DIALS,
  BEHAVIOUR_LADDER,
  BEHAVIOUR_OF,
  COMFORT_SPAN,
  axesOf,
  speciesId,
  speciesOfColor,
  comfortOf,
  dialFits,
  envFits,
  hintFor,
  HINT_REACH,
  formOdds,
} from './species.js';
export type { Axes, Behaviour, CareDial, Color, Comfort, Hint, Species } from './species.js';

export { BODY_ANOMALIES, COLOR_MUTATIONS, speciesOf, behaviourOf, mutationCount } from './creature.js';
export type { BehaviourMutation, BodyAnomaly, ColorMutation, Creature, Stage } from './creature.js';

export {
  SEED_PRICE,
  MUTATION_CHANCE,
  MISS_GUARANTEE,
  MAX_MUTATIONS,
  seedCost,
  seedColor,
  breed,
  breedable,
  grown,
} from './lab.js';
export type { BreedOptions, BreedResult, Slot } from './lab.js';

export {
  LAB_TZ_HOURS,
  HATCH_HOURS,
  GROW_HOURS,
  NEGLECT_DEATH,
  labDay,
  labDayShift,
  labDaysBetween,
  labDayEnd,
  dialsOf,
  alive,
  hatchTime,
  growing,
  growDue,
  ripen,
  dayVerdict,
  moodOf,
  paceOf,
  advance,
  setDials,
  feed,
} from './care.js';
export type { DayLog, DayVerdict, Incubator, Mood } from './care.js';

export { BASE_COLORS, skinOf } from './palette.js';
export type { Skin } from './palette.js';

export { BODY_BOX, GROWN_SCALE, bodyOf, bodyOfSpecies, boundsOf, scaleShape, viewBoxOf } from './body.js';
export type { BodyShape, Part, Point, Role } from './body.js';

export { drawBody, bodyMarkup } from './svg.js';
export type { Drawn, Gaze } from './svg.js';

export type { IncubatorView, LabView } from './view.js';
