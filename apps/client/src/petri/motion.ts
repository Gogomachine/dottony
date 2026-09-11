import type { Behaviour } from '@doton/petri';

/**
 * Четыре цикла движения — по одному на поведение.
 *
 * Цикл принадлежит **поведению, а не телу**: любой из ста восьми корпусов
 * подставляется в любой из четырёх циклов без переделки. На этом стоит вся
 * мутация поведения — жёлтый стебель, поползший по стенке, остаётся
 * стеблем и тащит себя, потому что не приспособлен, и в этом весь её
 * визуальный эффект.
 *
 * Здесь только счёт: куда поставить крепление, на сколько повернуть корпус
 * и насколько его сплющить. Что именно повернётся, цикл не знает и знать
 * не должен.
 */

/** Где и как стоит тело в этот миг. */
export interface Pose {
  x: number;
  y: number;
  /** Поворот корпуса: ноль — «вверх», как нарисовано. */
  turn: number;
  /** Сжатие: по ширине и по высоте. Единица — тело как есть. */
  sx: number;
  sy: number;
}

export interface Glass {
  w: number;
  h: number;
}

/**
 * Насколько подошва утоплена в стенку.
 *
 * Ровно вплотную было бы честно, но покачивание поворачивает тело вокруг
 * крепления, и на каждом взмахе подошва отрывалась бы от стекла на волос —
 * а это и читается как «висит в воздухе».
 */
const BITE = 1.2;

/** Скорость ползущего по краю, делений стекла в секунду. */
const CRAWL_SPEED = 7;

/** Прыжок: сколько длится и на какую высоту. */
const HOP_TIME = 1.7;
const HOP_HEIGHT = 26;

/** Мягкий разброс от номера существа: соседи не должны ходить в ногу. */
function offset(seed: number, spread: number): number {
  return ((seed % 1000) / 1000) * spread;
}

/**
 * Прямоугольник, по которому ходит крепление.
 *
 * Он не совпадает со стеклом: тело торчит ниже крепления на `below`, и
 * ровно на столько же дорожку надо отвести от края, чтобы подошва села на
 * стекло, а не в него.
 */
function track(glass: Glass, edge: number, below: number): { x: number; y: number; w: number; h: number } {
  const inset = edge + below - BITE;
  return { x: inset, y: inset, w: glass.w - inset * 2, h: glass.h - inset * 2 };
}

/**
 * Точка на скруглённом прямоугольнике по длине дуги.
 *
 * Углы скруглены нарочно: на остром углу направление хода меняется
 * мгновенно, и ползущий по краю разворачивался бы рывком на девяносто
 * градусов. По дуге он поворачивается так же, как поворачивал бы живой.
 */
function onTrack(box: { x: number; y: number; w: number; h: number }, s: number): { x: number; y: number } {
  const r = Math.min(12, box.w / 2, box.h / 2);
  const straightX = box.w - 2 * r;
  const straightY = box.h - 2 * r;
  const arc = (Math.PI * r) / 2;
  const total = 2 * (straightX + straightY) + 4 * arc;
  let at = ((s % total) + total) % total;

  // Низ слева направо, затем правый бок вверх, верх справа налево, левый вниз.
  if (at < straightX) return { x: box.x + r + at, y: box.y + box.h };
  at -= straightX;
  if (at < arc) {
    const a = (at / arc) * (Math.PI / 2);
    return { x: box.x + box.w - r + Math.sin(a) * r, y: box.y + box.h - r + Math.cos(a) * r };
  }
  at -= arc;
  if (at < straightY) return { x: box.x + box.w, y: box.y + box.h - r - at };
  at -= straightY;
  if (at < arc) {
    const a = (at / arc) * (Math.PI / 2);
    return { x: box.x + box.w - r + Math.cos(a) * r, y: box.y + r - Math.sin(a) * r };
  }
  at -= arc;
  if (at < straightX) return { x: box.x + box.w - r - at, y: box.y };
  at -= straightX;
  if (at < arc) {
    const a = (at / arc) * (Math.PI / 2);
    return { x: box.x + r - Math.sin(a) * r, y: box.y + r - Math.cos(a) * r };
  }
  at -= arc;
  if (at < straightY) return { x: box.x, y: box.y + r + at };
  at -= straightY;
  const a = (at / arc) * (Math.PI / 2);
  return { x: box.x + r - Math.cos(a) * r, y: box.y + box.h - r + Math.sin(a) * r };
}

