import type { BodyAnomaly, Creature } from './creature.js';
import type { Color, Species } from './species.js';
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

/**
 * Чем красить эту часть: телом, вторым цветом, тенью или бликом.
 *
 * Блик появился ради синих. У них ось влажности читается хуже всех — шар
 * остаётся шаром, — и им нужен второй признак: на «сыро» желейная
 * полупрозрачность, на «сухо» матовое плотное тело. Тенью такое не
 * нарисовать: тень темнит, а желе светится.
 */
export type Role = 'body' | 'accent' | 'shade' | 'gloss';

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
 * Сколы по контуру — общий для всех диалектов признак «холодного» края.
 * Куда их ставить, знает каждый диалект сам: у распластанного они вдоль
 * спины, у шара по окружности.
 */
function chips(at: readonly { x: number; y: number; size: number; angle: number }[]): Part[] {
  return at.map((chip) => ({ kind: 'tri', ...chip, role: 'body' }) as Part);
}

/**
 * Потёки: оплывший край. Начинаются **внутри** тела и стекают вниз —
 * висящие рядом кружки читались бы не как «оплыл», а как «отвалилось».
 */
function drips(x: number, y: number, w: number): Part[] {
  return [-1, 0, 1].map(
    (side) =>
      ({
        kind: 'ellipse',
        x: x + side * w * 0.3,
        y: y + (side === 0 ? 10 : 6),
        rx: 5,
        ry: side === 0 ? 13 : 9,
        role: 'body',
      }) as Part,
  );
}

/** Пятна второго цвета: ими взрослая форма и отличается от подростковой. */
function spots(x: number, y: number, w: number): Part[] {
  return [
    { kind: 'ellipse', x: x - w * 0.22, y: y + 3, rx: 4, ry: 4, role: 'accent' },
    { kind: 'ellipse', x: x + w * 0.24, y: y - 4, rx: 3, ry: 3, role: 'accent' },
  ];
}

/**
 * Жёлтый диалект: сидячий, стеблевой, широкое основание. Он прилеплен к
 * стенке стекла, и всё его тело — про опору: снизу подошва, сверху голова с
 * глазами, отростки — усики над головой.
 *
 * Отростки у него — усики над головой: у сидячего стебля им больше негде
 * расти. У остальных цветов эта же ось говорит их словами — шипами,
 * шишками и ветвями.
 */
