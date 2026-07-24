/** Цвета, которые нужны Canvas-рендереру (интерфейс красится через CSS-переменные). */
export interface Theme {
  name: 'draft' | 'graphite';
  dots: [string, string, string, string];
  board: string;
  gridLine: string;
  chainOutline: string;
  insulator: string;
  insulatorBorder: string;
}

export const THEMES: Record<Theme['name'], Theme> = {
  draft: {
    name: 'draft',
    dots: ['#D9483B', '#2F7FD1', '#DFA92E', '#2F9E68'],
    board: '#FAFBFC',
    gridLine: 'rgba(47, 79, 110, 0.08)',
    chainOutline: 'rgba(255, 255, 255, 0.75)',
    insulator: '#AEB9C6',
    insulatorBorder: '#7D8A99',
  },
  graphite: {
    name: 'graphite',
    dots: ['#E05E51', '#4C9EE3', '#E8B44C', '#55B584'],
    board: '#1A1D22',
    gridLine: 'rgba(201, 146, 92, 0.09)',
    chainOutline: 'rgba(230, 228, 223, 0.4)',
    insulator: '#3C424C',
    insulatorBorder: '#5A626E',
  },
};

const STORAGE_KEY = 'doton-theme';

export function loadThemeName(): Theme['name'] {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'draft' || saved === 'graphite') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'graphite' : 'draft';
}

export function applyTheme(name: Theme['name']): Theme {
  document.documentElement.dataset.theme = name;
  localStorage.setItem(STORAGE_KEY, name);
  return THEMES[name];
}