/** Угол хода в градусах: ноль — вверх, по часовой стрелке. */
function heading(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return (Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI;
}

/** Всё, что циклу нужно знать про стекло и про тело в нём. */
export interface Walk {
  glass: Glass;
  edge: number;
  /** Насколько тело торчит ниже крепления: им оно садится на стенку. */
  below: number;
  /**
   * Половина ширины тела. Нужна тем, кто не липнет к стенке: свободно
   * идущий упирается в стену боком, а не подошвой, и без этого зелёный
   * наполовину уезжал за край.
   */
  wide: number;
  seed: number;
}

export function poseOf(behaviour: Behaviour, time: number, walk: Walk): Pose {
  const { glass, edge, below, wide, seed } = walk;
  const box = track(glass, edge, below);

  if (behaviour === 'cling') {
    // Прилип к стенке и колышется. Два несоразмерных периода — чтобы
    // качание не превратилось в маятник.
    const sway = Math.sin(time * 1.1) * 3.2 + Math.sin(time * 0.37) * 1.4;
    return { x: box.x, y: glass.h * 0.38, turn: 90 + sway, sx: 1, sy: 1 };
  }

  if (behaviour === 'crawl-edge') {
    /*
     * Ползёт строго по периметру, всегда развёрнут вдоль стенки. Строго —
     * это не придирка: без привязки к краю мутация «красный полез, как
     * зелёный» не читалась бы вовсе, оба ведь ползают.
     *
     * Корпус разворачивается по касательной: «низ» тела смотрит в стенку,
     * и потому поворот — это направление хода минус прямой угол.
     */
    const s = time * CRAWL_SPEED + offset(seed, 200);
    const at = onTrack(box, s);
    const next = onTrack(box, s + 0.6);
    // Волна по телу: ползущий не едет, а перебирает собой.
    const wave = Math.sin(time * 6.2) * 0.05;
    return { ...at, turn: heading(at, next) - 90, sx: 1 + wave, sy: 1 - wave };
  }

  if (behaviour === 'bounce') {
    /*
     * Прыгает и отскакивает от стенок. Высота — парабола, а не синус: у
     * синуса нет удара, а вся суть прыжка в том, что он кончается.
     */
    const period = HOP_TIME;
    const phase = ((time + offset(seed, period)) % period) / period;
    const hop = 4 * phase * (1 - phase);
    // Ход вбок с отскоком от стенок: маятник по треугольной волне. Боком
    // он и упирается в стену, поэтому дорожка сужена на полтела.
    const left = Math.max(box.x, edge + wide);
    const span = Math.max(4, Math.min(box.x + box.w, glass.w - edge - wide) - left);
    const swing = ((time * 9 + offset(seed, span * 2)) % (span * 2)) / span;
    const x = left + (swing < 1 ? swing : 2 - swing) * span;
    // Сплющивание — только у земли, и тем сильнее, чем ближе касание.
    const land = Math.max(0, 1 - hop * 6);
    return {
      x,
      y: box.y + box.h - hop * HOP_HEIGHT,
      turn: 0,
      sx: 1 + land * 0.16,
      sy: 1 - land * 0.16,
    };
  }

  /*
   * Лазает по всему стеклу. Путь — две несоразмерные волны: он не
   * повторяется на глазах и не выглядит ни кругом, ни строкой.
   */
  const t = time * 0.42 + offset(seed, 20);
  // Он ходит по всему стеклу и ни к чему не липнет — значит, упирается в
  // стены боком и макушкой, а не подошвой: поле сужаем на полтела.
  const free = {
    x: edge + wide,
    y: box.y,
    w: Math.max(6, glass.w - 2 * (edge + wide)),
    h: box.h,
  };
  const walkAt = (phase: number): { x: number; y: number } => ({
    x: free.x + free.w * (0.5 + 0.42 * Math.sin(phase)),
    y: free.y + free.h * (0.5 + 0.36 * Math.sin(phase * 1.37 + 1.1)),
  });
  const { x, y } = walkAt(t);
  const next = walkAt(t + 0.08);
  // Наклоняется в сторону хода, но не заваливается: он цепкий, а не падает.
  const lean = Math.max(-24, Math.min(24, heading({ x, y }, next) * 0.12));
  // Перебор лапок виден лёгкой поступью: тело идёт вверх-вниз в такт шагам.
  const step = Math.sin(time * 5.4) * 0.03;
  return { x, y, turn: lean, sx: 1 - step, sy: 1 + step };
}
