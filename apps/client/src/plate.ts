import { cleanMarks, isFrame, markById, MARK_SLOTS, type Mark } from '@doton/core';

/**
 * Шильдики на корпусе: выбор игрока и его отрисовка.
 *
 * Выбор держим и у себя, и на сервере. На сервере — потому что его видит
 * соперник; у себя — потому что корпус рисуется до всякого входа, и пустая
 * полоса на первом экране была бы обиднее, чем расхождение на один заход.
 */

const KEY = 'doton.marks.v1';
const FRAME_KEY = 'doton.frame.v1';

export function loadPlate(): (string | null)[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return cleanMarks(Array.isArray(parsed) ? (parsed as (string | null)[]) : []);
  } catch {
    // Приватный режим или мусор в хранилище — корпус просто пустой.
    return cleanMarks([]);
  }
}

/**
 * Своя оправа. Держим её рядом с шильдиками и по той же причине: корпус
 * рисуется до всякого входа, и полоса не должна на секунду терять оправу
 * при каждом запуске.
 */
export function loadFrame(): string | null {
  try {
    const saved = localStorage.getItem(FRAME_KEY);
    return saved !== null && isFrame(saved) ? saved : null;
  } catch {
    return null;
  }
}

export function saveFrame(frame: string | null): void {
  try {
    if (frame === null) localStorage.removeItem(FRAME_KEY);
    else localStorage.setItem(FRAME_KEY, frame);
  } catch {
    // Не сохранилось — на сервере всё равно останется.
  }
}

export function savePlate(marks: (string | null)[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cleanMarks(marks)));
  } catch {
    // Не сохранилось — на сервере всё равно останется.
  }
}

/**
 * Один шильдик. Отметка за игру — краска по корпусу, наклейка — картинка на
 * белом квадратике: он и делает из неё часть предмета, а не значок поверх.
 */
export function markChip(mark: Mark): HTMLElement {
  const chip = document.createElement('i');
  chip.className = `mark ${mark.kind}`;
  if (mark.art === undefined) {
    chip.textContent = mark.glyph;
    return chip;
  }
  // Своя картинка вместо знака. Адрес собираем здесь, а не в каталоге:
  // на GitHub Pages сайт живёт по подпути, и путь от корня туда не ведёт.
  const art = document.createElement('img');
  art.className = 'art';
  art.src = `${import.meta.env.BASE_URL}marks/${mark.art}`;
  // Наклейка — это украшение, а не сообщение: читалке про неё сказать нечего.
  art.alt = '';
  art.draggable = false;
  chip.appendChild(art);
  return chip;
}

/**
 * Перерисовывает полосу шильдиков. Пустые ячейки не рисуются вовсе.
 *
 * Имя перед набором ставится, когда корпус чужой: без него непонятно,
 * чьи это шильдики, а повторять их потом рядом с именем — уже перебор.
 */
export function showPlate(
  host: HTMLElement,
  marks: (string | null)[],
  who: string | null = null,
  frame: string | null = null,
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
    if (mark) host.appendChild(markChip(mark));
  }
}
