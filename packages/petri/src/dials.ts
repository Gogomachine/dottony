import { nextInt, seedRng, type RngState } from '@doton/core';

/**
 * Три тумблера среды: температура, влажность, питательная среда.
 *
 * Шкалы **непрерывные**, а не трёхпозиционные. Три положения дали бы ровно
 * 27 комбинаций на цвет, и вся сетка утекла бы в комментарии за неделю:
 * «мин-сред-макс» перечисляется в один присест. Непрерывная шкала с зонами
 * неравной ширины перечисляется деталями, а не комбинациями, — и редкий
 * результат приходится искать, а не выбирать из списка.
 *
 * Значение — целое число делений, от нуля до `SCALE`. Дробей нарочно нет:
 * положение тумблера едет в базу, в ответ сервера и в тест, а сравнивать
 * дроби на трёх дорогах — способ однажды не совпасть на единицу в последнем
 * знаке.
 */

/** Делений на шкале. Тысяча — мельче, чем различает палец на телефоне. */
export const SCALE = 1000;

/** Какой тумблер. Порядок тот же, что на корпусе сверху вниз. */
export type Dial = 'temp' | 'humidity' | 'medium';

export const DIALS: readonly Dial[] = ['temp', 'humidity', 'medium'];

/** Положения всех трёх тумблеров — то, что видно на приборе. */
export interface Dials {
  temp: number;
  humidity: number;
  medium: number;
}

/**
 * Зона шкалы: она же значение оси формы (см. `species.ts`).
 *
 * Ноль — левый край шкалы, двойка — правый. Названия у каждой оси свои
 * («холодно» — не то же, что «сухо»), поэтому здесь только номер.
 */
export type Zone = 0 | 1 | 2;

/**
 * Границы зон на каждой шкале, в делениях.
 *
 * Середина широкая, края узкие — и это не украшение, а способ раздать
 * редкость без отдельной таблицы: обычная форма занимает половину шкалы и
 * попадается сама, редкая сидит в узком секторе, и в него надо попасть
 * нарочно. Границы у трёх шкал разные, чтобы «поставь всё на четверть» не
 * оказалось общим ответом на все три вопроса.
 *
 * Ширины — предмет калибровки: это первое, что придётся крутить, когда
 * станет видно, какие формы игроки находят, а какие нет.
 */
export const ZONE_EDGES: Readonly<Record<Dial, readonly [number, number]>> = {
  temp: [200, 700],
  humidity: [260, 740],
  medium: [180, 660],
};

/** В какую зону попал тумблер. */
export function zoneOf(dial: Dial, value: number): Zone {
  const [low, high] = ZONE_EDGES[dial];
  if (value < low) return 0;
  return value < high ? 1 : 2;
}

/** Середина зоны — по ней прибор рисует засечки и по ней же удобно целиться. */
export function zoneMiddle(dial: Dial, zone: Zone): number {
  const [low, high] = ZONE_EDGES[dial];
  if (zone === 0) return Math.round(low / 2);
  if (zone === 1) return Math.round((low + high) / 2);
  return Math.round((high + SCALE) / 2);
}

/** Положение тумблера в допустимых пределах и целым числом делений. */
export function clampDial(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(SCALE, Math.max(0, Math.round(value)));
}

export function cleanDials(dials: Dials): Dials {
  return {
    temp: clampDial(dials.temp),
    humidity: clampDial(dials.humidity),
    medium: clampDial(dials.medium),
  };
}

/**
 * Перемешать число и строку в одно число.
 *
 * Нужен настоящий лавинный хеш, а не «сложить по буквам»: соседние дни
 * различаются одним знаком в конце, и слабое перемешивание сажает сброс на
 * решётку — измеряли, децили шкалы расходились втрое. А неравномерный сброс
 * тихо меняет редкость форм: в узкую зону тумблер сам не заходит вовсе.
 *
 * FNV-1a по знакам плюс финализатор — тот же приём, что в любом приличном
 * хеше: умножение растит старшие биты, сдвиг с исключающим ИЛИ тащит их
 * обратно в младшие.
 */
function mix(seed: number, text: string): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Сид от строки: им заводятся и комфорт вида, и суточный сброс. */
export function seedOf(text: string, salt = 0): number {
  return mix(salt, text);
}

/**
 * Куда тумблеры встали при суточном сбросе.
 *
 * Считается, а не хранится, — и это важнее, чем кажется. Прибор досчитывает
 * пропущенные сутки задним числом (см. `care.ts`), а значит должен знать,
 * как стояли тумблеры в тот день, когда игрок не приходил. Хранить по строке
 * на каждые сутки каждого инкубатора ради этого незачем: сид инкубатора и
 * день дают то же самое число когда угодно и сколько угодно раз.
 */
export function resetDials(seed: number, day: string): Dials {
  let state: RngState = seedRng(mix(seed, day));
  const roll = (): number => {
    const next = nextInt(state, SCALE + 1);
    state = next.state;
    return next.value;
  };
  return { temp: roll(), humidity: roll(), medium: roll() };
}
