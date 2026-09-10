import { nextInt, seedRng } from '@doton/core';
import { DIALS, SCALE, ZONE_EDGES, seedOf, zoneOf, type Dial, type Dials, type Zone } from './dials.js';

/**
 * Вид: цвет плюс три оси. Из них собирается и тело, и характер.
 *
 * Формы не рисуются по одной. Каждый тумблер отвечает за свой признак
 * (контур, силуэт, отростки), три признака по три положения дают 27 форм на
 * цвет и 108 всего. Мутация после этого — подмена одного значения в строке,
 * а не отдельная картинка.
 */

/** Четыре цвета — они же четыре поведения. Пятый цвет бывает только мутацией. */
export type Color = 'yellow' | 'red' | 'blue' | 'green';

export const COLORS: readonly Color[] = ['yellow', 'red', 'blue', 'green'];

/** Как существо движется. Цвет задаёт поведение, мутация может его подменить. */
export type Behaviour = 'cling' | 'crawl-edge' | 'climb' | 'bounce';

/**
 * Поведение по цвету — и порядок этого списка не случаен.
 *
 * Он же лестница редкости мутации поведения: прилип → по краю → по стеклу →
 * прыгает. Мутация на соседнюю ступень частая, через одну — реже, на
 * противоположный конец — самая редкая. Прыгающий стебель и прилипший к
 * стенке мяч оказываются на вершине сами, без ручных таблиц.
 */
export const BEHAVIOUR_LADDER: readonly Behaviour[] = ['cling', 'crawl-edge', 'climb', 'bounce'];

export const BEHAVIOUR_OF: Readonly<Record<Color, Behaviour>> = {
  yellow: 'cling',
  red: 'crawl-edge',
  green: 'climb',
  blue: 'bounce',
};

/** Оси формы — те же три тумблера, только уже зонами. */
export interface Axes {
  temp: Zone;
  humidity: Zone;
  medium: Zone;
}

/** Вид целиком: по нему рисуется тело и от него зависит комфорт. */
export interface Species {
  color: Color;
  axes: Axes;
}

/** Какая форма вылупится при таком положении тумблеров. */
export function axesOf(dials: Dials): Axes {
  return {
    temp: zoneOf('temp', dials.temp),
    humidity: zoneOf('humidity', dials.humidity),
    medium: zoneOf('medium', dials.medium),
  };
}

/**
 * Ключ вида: `yellow-201`. Он же ключ в таблицах сообщества и в паспорте.
 *
 * Нарочно читается человеком: игроки всё равно заведут свои таблицы, и
 * пусть в них стоит то же, что в приборе, а не выдуманный ими самими код.
 */
export function speciesId(species: Species): string {
  const { temp, humidity, medium } = species.axes;
  return `${species.color}-${temp}${humidity}${medium}`;
}

/** Все 27 форм одного цвета, в порядке осей. */
export function speciesOfColor(color: Color): Species[] {
  const all: Species[] = [];
  for (let temp = 0; temp < 3; temp++) {
    for (let humidity = 0; humidity < 3; humidity++) {
      for (let medium = 0; medium < 3; medium++) {
        all.push({ color, axes: { temp: temp as Zone, humidity: humidity as Zone, medium: medium as Zone } });
      }
    }
  }
  return all;
}

/**
 * Комфортный диапазон по одному тумблеру: середина и допуск в делениях.
 *
 * Попал в `[at - span, at + span]` — существу хорошо.
 */
export interface Comfort {
  at: number;
  span: number;
}

/**
 * Ширина комфортного окна, в делениях в каждую сторону.
 *
 * Восемьдесят из тысячи — примерно шестая часть шкалы на все три тумблера
 * сразу: попасть наугад втроём выходит примерно раз из двухсот, а попасть
 * зная — с первого раза. Именно эта разница и делает знание ценным.
 */
export const COMFORT_SPAN = 80;

