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
  clampDial,
  cleanDials,
  resetDials,
} from './dials.js';
export type { Dial, Dials, Zone } from './dials.js';

export {
  COLORS,
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
  formOdds,
} from './species.js';
export type { Axes, Behaviour, Color, Comfort, Species } from './species.js';

export { COLOR_MUTATIONS, speciesOf, behaviourOf, mutationCount } from './creature.js';
export type { BodyAnomaly, ColorMutation, Creature, Stage } from './creature.js';

export {
  LAB_TZ_HOURS,
  GROW_DAYS,
  NEGLECT_DEATH,
  labDay,
  labDayShift,
  labDaysBetween,
  dialsOf,
  alive,
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
