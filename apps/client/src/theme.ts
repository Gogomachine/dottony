/**
 * Цвета окуляра. Стекло прибора всегда чёрное — светлеет и темнеет только
 * корпус, а он рисуется CSS-переменными. Поэтому у канваса одна палитра на
 * обе темы, и переключатель света её не трогает.
 */
export interface Theme {
  dots: [string, string, string, string];
  board: string;
  gridLine: string;
  chainOutline: string;
}

export const SCOPE: Theme = {
  dots: ['#E3AE45', '#3F9C79', '#D9584A', '#4589C4'],
  board: '#0C0D0E',
  gridLine: '#1D1E1D',
  chainOutline: 'rgba(237, 234, 227, 0.55)',
};

export type ThemeName = 'draft' | 'graphite';

const THEME_KEY = 'doton-theme';
const MARKS_KEY = 'doton-marks';

export function loadThemeName(): ThemeName {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'draft' || saved === 'graphite') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'graphite' : 'draft';
}

export function applyTheme(name: ThemeName): void {
  document.documentElement.dataset.theme = name;
  localStorage.setItem(THEME_KEY, name);
}

/**
 * Метки внутри точек — режим для тех, кто не различает цвета. Выбор
 * запоминается: включать его каждый запуск было бы издевательством.
 */
export function loadMarks(): boolean {
  return localStorage.getItem(MARKS_KEY) === 'on';
}

export function saveMarks(on: boolean): void {
  localStorage.setItem(MARKS_KEY, on ? 'on' : 'off');
}