function yellowBody(species: Species, grown: boolean, anomaly: BodyAnomaly | null): BodyShape {
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
  for (const [index, stalk] of stalks.entries()) {
    // Взрослая форма: отростки длиннее и ветвятся — это и есть «прокачанный»
    // вид, а не просто увеличенный.
    const len = stalk.len * (grown ? 1.35 : 1);
    // Кривые отростки: те же усики, но растут вкривь — аномалия видна даже
    // на голом теле, где отростков всего один.
    if (anomaly === 'crooked') stalk.angle += index % 2 === 0 ? 26 : -22;
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

  // Глаза: две белые точки со зрачком. Никаких ртов и лиц — вся личность в
  // тайминге моргания, а не в мимике. Отклонения от двух глаз — это уже
  // третий слот мутации, и других отклонений у лица не бывает.
  const eyeGap = Math.min(shape.w * 0.3, 11);
  const eyeR = shape.w > 34 ? 6 : 5.2;
  parts.push(...eyesFor(anomaly, ANCHOR.x, headY, eyeGap, eyeR, { x: crown.x, y: crown.y }));

  return {
    parts,
    anchor: ANCHOR,
    head: { x: ANCHOR.x, y: top },
    squash: ANCHOR.y,
    width: shape.w,
    height: ANCHOR.y - top,
  };
}

/**
 * Красный диалект: распластанный, с подошвой, вытянут вдоль стенки.
 *
 * Он ползает строго по периметру, всегда развёрнут вдоль края — и тело у
 * него под это: низкое, длинное, на сплошной подошве. Без этого мутация
 * «красный полез, как зелёный» не читалась бы: оба ползают, и отличить их
 * можно только по тому, как они устроены.
 *
 * Отростки у него — шипы вдоль спины: усики сверху на распластанном теле
 * смотрелись бы чужой деталью, а шип по хребту продолжает силуэт.
 */
function redBody(species: Species, grown: boolean, anomaly: BodyAnomaly | null): BodyShape {
  const { temp, humidity, medium } = species.axes;
  // Влажность растит не высоту, а пухлость: сухой — плоская лента, сырой —
  // раздутый валик. Длина при этом падает: раздуваясь, он собирается.
  const w = humidity === 0 ? 62 : humidity === 1 ? 52 : 44;
  const h = humidity === 0 ? 20 : humidity === 1 ? 28 : 36;
  const parts: Part[] = [];

  const bottom = ANCHOR.y - 4;
  const top = bottom - h;
  const midY = bottom - h / 2;

  // Подошва во всю длину: ею он и держится за стекло на ходу.
  parts.push({ kind: 'ellipse', x: ANCHOR.x, y: ANCHOR.y - 2, rx: w * 0.48, ry: 4.5, role: 'shade' });

  if (temp === 2) {
    parts.push({ kind: 'ellipse', x: ANCHOR.x, y: midY, rx: w / 2, ry: h / 2, role: 'body' });
    parts.push(...drips(ANCHOR.x, midY + h * 0.3, w * 0.7));
  } else {
    parts.push({
      kind: 'rrect',
      x: ANCHOR.x,
      y: midY,
      w,
      h,
      r: temp === 0 ? 2 : h * 0.5,
      role: 'body',
    });
  }

  if (temp === 0) {
    parts.push(
      ...chips([
        { x: ANCHOR.x - w * 0.42, y: midY, size: 8, angle: -90 },
        { x: ANCHOR.x + w * 0.46, y: midY + 2, size: 7, angle: 90 },
        { x: ANCHOR.x - w * 0.1, y: top, size: 7, angle: 0 },
      ]),
    );
  }

  // Шипы вдоль спины — ось питательной среды.
  const spines = medium === 0 ? [] : medium === 1 ? [0] : [-0.26, 0.02, 0.3];
  for (const [index, at] of spines.entries()) {
    const size = (grown ? 12 : 9) * (index === 1 ? 1.15 : 1);
    parts.push({ kind: 'tri', x: ANCHOR.x + w * at, y: top + 1, size, angle: 0, role: 'body' });
    // Взрослому шип ветвится вторым, помельче и вторым цветом.
    if (grown) {
      parts.push({
        kind: 'tri',
        x: ANCHOR.x + w * at + 4,
        y: top + 3,
        size: size * 0.55,
        angle: 26,
        role: 'accent',
      });
    }
  }

  if (humidity === 2) {
    // Раздутый: пузыри по телу — тем же приёмом, что и у жёлтого.
    for (const [dx, dy] of [
      [-0.28, -0.12],
      [0.22, 0.14],
    ] as const) {
      parts.push({ kind: 'ellipse', x: ANCHOR.x + w * dx, y: midY + h * dy, rx: 4.5, ry: 4.5, role: 'shade' });
    }
  }

  if (grown) parts.push(...spots(ANCHOR.x, midY, w * 0.8));

  // Голова у него спереди, а не сверху: он ползёт, и смотреть назад ему
  // незачем. Перед — правый край.
  const face = { x: ANCHOR.x + w * 0.2, y: midY - h * 0.1 };
  const eyeR = h > 30 ? 5.6 : 4.8;
  parts.push(...eyesFor(anomaly, face.x, face.y, eyeR * 1.7, eyeR, { x: ANCHOR.x + w * 0.34, y: top }));

  return {
    parts,
    anchor: ANCHOR,
    head: { x: ANCHOR.x + w * 0.4, y: top },
    squash: ANCHOR.y,
    width: w,
    height: ANCHOR.y - top,
  };
}

/**
 * Синий диалект: компактный, шарообразный, упругий. Он прыгает.
 *
 * У синих известная беда: ось влажности читается хуже всех — шар остаётся
 * шаром. Поэтому у них к силуэту добавлен второй признак, и он не
 * геометрический: на «сыро» тело желейное, с бликом и почти прозрачным
 * краем, на «сухо» — матовое и плотное, с жёстким тёмным ободом. Это видно
 * даже тогда, когда разница в размере не видна.
 */
function blueBody(species: Species, grown: boolean, anomaly: BodyAnomaly | null): BodyShape {
  const { temp, humidity, medium } = species.axes;
  // Сухой шар собран и вытянут вверх, сырой — расплылся вширь.
  const rx = humidity === 0 ? 19 : humidity === 1 ? 23 : 27;
  const ry = humidity === 0 ? 25 : humidity === 1 ? 23 : 21;
  const parts: Part[] = [];
  const midY = ANCHOR.y - ry - 3;

  // След на стекле: шар не стоит на подошве, но касание должно быть видно —
  // иначе он и в покое выглядит зависшим.
  parts.push({ kind: 'ellipse', x: ANCHOR.x, y: ANCHOR.y - 2, rx: rx * 0.7, ry: 3.5, role: 'shade' });

  if (temp === 0) {
    // Холодный шар — гранёный: скруглений почти нет, и по бокам сколы.
    parts.push({ kind: 'rrect', x: ANCHOR.x, y: midY, w: rx * 2, h: ry * 2, r: 3, role: 'body' });
    parts.push(
      ...chips([
        { x: ANCHOR.x - rx, y: midY - 2, size: 8, angle: -90 },
        { x: ANCHOR.x + rx, y: midY + 4, size: 7, angle: 90 },
        { x: ANCHOR.x + rx * 0.2, y: midY - ry, size: 7, angle: 0 },
      ]),
    );
  } else {
    parts.push({ kind: 'ellipse', x: ANCHOR.x, y: midY, rx, ry, role: 'body' });
    if (temp === 2) parts.push(...drips(ANCHOR.x, midY + ry * 0.55, rx * 1.4));
  }

  if (humidity === 2) {
    // Желейный: блик сверху и мягкие пузыри внутри.
    parts.push({ kind: 'ellipse', x: ANCHOR.x - rx * 0.3, y: midY - ry * 0.42, rx: rx * 0.34, ry: ry * 0.22, role: 'gloss' });
    parts.push({ kind: 'ellipse', x: ANCHOR.x + rx * 0.34, y: midY + ry * 0.24, rx: 4, ry: 4, role: 'gloss' });
  } else if (humidity === 0) {
    // Матовый и плотный: тяжёлый обод снизу, никакого блеска.
    parts.push({ kind: 'ellipse', x: ANCHOR.x, y: midY + ry * 0.5, rx: rx * 0.86, ry: ry * 0.3, role: 'shade' });
  }

  // Шишки по контуру — ось питательной среды.
  const bumps = medium === 0 ? [] : medium === 1 ? [-40] : [-70, -18, 44];
  for (const angle of bumps) {
    const rad = (angle * Math.PI) / 180;
    const size = grown ? 7 : 5.4;
    parts.push({
      kind: 'ellipse',
      x: ANCHOR.x + Math.sin(rad) * rx,
      y: midY - Math.cos(rad) * ry,
      rx: size,
      ry: size,
      role: grown ? 'accent' : 'body',
    });
  }

  if (grown) parts.push(...spots(ANCHOR.x, midY, rx * 1.5));

  const eyeR = rx > 24 ? 6.2 : 5.4;
  parts.push(...eyesFor(anomaly, ANCHOR.x, midY - ry * 0.12, eyeR * 1.6, eyeR, { x: ANCHOR.x, y: midY - ry }));

  return {
    parts,
    anchor: ANCHOR,
    head: { x: ANCHOR.x, y: midY - ry },
    // Сплющивается он вокруг точки касания: приземление давит шар в стекло.
    squash: ANCHOR.y,
    width: rx * 2,
    height: ANCHOR.y - (midY - ry),
  };
}

/**
 * Зелёный диалект: ветвящийся, цепкий, с опорными лапками. Он лазает.
 *
 * Лапки у него есть всегда, при любой среде: ими он и держится за стекло.
 * Отростки же — это ветвящиеся конечности по бокам, и от питательной среды
 * зависят именно они. Так «сколько у него лап» и «насколько он ветвист»
 * остаются разными вопросами, и ось не спорит с силуэтом.
 */
function greenBody(species: Species, grown: boolean, anomaly: BodyAnomaly | null): BodyShape {
  const { temp, humidity, medium } = species.axes;
  const w = humidity === 0 ? 22 : humidity === 1 ? 32 : 40;
  const h = humidity === 0 ? 50 : humidity === 1 ? 42 : 36;
  const parts: Part[] = [];
  const bottom = ANCHOR.y - 12;
  const top = bottom - h;
  const midY = bottom - h / 2;

  // Опорные лапки: четыре, вниз и врозь, тянутся до самого стекла.
  for (const side of [-1, 1]) {
    for (const [index, spread] of [0.26, 0.62].entries()) {
      const angle = side * (150 + index * 16);
      parts.push({
        kind: 'stalk',
        x: ANCHOR.x + side * w * spread * 0.5,
        y: bottom - 2,
        angle,
        len: 14 + index * 2,
        w: 3,
        tip: 2.6,
        role: 'body',
      });
    }
  }

  if (temp === 2) {
    parts.push({ kind: 'ellipse', x: ANCHOR.x, y: midY, rx: w / 2, ry: h / 2, role: 'body' });
    parts.push(...drips(ANCHOR.x, midY + h * 0.28, w * 0.7));
  } else {
    parts.push({
      kind: 'rrect',
      x: ANCHOR.x,
      y: midY,
      w,
      h,
      r: temp === 0 ? 2 : w * 0.42,
      role: 'body',
    });
  }

  if (temp === 0) {
    parts.push(
      ...chips([
        { x: ANCHOR.x - w / 2, y: midY - 3, size: 8, angle: -90 },
        { x: ANCHOR.x + w / 2, y: midY + 5, size: 7, angle: 90 },
        { x: ANCHOR.x + w * 0.16, y: top, size: 7, angle: 0 },
      ]),
    );
  }

  // Ветвящиеся конечности по бокам — ось питательной среды.
  const limbs = medium === 0 ? [] : medium === 1 ? [{ side: 1, at: 0.35 }] : [
    { side: -1, at: 0.28 },
    { side: 1, at: 0.46 },
    { side: -1, at: 0.68 },
  ];
  for (const limb of limbs) {
    const from = { x: ANCHOR.x + (limb.side * w) / 2, y: top + h * limb.at };
    const angle = limb.side * 68;
    const len = (grown ? 22 : 16) * (humidity === 2 ? 1.1 : 1);
    parts.push({ kind: 'stalk', x: from.x, y: from.y, angle, len, w: 3.2, tip: 0, role: 'body' });
    const fork = step(from, angle, len);
    for (const turn of [-30, 26]) {
      parts.push({
        kind: 'stalk',
        x: fork.x,
        y: fork.y,
        angle: angle + turn,
        len: len * 0.5,
        w: 2.4,
        tip: 2.6,
        role: grown ? 'accent' : 'body',
      });
    }
  }

  if (humidity === 2) {
    for (const [dx, dy] of [
      [-0.3, -0.18],
      [0.26, 0.2],
    ] as const) {
      parts.push({ kind: 'ellipse', x: ANCHOR.x + w * dx, y: midY + h * dy, rx: 4.5, ry: 4.5, role: 'shade' });
    }
  }

  if (grown) parts.push(...spots(ANCHOR.x, midY, w));

  const eyeR = w > 34 ? 6 : 5.2;
  const face = top + h * 0.26;
  parts.push(...eyesFor(anomaly, ANCHOR.x, face, Math.min(w * 0.3, 10), eyeR, { x: ANCHOR.x, y: top }));

  return {
    parts,
    anchor: ANCHOR,
    head: { x: ANCHOR.x, y: top },
    squash: ANCHOR.y,
    width: w,
    height: ANCHOR.y - top,
  };
}

/**
 * Диалекты по цветам. Оснастка у всех одна — крепление снизу, голова
 * сверху, — и потому любое тело подставляется в любой цикл движения: это
 * обязательное условие мутации поведения, и держится оно здесь.
 */
const DIALECTS: Record<Color, (species: Species, grown: boolean, anomaly: BodyAnomaly | null) => BodyShape> = {
  yellow: yellowBody,
  red: redBody,
  blue: blueBody,
  green: greenBody,
};

/**
 * Глаза по аномалии тела.
 *
 * Слот аномалии — всегда про глаза или отростки, и рисовать его надо здесь,
 * а не «когда-нибудь потом»: мутация, которой не видно, не мутация, а запись
 * в базе. Первое же обещанное скрещивание выдаёт её новому игроку — и он
 * обязан её увидеть.
 */
function eyesFor(
  anomaly: BodyAnomaly | null,
  cx: number,
  y: number,
  gap: number,
  r: number,
  crown: Point,
): Part[] {
  if (anomaly === 'one-eye') {
    return [{ kind: 'eye', x: cx, y, r: r * 1.35 }];
  }
  if (anomaly === 'third-eye') {
    return [
      { kind: 'eye', x: cx - gap, y, r },
      { kind: 'eye', x: cx + gap, y, r },
      // Третий — выше и меньше: два глаза остаются лицом, а третий читается
      // как лишний, а не как перестроенное лицо.
      { kind: 'eye', x: cx, y: y - r * 2, r: r * 0.7 },
    ];
  }
  if (anomaly === 'stalk-eyes') {
    // Глаза уезжают на стебельки над головой — тело при этом то же самое.
    const parts: Part[] = [];
    for (const side of [-1, 1]) {
      const angle = side * 16;
      const tip = step(crown, angle, 16);
      parts.push({
        kind: 'stalk',
        x: crown.x,
        y: crown.y,
        angle,
        len: 16,
        w: 2.6,
        tip: 0,
        role: 'body',
      });
      parts.push({ kind: 'eye', x: tip.x, y: tip.y, r: r * 0.85 });
    }
    return parts;
  }
  return [
    { kind: 'eye', x: cx - gap, y, r },
    { kind: 'eye', x: cx + gap, y, r },
  ];
}

/**
 * Точка первой стадии: тот же окрас, те же глаза — и всё.
 *
 * Крупная нарочно. Точка — это не зародыш под микроскопом, а первое, что
 * игрок видит в своём приборе, и полсуток он смотрит именно на неё. Мелкая
 * точка в большом стекле читается как сор, а не как культура.
 */
function pointBody(anomaly: BodyAnomaly | null = null): BodyShape {
  const y = ANCHOR.y - 22;
  return {
    parts: [
      { kind: 'ellipse', x: ANCHOR.x, y, rx: 20, ry: 20, role: 'body' },
      // Аномалия видна уже у точки: она достаётся по родству, а не растёт
      // вместе с телом, и прятать её до второй стадии значило бы отнимать у
      // игрока ровно тот миг, ради которого он скрещивал.
      ...eyesFor(anomaly, ANCHOR.x, y - 1, 7.6, 7, { x: ANCHOR.x, y: y - 20 }),
    ],
    anchor: ANCHOR,
    head: { x: ANCHOR.x, y: y - 20 },
    squash: ANCHOR.y,
    width: 40,
    height: 42,
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
  const species = speciesOf(creature);
  // Точка — это точка: пока форма не выбрана, рисовать нечего, кроме глаз.
  if (creature.stage === 1 || species === null) return pointBody(creature.bodyAnomaly);
  const grown = creature.stage === 3;
  const shape = DIALECTS[species.color](species, grown, creature.bodyAnomaly);
  return grown ? scaleShape(shape, GROWN_SCALE) : shape;
}

/** Тело вида на второй стадии — им рисуется каталог форм. */
export function bodyOfSpecies(species: Species, grown = false): BodyShape {
  const shape = DIALECTS[species.color](species, grown, null);
  return grown ? scaleShape(shape, GROWN_SCALE) : shape;
}
