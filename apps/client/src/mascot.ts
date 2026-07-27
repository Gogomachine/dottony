/**
 * Заппо — маскот-молния. Рисуется кодом по референс-стикерам:
 * оранжевая молния с коричневым контуром, большие глаза, румянец.
 * Вариант wink — подмигивает (перегрузка, финиш вызова дня).
 */

/** Контур молнии, обход по часовой от верхней вершины. */
const BODY = '54.7,4.9 24.4,50.4 43.9,50.4 34.8,94.7 75.2,44.5 62.1,44.5';
const FILL = '#F2A93F';
const OUTLINE = '#8A4A15';
const BLUSH = '#E08636';

export function mascotSvg(options: { wink?: boolean; size?: number } = {}): string {
  const { wink = false, size = 38 } = options;

  const rightEye = wink
    ? `<path d="M50.5 32.5 Q55.5 28.8 60 33" fill="none" stroke="${OUTLINE}"
         stroke-width="2.6" stroke-linecap="round"/>`
    : `<circle cx="55.4" cy="34.6" r="5.6" fill="#fff" stroke="${OUTLINE}" stroke-width="2"/>
       <circle cx="56.4" cy="35.4" r="2.7" fill="#3B2207"/>
       <circle cx="57.4" cy="34.2" r="1" fill="#fff"/>`;

  // Управляющая точка уведена ниже самой дуги: кривая Безье проходит
  // примерно посередине к ней, поэтому такой прогиб даёт заметную улыбку.
  const smile = wink
    ? `<path d="M43.5 42 Q51.5 57 59.5 41" fill="none" stroke="${OUTLINE}"
         stroke-width="3.2" stroke-linecap="round"/>`
    : `<path d="M45 43 Q51.5 54.2 58 42.5" fill="none" stroke="${OUTLINE}"
         stroke-width="3" stroke-linecap="round"/>`;

  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-label="Заппо">
    <polygon points="${BODY}" fill="${FILL}" stroke="${OUTLINE}"
      stroke-width="5.5" stroke-linejoin="round"/>
    <ellipse cx="38.6" cy="41.4" rx="3.6" ry="2.3" fill="${BLUSH}"/>
    <ellipse cx="59.8" cy="40.6" rx="3.6" ry="2.3" fill="${BLUSH}"/>
    <circle cx="45.2" cy="35.6" r="5.6" fill="#fff" stroke="${OUTLINE}" stroke-width="2"/>
    <circle cx="46.2" cy="36.4" r="2.7" fill="#3B2207"/>
    <circle cx="47.2" cy="35.2" r="1" fill="#fff"/>
    ${rightEye}
    ${smile}
  </svg>`;
}
