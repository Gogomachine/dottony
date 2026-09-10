import type { Creature } from './creature.js';
import type { Species } from './species.js';
import type { Zone } from './dials.js';
import { speciesOf } from './creature.js';

/**
 * Тело: восемь примитивов вместо ста восьми картинок.
 *
 * Существа не хранятся спрайтами. Каждый тумблер отвечает за свой признак —
 * контур, силуэт, отростки, — и тело собирается из скруглённых
 * прямоугольников, эллипсов, треугольников, палок с шариком и глаз. Мутация
 * после этого становится подменой одного значения в строке существа, а не
 * новым рисунком; иначе вторая партия мутаций остановила бы работу совсем.
 *
 * **Оснастка одна на все тела** и заложена сразу, до всяких мутаций
 * поведения: точка крепления снизу, ось сжатия по вертикали, голова сверху.
 * Цикл движения принадлежит поведению, а не телу, — и жёлтый стебель обязан
 * подставляться в прыжок синего без переделки. Если этого не заложить
 * теперь, на второй партии придётся перерисовывать всё.
 */

export interface Point {
  x: number;
  y: number;
}

/** Чем красить эту часть: телом, вторым цветом или тенью. */
export type Role = 'body' | 'accent' | 'shade';

export type Part =
  | { kind: 'rrect'; x: number; y: number; w: number; h: number; r: number; role: Role }
  | { kind: 'ellipse'; x: number; y: number; rx: number; ry: number; role: Role }
  /** Скол: треугольник, торчащий из контура. `angle` — куда смотрит остриё. */
  | { kind: 'tri'; x: number; y: number; size: number; angle: number; role: Role }
  /** Отросток: палка с шариком на конце. `tip` в ноль — шарика нет. */
  | { kind: 'stalk'; x: number; y: number; angle: number; len: number; w: number; tip: number; role: Role }
  /** Глаз: белая точка со зрачком. Зрачок ставит уже анимация — он следит за пальцем. */
  | { kind: 'eye'; x: number; y: number; r: number };

export interface BodyShape {
  parts: Part[];
  /** Точка крепления снизу — ею тело стоит на стенке, на дне или на лапках. */
  anchor: Point;
  /** Голова сверху: по ней тело наклоняется и от неё растут отростки. */
  head: Point;
  /** Ось сжатия: вокруг этой высоты тело сплющивается при приземлении. */
  squash: number;
  /** Габарит — чтобы вписать существо в чашку, не измеряя его каждый раз. */
  width: number;
  height: number;
}

/** Поле корпуса: сто на сто, крепление внизу посередине. */
export const BODY_BOX = 100;
const ANCHOR: Point = { x: 50, y: 96 };

/** Куда смотрит угол: ноль — вверх, положительный — вправо. */
function step(from: Point, angle: number, len: number): Point {
  const rad = (angle * Math.PI) / 180;
  return { x: from.x + Math.sin(rad) * len, y: from.y - Math.cos(rad) * len };
}

/**
 * Силуэт — ось влажности.
 *
 * Тонкий и вытянутый на «сухо», каплевидный посередине, раздутый и
 * пузырчатый на «сыро». Возвращает габарит тела; всё остальное лепится к
 * нему.
 */
function silhouette(humidity: Zone): { w: number; h: number; bulb: number } {
  if (humidity === 0) return { w: 20, h: 62, bulb: 0.62 };
  if (humidity === 1) return { w: 32, h: 50, bulb: 0.78 };
  return { w: 44, h: 40, bulb: 1 };
}

/**
 * Жёлтый диалект: сидячий, стеблевой, широкое основание. Он прилеплен к
 * стенке стекла, и всё его тело — про опору: снизу подошва, сверху голова с
 * глазами, отростки — усики над головой.
 *
 * Диалекты остальных трёх цветов идут вторым заходом (у красного «отростки»
 * — шипы вдоль спины, у синего — шишки по контуру, у зелёного — ветвящиеся
 * конечности). Пока прибор сеет только жёлтых, и рисовать впрок то, чего в
 * игре нет, значит рисовать вслепую.
 */
