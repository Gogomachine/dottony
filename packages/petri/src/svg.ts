import type { BodyShape, Part, Point, Role } from './body.js';
import type { Skin } from './palette.js';

/**
 * Из примитивов — в фигуры SVG.
 *
 * Живёт здесь, а не в клиенте, нарочно. Тело рисуют двое: сам прибор (там
 * это узлы DOM, у которых зрачок следит за пальцем) и всякий предпросмотр —
 * каталог форм, паспорт, картинка для чата. Если перевод «примитив →
 * фигура» написать дважды, каталог однажды покажет не то, что в чашке, и
 * никто этого не заметит.
 *
 * Возвращается не разметка, а имя тега и набор атрибутов: строку из них
 * склеит тот, кому нужна строка, а клиент так же прямо создаст узлы.
 */

export interface Drawn {
  tag: 'rect' | 'ellipse' | 'circle' | 'path';
  /**
   * Из какой части тела вышла эта фигура.
   *
   * По номеру, а не по цвету. Прибор рисует глаз белым — и блик у мокрого
   * синего тоже белый; тот, кто искал глаза по белой заливке, находил вместо
   * них блики, а настоящие глаза оставались без движения и висели посреди
   * стекла сами по себе. Номер части не врёт никогда.
   */
  of: number;
  attrs: Record<string, string | number>;
}

/** Чем красить роль части. */
function paint(role: Role, skin: Skin): Record<string, string | number> {
  if (role === 'accent') return { fill: skin.accent };
  // Блик: не цвет, а свет. Он один и тот же на любом окрасе — тем и
  // читается как «мокрое», а не как «другой цвет».
  if (role === 'gloss') return { fill: '#FFFFFF', 'fill-opacity': 0.26 * skin.fillOpacity + 0.06 };
  // Подошва и тень — тот же второй цвет вполсилы: отдельной краски для них
  // заводить незачем, а на «стекле» она обязана оставаться прозрачной.
  if (role === 'shade') return { fill: skin.accent, 'fill-opacity': 0.3 * skin.fillOpacity + 0.1 };
  const body: Record<string, string | number> = { fill: skin.fill, 'fill-opacity': skin.fillOpacity };
  if (skin.stroke !== null) {
    body.stroke = skin.stroke;
    body['stroke-width'] = 2;
  }
  return body;
}

/** Треугольный скол: остриё смотрит по углу, основание — поперёк. */
function triPath(x: number, y: number, size: number, angle: number): string {
  const rad = (angle * Math.PI) / 180;
  const tip = { x: x + Math.sin(rad) * size, y: y - Math.cos(rad) * size };
  const left = { x: x + Math.sin(rad + 2.2) * size * 0.7, y: y - Math.cos(rad + 2.2) * size * 0.7 };
  const right = { x: x + Math.sin(rad - 2.2) * size * 0.7, y: y - Math.cos(rad - 2.2) * size * 0.7 };
  const at = (point: Point): string => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  return `M ${at(tip)} L ${at(left)} L ${at(right)} Z`;
}

/**
 * Куда смотрит зрачок: доля радиуса глаза в каждую сторону.
 *
 * Зрачок следит за пальцем — это единственная мимика, которая у существ
 * есть, и просить её у прибора должен тот, кто знает, где палец.
 */
export interface Gaze {
  x: number;
  y: number;
}

function drawPart(part: Part, skin: Skin, gaze: Gaze): Omit<Drawn, 'of'>[] {
  switch (part.kind) {
    case 'rrect':
      return [
        {
          tag: 'rect',
          attrs: {
            x: part.x - part.w / 2,
            y: part.y - part.h / 2,
            width: part.w,
            height: part.h,
            rx: part.r,
            ...paint(part.role, skin),
          },
        },
      ];
    case 'ellipse':
      return [
        {
          tag: 'ellipse',
          attrs: { cx: part.x, cy: part.y, rx: part.rx, ry: part.ry, ...paint(part.role, skin) },
        },
      ];
    case 'tri':
      return [
        { tag: 'path', attrs: { d: triPath(part.x, part.y, part.size, part.angle), ...paint(part.role, skin) } },
      ];
    case 'stalk': {
      const rad = (part.angle * Math.PI) / 180;
      const end = { x: part.x + Math.sin(rad) * part.len, y: part.y - Math.cos(rad) * part.len };
      const colors = paint(part.role, skin);
      const drawn: Omit<Drawn, 'of'>[] = [
        {
          tag: 'path',
          attrs: {
            d: `M ${part.x.toFixed(2)} ${part.y.toFixed(2)} L ${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
            stroke: String(colors.fill),
            'stroke-opacity': skin.fillOpacity,
            'stroke-width': part.w,
            'stroke-linecap': 'round',
            fill: 'none',
          },
        },
      ];
      if (part.tip > 0) {
        drawn.push({ tag: 'circle', attrs: { cx: end.x, cy: end.y, r: part.tip, ...colors } });
      }
      return drawn;
    }
    case 'eye': {
      // Всегда белая точка со зрачком: ни рта, ни бровей. Вся личность — в
      // тайминге моргания, а не в мимике.
      const shift = part.r * 0.34;
      return [
        { tag: 'circle', attrs: { cx: part.x, cy: part.y, r: part.r, fill: '#FFFFFF' } },
        {
          tag: 'circle',
          attrs: {
            cx: part.x + gaze.x * shift,
            cy: part.y + gaze.y * shift,
            r: part.r * 0.45,
            fill: skin.pupil,
            ...(skin.glow ? { filter: 'url(#petri-glow)' } : {}),
          },
        },
      ];
    }
  }
}

/** Всё тело фигурами, снизу вверх — порядок тот же, что и порядок частей. */
export function drawBody(shape: BodyShape, skin: Skin, gaze: Gaze = { x: 0, y: 0 }): Drawn[] {
  return shape.parts.flatMap((part, index) =>
    drawPart(part, skin, gaze).map((drawn) => ({ ...drawn, of: index })),
  );
}

/** То же самое разметкой — для каталога, паспорта и картинки в чат. */
export function bodyMarkup(shape: BodyShape, skin: Skin, gaze: Gaze = { x: 0, y: 0 }): string {
  return drawBody(shape, skin, gaze)
    .map((drawn) => {
      const attrs = Object.entries(drawn.attrs)
        .map(([name, value]) => `${name}="${typeof value === 'number' ? Number(value.toFixed(2)) : value}"`)
        .join(' ');
      return `<${drawn.tag} ${attrs} />`;
    })
    .join('');
}
