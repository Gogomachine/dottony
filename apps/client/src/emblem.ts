/**
 * Эмблема dotoscope — объектив прибора: корпус, стекло и точка под
 * наблюдением. Та же фигура, что метка на отшлифованной точке поля:
 * кольцо с точкой внутри читается и в 38 пикселей, и в 84.
 *
 * Цвета берутся из переменных темы, поэтому эмблема одинаково живёт на
 * светлом и тёмном — отдельной версии под каждую тему не нужно.
 *
 * Вариант focused — прибор навёлся: появляются штрихи прицела. Им
 * отмечаем яркие моменты, где раньше подмигивал маскот.
 */

export function emblemSvg(options: { focused?: boolean; size?: number } = {}): string {
  const { focused = false, size = 38 } = options;

  // Штрихи шкалы по краю корпуса — на четырёх сторонах.
  const ticks = [0, 90, 180, 270]
    .map(
      (angle) =>
        `<line x1="50" y1="4" x2="50" y2="12" stroke="var(--acc)" stroke-width="5"
           stroke-linecap="round" transform="rotate(${angle} 50 50)"/>`,
    )
    .join('');

  const crosshair = focused
    ? `<g stroke="var(--acc)" stroke-width="4" stroke-linecap="round" opacity="0.9">
         <line x1="22" y1="50" x2="31" y2="50"/><line x1="69" y1="50" x2="78" y2="50"/>
         <line x1="50" y1="22" x2="50" y2="31"/><line x1="50" y1="69" x2="50" y2="78"/>
       </g>`
    : '';

  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-label="dotoscope">
    ${ticks}
    <circle cx="50" cy="50" r="34" fill="none" stroke="var(--acc)" stroke-width="7"/>
    <circle cx="50" cy="50" r="27" fill="var(--scope)"/>
    ${crosshair}
    <circle cx="50" cy="50" r="${focused ? 15 : 13}" fill="var(--acc)"/>
    <path d="M33 38 A 22 22 0 0 1 47 27" fill="none" stroke="var(--case-2)"
      stroke-width="4" stroke-linecap="round" opacity="0.7"/>
  </svg>`;
}
