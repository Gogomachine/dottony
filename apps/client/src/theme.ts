import { readStore, writeStore } from './store';

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
const SOUND_KEY = 'doton-sound';
/** Прежний ключ: механика была настройкой одной только дуэли. */
const KIND_KEY = 'doton-duel-kind';
const DEVICE_KIND_KEY = 'doton-kind';
export function loadThemeName(): ThemeName {
  const saved = readStore(THEME_KEY);
  if (saved === 'draft' || saved === 'graphite') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'graphite' : 'draft';
}

export function applyTheme(name: ThemeName): void {
  document.documentElement.dataset.theme = name;
  writeStore(THEME_KEY, name);
}

/**
 * Метки внутри точек — режим для тех, кто не различает цвета. Выбор
 * запоминается: включать его каждый запуск было бы издевательством.
 */
export function loadMarks(): boolean {
  return readStore(MARKS_KEY) === 'on';
}

export function saveMarks(on: boolean): void {
  writeStore(MARKS_KEY, on ? 'on' : 'off');
}

/**
 * Звук прибора. По умолчанию включён: молчащий прибор — это половина
 * прибора. Выключенный запоминается — в метро его выключают один раз.
 */
export function loadSound(): boolean {
  return readStore(SOUND_KEY) !== 'off';
}

export function saveSound(on: boolean): void {
  writeStore(SOUND_KEY, on ? 'on' : 'off');
}

/**
 * Механика прибора: цепочки или заказы. Это не настройка одного экрана, а
 * положение переключателя на корпусе — от него зависят и меню, и дуэль, и
 * акцентный цвет. Запоминается: прибор должен включаться там, где его
 * выключили.
 *
 * Старый ключ читается на один раз: у тех, кто уже выбирал механику дуэли,
 * переключатель встанет в привычное положение, а не сбросится.
 */
/**
 * Во что прибор поставлен: две механики игры и пазл.
 *
 * Пазл — не третья механика: играют в нём теми же цепочками. Но игра это
 * другая — без часов, с одной доской на всех, — и спрашивать «во что я
 * сейчас играю» игрок должен в одном месте, а не в двух.
 */
export type DeviceMode = 'chain' | 'order' | 'puzzle';

/**
 * Какие положения переключателя сейчас открыты, в порядке обхода.
 *
 * Открыт один пазл. Цепочки и тап спрятаны к запуску нарочно: прибор, в
 * котором первым делом выбирают из трёх игр, объясняет себя трижды, а
 * показать его надо один раз — одной доской, одной на всех. Код обеих
 * механик жив и покрыт тестами, спрятан только вход: они открываются
 * по одной, когда в пазле станет тесно.
 *
 * Это единственное место, где они закрыты. Вернуть — вписать номер
 * обратно в этот список: меню, подписи, клавиша переключателя и правила
 * считают открытое отсюда.
 */
export const OPEN_KINDS: readonly DeviceMode[] = ['puzzle'];

/** Открыто ли положение. Закрытое не предлагается и не показывается. */
export function kindOpen(kind: DeviceMode): boolean {
  return OPEN_KINDS.includes(kind);
}

export function loadKind(): DeviceMode {
  const saved = readStore(DEVICE_KIND_KEY) ?? readStore(KIND_KEY);
  const was: DeviceMode = saved === 'order' ? 'order' : saved === 'puzzle' ? 'puzzle' : 'chain';
  // Прибор, выключенный на спрятанном положении, включается на открытом:
  // иначе он завёлся бы в режиме, которого в нём уже нет. Запомненное не
  // стираем — положение вернётся вместе с режимом.
  return kindOpen(was) ? was : (OPEN_KINDS[0] ?? 'puzzle');
}

export function saveKind(kind: DeviceMode): void {
  writeStore(DEVICE_KIND_KEY, kind);
}
