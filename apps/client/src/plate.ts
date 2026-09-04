import {
  ART_PAINTS,
  ART_SIZE,
  cleanMarks,
  decodeArt,
  isArt,
  isFrame,
  isOwnMark,
  markById,
  MARK_SLOTS,
  type Mark,
} from '@doton/core';
import { dropStore, readStore, writeStore } from './store';

/**
 * Шильдики на корпусе: выбор игрока и его отрисовка.
 *
 * Выбор держим и у себя, и на сервере. На сервере — потому что его видит
 * соперник; у себя — потому что корпус рисуется до всякого входа, и пустая
 * полоса на первом экране была бы обиднее, чем расхождение на один заход.
 */

const KEY = 'doton.marks.v1';
const FRAME_KEY = 'doton.frame.v1';
const ART_KEY = 'doton.own-art.v1';

export function loadPlate(): (string | null)[] {
  try {
    const raw = readStore(KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return cleanMarks(Array.isArray(parsed) ? (parsed as (string | null)[]) : []);
  } catch {
    // Мусор в записи — корпус просто пустой. За само хранилище отвечает
    // память прибора: она не бросает, что бы браузер ни запретил.
    return cleanMarks([]);
  }
}

/**
 * Своя оправа. Держим её рядом с шильдиками и по той же причине: корпус
 * рисуется до всякого входа, и полоса не должна на секунду терять оправу
 * при каждом запуске.
 */
export function loadFrame(): string | null {
  const saved = readStore(FRAME_KEY);
  return saved !== null && isFrame(saved) ? saved : null;
}

export function saveFrame(frame: string | null): void {
  if (frame === null) dropStore(FRAME_KEY);
  else writeStore(FRAME_KEY, frame);
}

/**
 * Свой рисунок, поставленный на пропуск. Держим рядом с шильдиками и по той
 * же причине: корпус рисуется до всякого входа, и шильдик не должен на
 * секунду становиться пустым при каждом запуске. Это не лист — лист живёт
 * отдельно и меняется свободно; здесь лежит только то, что игрок на пропуск
 * поставил.
 */
export function loadArt(): string | null {
  const saved = readStore(ART_KEY);
  return saved !== null && isArt(saved) ? saved : null;
}

export function saveArt(art: string | null): void {
  if (art === null) dropStore(ART_KEY);
  else writeStore(ART_KEY, art);
}

export function savePlate(marks: (string | null)[]): void {
  writeStore(KEY, JSON.stringify(cleanMarks(marks)));
}

/**
 * Свой шильдик: тот же лист, только величиной с ноготь. Рисуем его теми же
 * кружками на том же тёмном стекле — на пропуске это должно узнаваться как
 * своё поле, а не как непонятная мозаика. Сетки здесь нет: в тринадцати
 * точках она слилась бы с рисунком.
 *
 * Пустая клетка не рисуется вовсе — на её месте стекло, ровно как на листе.
 */
export function artPicture(art: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${ART_SIZE} ${ART_SIZE}`);
  svg.setAttribute('class', 'art');
  // Картинка — украшение, а не сообщение: читалке про неё сказать нечего.
  svg.setAttribute('aria-hidden', 'true');
  const cells = decodeArt(art);
  for (let r = 0; r < ART_SIZE; r++) {
    for (let c = 0; c < ART_SIZE; c++) {
      const paint = cells[r]?.[c];
      const css = paint === null || paint === undefined ? undefined : ART_PAINTS[paint]?.css;
      if (css === undefined) continue;
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', String(c + 0.5));
      dot.setAttribute('cy', String(r + 0.5));
      // Та же доля клетки, что у точки на поле и на листе.
      dot.setAttribute('r', '0.41');
      dot.setAttribute('fill', css);
      svg.appendChild(dot);
    }
  }
  return svg;
}

/**
 * Один шильдик. Отметка за игру — краска по корпусу, наклейка — картинка на
 * кусочке тёмного стекла: он и делает из неё часть прибора, а не значок
 * поверх него. Свой рисунок стоит на таком же стекле — он и есть картинка.
 *
 * Картинку своего шильдика передают отдельно от номера: номер у него один
 * на всех, а нарисован он у каждого свой. Без картинки остаётся надпись —
 * так выглядит купленный, но ещё не нарисованный.
 */
export function markChip(mark: Mark, art: string | null = null): HTMLElement {
  const chip = document.createElement('i');
  chip.className = `mark ${mark.kind}`;
  if (isOwnMark(mark.id)) {
    if (art === null) chip.textContent = mark.glyph;
    else chip.appendChild(artPicture(art));
    return chip;
  }
  if (mark.art === undefined) {
    chip.textContent = mark.glyph;
    return chip;
  }
  // Своя картинка вместо знака. Адрес собираем здесь, а не в каталоге:
  // на GitHub Pages сайт живёт по подпути, и путь от корня туда не ведёт.
  const picture = document.createElement('img');
  picture.className = 'art';
  picture.src = `${import.meta.env.BASE_URL}marks/${mark.art}`;
  // Наклейка — это украшение, а не сообщение: читалке про неё сказать нечего.
  picture.alt = '';
  picture.draggable = false;
  chip.appendChild(picture);
  return chip;
}

/**
 * Перерисовывает полосу шильдиков. Пустые ячейки не рисуются вовсе.
 *
 * Имя перед набором ставится, когда корпус чужой: без него непонятно,
 * чьи это шильдики, а повторять их потом рядом с именем — уже перебор.
 *
 * Рисунок — свойство хозяина полосы, как и оправа: в матче полосу занимает
 * соперник, и на своём шильдике у него нарисовано своё.
 */
export function showPlate(
  host: HTMLElement,
  marks: (string | null)[],
  who: string | null = null,
  frame: string | null = null,
  art: string | null = null,
): void {
  host.innerHTML = '';
  // Оправа — свойство полосы, а не шильдиков в ней: в матче полосу занимает
  // соперник, и оправа на ней должна быть его.
  for (const name of [...host.classList]) {
    if (name.startsWith('f-')) host.classList.remove(name);
  }
  host.classList.toggle('framed', frame !== null && isFrame(frame));
  if (frame !== null && isFrame(frame)) host.classList.add(frame);
  if (who !== null) {
    const label = document.createElement('b');
    label.className = 'who';
    label.textContent = who;
    host.appendChild(label);
  }
  for (const id of marks.slice(0, MARK_SLOTS)) {
    if (id === null) continue;
    const mark = markById(id);
    if (mark) host.appendChild(markChip(mark, art));
  }
}
