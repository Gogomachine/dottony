import { cleanMarks, markById, MARK_SLOTS, type Mark } from '@doton/core';

/**
 * Шильдики на корпусе: выбор игрока и его отрисовка.
 *
 * Выбор держим и у себя, и на сервере. На сервере — потому что его видит
 * соперник; у себя — потому что корпус рисуется до всякого входа, и пустая
 * полоса на первом экране была бы обиднее, чем расхождение на один заход.
 */

const KEY = 'doton.marks.v1';

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

export function savePlate(marks: (string | null)[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cleanMarks(marks)));
  } catch {
    // Не сохранилось — на сервере всё равно останется.
  }
}

/**
 * Один шильдик. Служебный — набитая на корпусе краска, наклейка — смайл на
 * белом квадратике: рамка и делает из чужого смайла часть предмета.
 */
export function markChip(mark: Mark): HTMLElement {
  const chip = document.createElement('i');
  // Класс не совпадает с названием вида нарочно: `plate` на корпусе уже
  // занят самой полосой шильдика, и стиль полосы налез бы на значок.
  const look = mark.kind === 'plate' ? 'tag' : mark.kind;
  chip.className = `mark ${look}`;
  chip.textContent = mark.glyph;
  return chip;
}

/** Перерисовывает полосу шильдиков. Пустые ячейки не рисуются вовсе. */
export function showPlate(host: HTMLElement, marks: (string | null)[]): void {
  host.innerHTML = '';
  for (const id of marks.slice(0, MARK_SLOTS)) {
    if (id === null) continue;
    const mark = markById(id);
    if (mark) host.appendChild(markChip(mark));
  }
}