function yellowBody(species: Species, grown: boolean): BodyShape {
  const { temp, humidity, medium } = species.axes;
  const shape = silhouette(humidity);
  const parts: Part[] = [];

  // Подошва: широкое основание, которым жёлтый держится за стекло.
  const padWidth = shape.w * 0.55 + 16;
  parts.push({ kind: 'ellipse', x: ANCHOR.x, y: ANCHOR.y - 3, rx: padWidth / 2, ry: 6, role: 'shade' });

  const bottom = ANCHOR.y - 6;
  const top = bottom - shape.h;
  const headY = top + shape.h * (1 - shape.bulb) * 0.5 + shape.w * 0.35;

  // Контур — ось температуры. Острые грани режут силуэт углами и сколами,
  // гладкий оставляет его как есть, оплывший скругляет и пускает потёки.
  const radius = temp === 0 ? 2 : temp === 1 ? shape.w * 0.42 : shape.w * 0.5;

  // Стебель: то, чем тело держится над подошвой. У раздутых он короткий и
  // почти не виден, у тонких — это и есть всё тело.
  const stemHeight = shape.h * (1 - shape.bulb);
  if (stemHeight > 2) {
    parts.push({
      kind: 'rrect',
      x: ANCHOR.x,
      y: bottom - stemHeight / 2,
      w: shape.w * 0.55,
      h: stemHeight + 6,
      r: temp === 0 ? 1 : shape.w * 0.2,
      role: 'body',
    });
  }

  // Голова-тело: то, на чём глаза.
  const bulbHeight = shape.h * shape.bulb;
  const bulbY = top + bulbHeight / 2;
  if (temp === 2) {
    // Оплывший: эллипс шире книзу и потёки, стекающие с него.
    parts.push({ kind: 'ellipse', x: ANCHOR.x, y: bulbY, rx: shape.w / 2, ry: bulbHeight / 2, role: 'body' });
    // Потёки начинаются **внутри** тела и стекают вниз: висящие рядом
    // кружки читались не как «оплыл», а как «отвалилось».
    for (const side of [-1, 0, 1]) {
      parts.push({
        kind: 'ellipse',
        x: ANCHOR.x + side * shape.w * 0.28,
        y: bulbY + bulbHeight * 0.34 + (side === 0 ? 10 : 6),
        rx: 5,
        ry: side === 0 ? 13 : 9,
        role: 'body',
      });
    }
  } else {
    parts.push({
      kind: 'rrect',
      x: ANCHOR.x,
      y: bulbY,
      w: shape.w,
      h: bulbHeight,
      r: radius,
      role: 'body',
    });
  }

  if (temp === 0) {
    // Кристаллические сколы: три грани, торчащие из боков и с макушки.
    parts.push({ kind: 'tri', x: ANCHOR.x - shape.w / 2, y: bulbY - 4, size: 9, angle: -90, role: 'body' });
    parts.push({ kind: 'tri', x: ANCHOR.x + shape.w / 2, y: bulbY + 6, size: 7, angle: 90, role: 'body' });
    parts.push({ kind: 'tri', x: ANCHOR.x + shape.w * 0.18, y: top, size: 8, angle: 0, role: 'body' });
  }

  if (humidity === 2) {
    // Пузырчатость: несколько пузырей по телу, а не ровная поверхность. Они
    // тенью, а не цветом тела: одноцветные пузыри на теле не видно вовсе —
    // проверено глазами на каталоге.
    for (const [dx, dy, r] of [
      [-0.34, -0.22, 5],
      [0.32, -0.3, 4],
      [0.26, 0.24, 5.5],
    ] as const) {
      parts.push({
        kind: 'ellipse',
        x: ANCHOR.x + shape.w * dx,
        y: bulbY + bulbHeight * dy,
        rx: r,
        ry: r,
        role: 'shade',
      });
    }
  }

  // Отростки — ось питательной среды. У жёлтого это усики над головой.
  const crown: Point = { x: ANCHOR.x, y: top + 2 };
  const stalks: { angle: number; len: number }[] =
    medium === 0
      ? []
      : medium === 1
        ? [{ angle: -10, len: 22 }]
        : [
            { angle: -34, len: 20 },
            { angle: -4, len: 26 },
            { angle: 30, len: 18 },
          ];
  for (const stalk of stalks) {
    // Взрослая форма: отростки длиннее и ветвятся — это и есть «прокачанный»
    // вид, а не просто увеличенный.
    const len = stalk.len * (grown ? 1.35 : 1);
    parts.push({
      kind: 'stalk',
      x: crown.x,
      y: crown.y,
      angle: stalk.angle,
      len,
      w: 3.4,
      tip: 3.6,
      role: 'body',
    });
    if (medium === 2 || grown) {
      const fork = step(crown, stalk.angle, len * 0.62);
      parts.push({
        kind: 'stalk',
        x: fork.x,
        y: fork.y,
        angle: stalk.angle - 38,
        len: len * 0.45,
        w: 2.4,
        tip: 2.8,
        role: grown ? 'accent' : 'body',
      });
    }
  }

  if (grown) {
    // Вторичный цвет: пятна на теле. Взрослая форма отличается не размером,
    // а тем, что у неё этот второй цвет вообще появляется.
    parts.push({ kind: 'ellipse', x: ANCHOR.x - shape.w * 0.22, y: bulbY + bulbHeight * 0.22, rx: 4, ry: 4, role: 'accent' });
    parts.push({ kind: 'ellipse', x: ANCHOR.x + shape.w * 0.24, y: bulbY + bulbHeight * 0.05, rx: 3, ry: 3, role: 'accent' });
  }

  // Глаза: всегда две белые точки со зрачком. Никаких ртов и лиц — вся
  // личность в тайминге моргания, а не в мимике.
  const eyeGap = Math.min(shape.w * 0.3, 11);
  const eyeR = shape.w > 34 ? 6 : 5.2;
  parts.push({ kind: 'eye', x: ANCHOR.x - eyeGap, y: headY, r: eyeR });
  parts.push({ kind: 'eye', x: ANCHOR.x + eyeGap, y: headY, r: eyeR });

  return {
    parts,
    anchor: ANCHOR,
    head: { x: ANCHOR.x, y: top },
    squash: ANCHOR.y,
    width: shape.w,
    height: ANCHOR.y - top,
  };
}

