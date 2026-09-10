import type { ColorMutation, Creature } from './creature.js';
import type { Color } from './species.js';

/**
 * Окрасы. Четыре обычных — они же поведения, пять мутационных — только
 * скрещиванием.
 *
 * Окрас **не влияет на поведение**: ультрафиолетовый жёлтый по-прежнему
 * сидит на стенке. Слоты независимы намеренно — иначе редкий цвет и редкое
 * поведение перемножились бы, и над ценностью не осталось бы никакого
 * управления.
 */

export const BASE_COLORS: Readonly<Record<Color, string>> = {
  yellow: '#E8B93F',
  red: '#E0563C',
  blue: '#3F86C9',
  green: '#86A93F',
};

/**
 * Как прибор рисует тело: заливка, контур, прозрачность и цвет зрачка.
 *
 * Мутационные окрасы — не просто другой hex. «Стекло» видно только по
 * глазам, «магма» двухцветна и пульсирует; описывать это отдельными полями
 * дешевле, чем городить особый случай в каждом месте, где рисуется тело.
 */
export interface Skin {
  fill: string;
  /** Заливка прозрачна настолько — у «стекла» тело почти не видно. */
  fillOpacity: number;
  /** Контур: у обычных окрасов его нет, у «стекла» он и есть всё тело. */
  stroke: string | null;
  /** Второй цвет: кайма и пятна взрослой формы, прожилки у «магмы». */
  accent: string;
  pupil: string;
  /** Светятся ли глаза — так узнают «магму» с другого конца чашки. */
  glow: boolean;
}

const MUTATION_SKINS: Readonly<Record<ColorMutation, Omit<Skin, 'accent'> & { accent?: string }>> = {
  // Альбинос, самый частый из редких: зрачки красноватые — иначе молочное
  // тело на светлом стекле теряет лицо.
  milk: { fill: '#EFE9DA', fillOpacity: 1, stroke: null, pupil: '#8A3B32', glow: false },
  // Окисленный металл — тон самого лабораторного оборудования.
  patina: { fill: '#35BF9C', fillOpacity: 1, stroke: null, pupil: '#14312B', glow: false },
  // Единственный цвет вне палитры интерфейса, поэтому и заметно реже.
  ultraviolet: { fill: '#8A5CE6', fillOpacity: 1, stroke: null, pupil: '#1C1030', glow: false },
  // Сквозь тело виден фон чашки: такого ищут по глазам, а не по цвету.
  glass: { fill: '#7FD7E8', fillOpacity: 0.15, stroke: '#7FD7E8', pupil: '#1B4C55', glow: false },
  // Вершина лестницы: тёмное тело, светящиеся прожилки и глаза, пульсация
  // в такт морганию.
  magma: { fill: '#2E1A14', fillOpacity: 1, stroke: null, accent: '#FF6A2B', pupil: '#FF6A2B', glow: true },
};

/** Осветлить или притемнить окрас — так получается кайма взрослой формы. */
function shift(hex: string, amount: number): string {
  const num = Number.parseInt(hex.slice(1), 16);
  const parts = [(num >> 16) & 255, (num >> 8) & 255, num & 255].map((channel) => {
    const moved = amount > 0 ? channel + (255 - channel) * amount : channel * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(moved)));
  });
  return `#${parts.map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

/** Чем красить это существо. */
export function skinOf(creature: Creature): Skin {
  if (creature.colorMutation !== null) {
    const mutated = MUTATION_SKINS[creature.colorMutation];
    return { ...mutated, accent: mutated.accent ?? shift(mutated.fill, -0.35) };
  }
  const base = BASE_COLORS[creature.color];
  return {
    fill: base,
    fillOpacity: 1,
    stroke: null,
    // Вторичный цвет — тот же окрас темнее: взрослая форма отличается от
    // подростка не цветом, а тем, что у неё этот второй цвет вообще есть.
    accent: shift(base, -0.4),
    pupil: '#101010',
    glow: false,
  };
}