/**
 * Что этому виду нравится.
 *
 * Считается от вида, а не хранится и не разыгрывается заново: комфорт
 * `yellow-201` обязан быть одним и тем же у всех игроков и через год —
 * иначе таблицы сообщества, ради которых всё это и затевалось, врут.
 *
 * И он **не совпадает** с той зоной, из которой вид вылупился. Иначе игра
 * кончалась бы на первом же существе: вырастил — и уже знаешь, что ему
 * нужно. Рецепт («какие тумблеры дают эту форму») и уход («что эта форма
 * любит») — две разные тайны, и обе открываются опытом.
 */
export function comfortOf(species: Species): Record<Dial, Comfort> {
  let state = seedRng(seedOf(speciesId(species), 0x9e3779b9));
  const comfort = {} as Record<Dial, Comfort>;
  for (const dial of DIALS) {
    // Середина не подходит к самому краю шкалы: тумблер, который надо
    // выкрутить до упора, читается как поломка, а не как уход.
    const room = SCALE - 2 * (COMFORT_SPAN + 40);
    const next = nextInt(state, room + 1);
    state = next.state;
    comfort[dial] = { at: COMFORT_SPAN + 40 + next.value, span: COMFORT_SPAN };
  }
  return comfort;
}

/** Хорошо ли существу по этому тумблеру. */
export function dialFits(comfort: Comfort, value: number): boolean {
  return Math.abs(value - comfort.at) <= comfort.span;
}

/** Хорошо ли ему по всем трём разом — только это и считается уходом. */
export function envFits(species: Species, dials: Dials): boolean {
  const comfort = comfortOf(species);
  return DIALS.every((dial) => dialFits(comfort[dial], dials[dial]));
}

/** Что прибор говорит про этот тумблер. */
export type Hint =
  /** Убавить: существу слишком много. */
  | 'less'
  /** Прибавить. */
  | 'more'
  /** Уже близко — но насколько, прибор не скажет. */
  | 'near'
  /** Попал. */
  | 'fits';

/**
 * Насколько далеко подсказка называет сторону, в ширинах комфортного окна.
 *
 * Дальше этого прибор говорит «теплее/холоднее», ближе — только «рядом». И
 * это не жадность, а единственное, что спасает всю затею с уходом: стрелка,
 * работающая вплотную, находится перебором за полминуты — крутишь тумблер,
 * пока она не перевернётся, и вот тебе точная граница. После этого ни
 * тайны, ни таблиц, ни разговоров о том, кто что любит, не остаётся.
 *
 * Стрелка доводит до окрестности, а последний шаг игрок делает сам — и
 * запоминает.
 */
export const HINT_REACH = 2;

/**
 * Куда крутить, чтобы стало лучше.
 *
 * Чисел прибор не называет никогда: «теплее» — совет, «поставь 640» —
 * ответ, после которого ухаживать больше не за чем.
 */
export function hintFor(species: Species, dial: Dial, value: number): Hint {
  const comfort = comfortOf(species)[dial];
  if (dialFits(comfort, value)) return 'fits';
  const away = Math.abs(value - comfort.at);
  if (away <= comfort.span * (HINT_REACH + 1)) return 'near';
  return value < comfort.at ? 'more' : 'less';
}

/**
 * Насколько редка форма: произведение ширин трёх зон, в долях шкалы.
 *
 * Считается из тех же границ, по которым зоны и нарезаны, — отдельной
 * таблицы редкости нет и заводить её не надо: сузил сектор — форма стала
 * реже, и цена в жетонах поехала следом сама.
 */
export function formOdds(species: Species): number {
  const width = (dial: Dial, zone: Zone): number => {
    const [low, high] = ZONE_EDGES[dial];
    if (zone === 0) return low;
    if (zone === 1) return high - low;
    return SCALE - high;
  };
  return (
    (width('temp', species.axes.temp) / SCALE) *
    (width('humidity', species.axes.humidity) / SCALE) *
    (width('medium', species.axes.medium) / SCALE)
  );
}