/** Точка первой стадии: тот же окрас, те же глаза — и всё. */
function pointBody(): BodyShape {
  const y = ANCHOR.y - 14;
  return {
    parts: [
      { kind: 'ellipse', x: ANCHOR.x, y, rx: 12, ry: 12, role: 'body' },
      { kind: 'eye', x: ANCHOR.x - 4.6, y: y - 1, r: 4.2 },
      { kind: 'eye', x: ANCHOR.x + 4.6, y: y - 1, r: 4.2 },
    ],
    anchor: ANCHOR,
    head: { x: ANCHOR.x, y: y - 12 },
    squash: ANCHOR.y,
    width: 24,
    height: 26,
  };
}

/** Растянуть тело вокруг точки крепления: взрослая форма крупнее на 40%. */
export function scaleShape(shape: BodyShape, k: number): BodyShape {
  const move = (x: number, y: number): Point => ({
    x: shape.anchor.x + (x - shape.anchor.x) * k,
    y: shape.anchor.y + (y - shape.anchor.y) * k,
  });
  const parts = shape.parts.map((part): Part => {
    const at = move(part.x, part.y);
    switch (part.kind) {
      case 'rrect':
        return { ...part, ...at, w: part.w * k, h: part.h * k, r: part.r * k };
      case 'ellipse':
        return { ...part, ...at, rx: part.rx * k, ry: part.ry * k };
      case 'tri':
        return { ...part, ...at, size: part.size * k };
      case 'stalk':
        return { ...part, ...at, len: part.len * k, w: part.w * k, tip: part.tip * k };
      case 'eye':
        return { ...part, ...at, r: part.r * k };
    }
  });
  return {
    parts,
    anchor: shape.anchor,
    head: move(shape.head.x, shape.head.y),
    squash: shape.squash,
    width: shape.width * k,
    height: shape.height * k,
  };
}

/** Насколько взрослая форма крупнее подростковой. */
export const GROWN_SCALE = 1.4;

/**
 * Габарит тела со всем, что из него торчит.
 *
 * Считается по частям, а не по `width`/`height`: отростки уходят выше
 * головы и вбок, и взрослая форма без этого вылезала за поле — видно на
 * каталоге, у которого срезало усики.
 */
export function boundsOf(shape: BodyShape): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number, rx: number, ry = rx): void => {
    minX = Math.min(minX, x - rx);
    maxX = Math.max(maxX, x + rx);
    minY = Math.min(minY, y - ry);
    maxY = Math.max(maxY, y + ry);
  };
  for (const part of shape.parts) {
    switch (part.kind) {
      case 'rrect':
        grow(part.x, part.y, part.w / 2, part.h / 2);
        break;
      case 'ellipse':
        grow(part.x, part.y, part.rx, part.ry);
        break;
      case 'tri':
        grow(part.x, part.y, part.size, part.size);
        break;
      case 'stalk': {
        const rad = (part.angle * Math.PI) / 180;
        grow(part.x, part.y, part.w / 2);
        grow(part.x + Math.sin(rad) * part.len, part.y - Math.cos(rad) * part.len, Math.max(part.tip, part.w / 2));
        break;
      }
      case 'eye':
        grow(part.x, part.y, part.r);
        break;
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Поле для одиночного портрета: каталог, паспорт, картинка в чат.
 *
 * В самой чашке тело живёт по своим координатам и обрезается стенкой — там
 * это правильно. А портрет обязан показывать существо целиком, и считать
 * поле каждому вызывающему заново значило бы однажды посчитать не так.
 */
export function viewBoxOf(shape: BodyShape, pad = 6): string {
  const box = boundsOf(shape);
  return `${(box.x - pad).toFixed(2)} ${(box.y - pad).toFixed(2)} ${(box.w + pad * 2).toFixed(2)} ${(box.h + pad * 2).toFixed(2)}`;
}

/** Тело существа: то, что рисует прибор. */
export function bodyOf(creature: Creature): BodyShape {
  if (creature.stage === 1) return pointBody();
  const grown = creature.stage === 3;
  const shape = yellowBody(speciesOf(creature), grown);
  return grown ? scaleShape(shape, GROWN_SCALE) : shape;
}

/** Тело вида на второй стадии — им рисуется каталог форм. */
export function bodyOfSpecies(species: Species, grown = false): BodyShape {
  const shape = yellowBody(species, grown);
  return grown ? scaleShape(shape, GROWN_SCALE) : shape;
}
