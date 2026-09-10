import type { Axes, Behaviour, Color, Species } from './species.js';

/**
 * Существо — строка параметров, а не картинка.
 *
 * Тело собирается из восьми примитивов на лету (`body.ts`), поэтому мутация
 * становится подменой одного значения в этой строке, а не отдельным
 * рисунком. Иначе 108 форм × 5 окрасов × 16 поведений пришлось бы рисовать
 * руками, и вторая партия мутаций остановила бы работу совсем.
 */

/** Стадия: точка, существо, взрослая форма. */
export type Stage = 1 | 2 | 3;

/**
 * Мутационные окрасы — их нельзя получить тумблерами, только скрещиванием.
 *
 * Чёрного среди них нет намеренно: на чёрном стекле тело исчезает, остаются
 * одни глаза. Эффектно ровно один раз, дальше игрок просто не видит питомца.
 */
export type ColorMutation = 'milk' | 'patina' | 'ultraviolet' | 'glass' | 'magma';

export const COLOR_MUTATIONS: readonly ColorMutation[] = [
  'milk',
  'patina',
  'ultraviolet',
  'glass',
  'magma',
];

/** Аномалия тела — третий слот мутации. Всегда про глаза или отростки. */
export type BodyAnomaly = 'third-eye' | 'one-eye' | 'stalk-eyes' | 'crooked';

export const BODY_ANOMALIES: readonly BodyAnomaly[] = [
  'third-eye',
  'one-eye',
  'stalk-eyes',
  'crooked',
];

/**
 * Занятый слот поведения.
 *
 * Полная подмена — существо живёт чужим движением совсем. Частичная —
 * нижняя ступень лестницы редкости: своё поведение остаётся, но раз в сутки
 * на несколько минут существо срывается в чужое (жёлтый отлепляется,
 * проползает круг и возвращается на стенку). Она самая дешёвая в
 * производстве и единственная, дающая повод открыть прибор просто
 * посмотреть.
 */
export interface BehaviourMutation {
  to: Behaviour;
  partial: boolean;
}

/**
 * Существо целиком. Поля повторяют спецификацию — их читает и сервер, и
 * паспорт в коллекции, и обмен в чате.
 *
 * Занятых слотов мутации не бывает больше двух: три перемножили бы редкость
 * и отняли бы у неё смысл. Это правило живёт в скрещивании (`breed.ts`), а
 * формат его только выдерживает.
 */
export interface Creature {
  id: string;
  /** G1 — дикий предок; номер растёт только скрещиванием. */
  generation: number;
  color: Color;
  colorMutation: ColorMutation | null;
  behaviour: Behaviour;
  behaviourMutation: BehaviourMutation | null;
  bodyAnomaly: BodyAnomaly | null;
  /**
   * Форма. У точки её ещё **нет**: форму выбирают тумблеры в тот миг, когда
   * точка вылупляется, — иначе среда решала бы что-то до того, как игрок её
   * выставил, а вся первая стадия только в этом и состоит.
   */
  axes: Axes | null;
  stage: Stage;
  parents: [string, string] | null;
  /** Скрещивание одно на существо: занято — значит, линия уже продолжена. */
  bredAt: string | null;
  createdAt: string;
}

/** Вид существа. У точки его ещё нет: форма не выбрана. */
export function speciesOf(creature: Creature): Species | null {
  return creature.axes === null ? null : { color: creature.color, axes: creature.axes };
}

/**
 * Каким поведением оно живёт: своим или доставшимся от мутации.
 *
 * Тело при подмене **не перестраивается**. Жёлтый стебель, поползший по
 * стенке, остаётся стеблем и тащит себя, потому что не приспособлен, — в
 * этом весь визуальный эффект, ради которого мутация поведения и заведена.
 */
export function behaviourOf(creature: Creature): Behaviour {
  const mutation = creature.behaviourMutation;
  // Частичная мутация — нижняя ступень лестницы: существо живёт своим
  // поведением и лишь раз в сутки на несколько минут срывается в чужое.
  // Кто оно по жизни, решает не она.
  return mutation === null || mutation.partial ? creature.behaviour : mutation.to;
}

/** Сколько слотов мутации занято: от этого зависит и цена, и наследование. */
export function mutationCount(creature: Creature): number {
  return (
    (creature.colorMutation === null ? 0 : 1) +
    (creature.behaviourMutation === null ? 0 : 1) +
    (creature.bodyAnomaly === null ? 0 : 1)
  );
}
