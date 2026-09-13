import {
  DIALS,
  SCALE,
  behaviourOf,
  bodyOf,
  boundsOf,
  seedOf,
  drawBody,
  HATCH_HOURS,
  mutationCount,
  skinOf,
  speciesId,
  speciesOf,
  viewBoxOf,
  type BodyShape,
  type Creature,
  type Behaviour,
  type Dial,
  type Dials,
  type Hint,
  type LabView,
} from '@doton/petri';
import { lidOf, poseOf, type Pose } from './motion';

/**
 * PETRIDOT в окуляре: чашка Петри, три тумблера и два стекла хранения.
 *
 * Экран знает про правила ровно столько, сколько нужно, чтобы рисовать:
 * тела собираются из примитивов тем же кодом, что и каталог форм, а всё,
 * что решает игру — форма при вылуплении, комфорт, рост, гибель,
 * скрещивание, — считает сервер. Здесь нет ни одной ручки, которая двигала
 * бы день: перевод часов на телефоне лабораторию не касается.
 */

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

const SVG = 'http://www.w3.org/2000/svg';

function svgNode<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

/** Подписи тумблеров. Порядок сверху вниз — тот же, что на корпусе. */
const DIAL_NAME: Record<Dial, string> = {
  temp: 'Температура',
  humidity: 'Влажность',
  medium: 'Среда',
};

/**
 * Что говорит стрелка. Сторону — да, число — никогда: «теплее» это совет, а
 * «поставь 640» — ответ, после которого ухаживать больше не за чем.
 */
/**
 * Ось ручки в её собственных координатах.
 *
 * Одно число на всё: и рисование риски, и её поворот. Пока их было два —
 * шайба рисовалась вокруг 32, а риска вращалась вокруг 30, — стрелка
 * ходила по кругу мимо центра, и три одинаково выставленных тумблера
 * выглядели повёрнутыми в разные стороны.
 */
const KNOB = 32;

/** Цвет ручки: тумблер узнают рукой, не читая подпись. */
const DIAL_COLOR: Record<Dial, string> = {
  temp: '#c8503a',
  humidity: '#3f86c9',
  medium: '#86a93f',
};

/** «12 часов», «24 часа», «21 час» — прибор говорит по-русски. */
function hoursSaid(hours: number): string {
  const last = hours % 10;
  const two = hours % 100;
  if (two >= 11 && two <= 14) return `${hours} часов`;
  if (last === 1) return `${hours} час`;
  if (last >= 2 && last <= 4) return `${hours} часа`;
  return `${hours} часов`;
}

const HINT_NAME: Record<Hint, string> = {
  less: '◀ убавить',
  more: 'прибавить ▶',
  near: 'рядом',
  fits: 'в норме',
};

/** Состояние культуры — словами прибора, по одному признаку за раз. */
const MOOD_NAME: Record<string, string> = {
  fine: 'штатный цикл',
  cold: 'жмётся к краю — холодно',
  hot: 'вяло — жарко',
  dry: 'тускнеет — сухо',
  wet: 'разбухает — сыро',
  thin: 'среда бедна',
  rich: 'среда густа',
  hungry: 'голод',
  stuffed: 'перекорм',
};

/**
 * Где существо сидит под стеклом.
 *
 * Стекло квадратное, и у него есть пол и стенки. Жёлтый прилеплен к
 * стенке — это его поведение, а не украшение: без привязки к краю мутация
 * «жёлтый пополз, как красный» не читалась бы вовсе. Точка не прилеплена
 * ни к чему: она просто лежит на дне, прилипать — это уже поведение, а
 * поведение появляется вместе с телом.
 */
const GLASS_W = 100;
/** Внутренний край стекла: за него культура не заходит. */
const EDGE = 3;
/**
 * Насколько подошва утоплена в стенку.
 *
 * Ровно вплотную было бы честно, но покачивание поворачивает тело вокруг
 * крепления, и на каждом взмахе подошва отрывалась бы от стекла на волос —
 * а это ровно то, что читается как «висит в воздухе». Утопленная на волос
 * подошва держится всегда.
 */
const BITE = 1.2;
/** Доля высоты, на которой прилипший держится за стенку. */
const WALL = { at: 0.38, turn: 90 };
const FLOOR = { x: 52, turn: 0 };

/** Куда смотрит существо в маленьком стекле: там оно просто стоит. */
function portrait(creature: Creature): SVGSVGElement {
  const shape = bodyOf(creature);
  const svg = svgNode('svg', { viewBox: viewBoxOf(shape, 8) });
  for (const drawn of drawBody(shape, skinOf(creature))) {
    svg.appendChild(svgNode(drawn.tag, drawn.attrs));
  }
  return svg;
}

/** Имя формы для подписи: `yellow-201` читается человеком и в чате тоже. */
function nameOf(creature: Creature): string {
  const species = speciesOf(creature);
  const mutations = mutationCount(creature);
  const mark = mutations > 0 ? ` · ${'✳'.repeat(mutations)}` : '';
  return `${species === null ? 'точка' : speciesId(species)} · G${creature.generation}${mark}`;
}

export interface LabHandlers {
  seed(): Promise<LabView>;
  dials(dials: Dials): Promise<LabView>;
  feed(): Promise<LabView>;
  store(): Promise<LabView>;
  shelf(id: string): Promise<LabView>;
  breed(): Promise<LabView>;
  tell(on: boolean): Promise<LabView>;
  load(): Promise<LabView>;
  /** Что показать в приборной строке и в панели режима. */
  panel(state: {
    line: string;
    /** Что делать прямо сейчас — строкой под именем в панели режима. */
    note: string;
    day: string;
    grow: string;
    tokens: number;
    slots: string;
    /** Состояние напоминания — словом в той же строке, что его включает. */
    tell: string;
    /**
     * Номер образца в подвал корпуса. У лаборатории образец — это культура
     * под стеклом, а не расклад поля: номер поля внизу лаборатории был бы
     * числом ниоткуда.
     */
    sample: string;
  }): void;
}

export class Lab {
  private readonly root = el<HTMLDivElement>('lab');
  private readonly glass = document.getElementById('lab-glass') as unknown as SVGSVGElement;
  private readonly empty = el<HTMLDivElement>('lab-empty');
  private readonly seedNote = el<HTMLSpanElement>('lab-seed-note');
  private readonly dialsEl = el<HTMLDivElement>('lab-dials');
  private readonly feedKey = el<HTMLButtonElement>('lab-feed');
  private readonly sheet = el<HTMLDivElement>('lab-sheet');
  private readonly shelfSheet = el<HTMLDivElement>('lab-shelf-sheet');
  private readonly slotsEl = el<HTMLDivElement>('lab-slots');
  private readonly shelfEl = el<HTMLDivElement>('lab-shelf');
  private readonly breedKey = el<HTMLButtonElement>('lab-breed');
  private readonly breedNote = el<HTMLSpanElement>('lab-breed-note');
  private readonly shelfNote = el<HTMLSpanElement>('lab-shelf-note');

  /**
   * Высота стекла в его собственных координатах.
   *
   * Ширина всегда сто, а высота — сколько выйдет по форме окна. Считаем её
   * сами и в неё же ставим `viewBox`: иначе SVG впишет квадрат в прямоугольник
   * с полями сверху и снизу, и «дно препарата» окажется краем невидимой
   * полосы, а не стекла. Культура на нём и висела в воздухе.
   */
  private glassH = 105;

  /** Гнездо кормёжки целиком: клавиша, подпись и строка состояния. */
  private feedSlot: HTMLElement | null = null;
  private feedState: HTMLElement | null = null;

  /** Крупинки корма, летящие в стекло: ответ прибора на нажатие клавиши. */
  private crumbs: { node: SVGCircleElement; x: number; from: number; to: number; at: number }[] = [];

  private view: LabView | null = null;
  private body: SVGGElement | null = null;
  private eyes: SVGGElement[] = [];
  /** Где глаз на теле — по этим точкам его и ставят каждый кадр. */
  private eyeSpots: { x: number; y: number }[] = [];
  private shape: BodyShape | null = null;
  private frame = 0;
  private busy = false;
  /** Что игрок крутит прямо сейчас — на это время ответы сервера не мешают. */
  private dragging: Dial | null = null;
  private pending: number | null = null;

  constructor(private readonly on: LabHandlers) {
    this.buildDials();
    // Форма окна меняется от поворота телефона и от появления клавиатуры.
    // Стекло обязано пересчитать свои координаты, иначе дно препарата
    // разъедется с дном стекла.
    new ResizeObserver(() => this.fit()).observe(this.glass);
    el<HTMLButtonElement>('lab-seed').addEventListener('click', () => void this.act(() => this.on.seed()));
    this.feedKey.addEventListener('click', () => {
      // Клавиша проваливается сразу, не дожидаясь сервера: палец должен
      // почувствовать нажатие в тот же миг, а не через дорогу до сервера и
      // обратно. Если сервер откажет, мы это скажем строкой.
      this.press();
      void this.act(() => this.on.feed()).then((done) => {
        if (done) this.crumble();
      });
    });
    el<HTMLButtonElement>('lab-close').addEventListener('click', () => this.closeSheet());
    el<HTMLButtonElement>('lab-shelf-close').addEventListener('click', () => this.closeSheet());
    this.breedKey.addEventListener('click', () => void this.act(() => this.on.breed(), true));
  }

  /** Открыт ли экран лаборатории — по нему прибор решает, что рисовать. */
  get open(): boolean {
    return !this.root.hidden;
  }

  /** Показать или убрать лабораторию — по положению переключателя. */
  toggle(on: boolean): void {
    if (on === this.open) return;
    if (on) this.show();
    else this.hide();
  }

  show(): void {
    this.root.hidden = false;
    this.fit();
    void this.reload();
    this.tick();
  }

  /**
   * Подогнать систему координат стекла под то, каким его показал браузер.
   * Зовётся при открытии и при всякой перемене размеров: поворот телефона
   * меняет форму окна, а вместе с ней и дно препарата.
   */
  private fit(): void {
    const rect = this.glass.getBoundingClientRect();
    if (rect.width < 1) return;
    const height = Math.max(60, Math.min(240, Math.round((GLASS_W * rect.height) / rect.width)));
    if (height === this.glassH) return;
    this.glassH = height;
    this.glass.setAttribute('viewBox', `0 0 ${GLASS_W} ${height}`);
    const creature = this.view?.incubator.creature ?? null;
    this.drawDish(this.view?.incubator.lostAt === null ? creature : null);
  }

  hide(): void {
    this.root.hidden = true;
    this.closeSheet();
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /** Закрывает оба окна лаборатории: клавиша прибора закрывает то, что открыто. */
  closeSheet(): void {
    this.sheet.hidden = true;
    this.shelfSheet.hidden = true;
  }

  /** Открыто ли хоть одно окно лаборатории. */
  get sheetOpen(): boolean {
    return !this.sheet.hidden || !this.shelfSheet.hidden;
  }

  /** Коллекция: свой архив, а не хвост окна стёкол. */
  openShelf(): void {
    this.shelfSheet.hidden = false;
    this.renderShelf();
  }

  /**
   * Напоминание о суточном сбросе — переключателем, а не настройкой в
   * отдельном окне: состояние видно в той же строке, которую нажимают.
   */
  async toggleTell(): Promise<void> {
    const view = this.view;
    if (view === null) return;
    await this.act(() => this.on.tell(!view.tell));
  }

  private async reload(): Promise<void> {
    try {
      this.apply(await this.on.load());
    } catch {
      this.tell('Лаборатория не отвечает');
    }
  }

  /**
   * Сколько осталось до срока — часами, а под конец минутами.
   *
   * Часы округляются к ближайшему, а не вниз: только что назначенный
   * суточный срок обязан читаться как «24 ч», а не как «23».
   */
  private until(at: string): string {
    const left = Date.parse(at) - Date.now();
    if (Number.isNaN(left)) return '—';
    if (left <= 0) return 'вот-вот';
    const hours = left / 3600_000;
    return hours >= 1 ? `${Math.round(hours)} ч` : `${Math.max(1, Math.round(left / 60_000))} мин`;
  }

  /**
   * Что стоит в поле «рост». И у точки, и у подростка это один и тот же
   * ответ — часы до следующей формы: срок человек должен читать сразу, а не
   * выводить из дробей.
   *
   * «ждёт ухода» — это дошедший срок у небрежного существа: взрослеет оно
   * в первый час, когда сыто и стоит в своих условиях, и сказать об этом
   * надо ровно там, где человек ищет время.
   */
  private growth(inc: LabView['incubator']): string {
    const creature = inc.creature;
    if (creature === null) return '—';
    if (inc.lostAt !== null) return 'утрачена';
    if (creature.stage === 3) return 'взрослая';
    if (creature.stage === 2) {
      if (inc.growAt === null) return '—';
      const left = Date.parse(inc.growAt) - Date.now();
      if (left > 0) return this.until(inc.growAt);
      return inc.growing ? 'вот-вот' : 'ждёт ухода';
    }
    if (inc.hatchAt === null) return 'точка';
    return this.until(inc.hatchAt);
  }

  /**
   * Что делать прямо сейчас.
   *
   * Панель режима — единственное место, где прибор говорит словами: над
   * стеклом ничего нет, кроме стекла. Поэтому здесь не описание режима, а
   * прямое указание на нынешний шаг — у каждой стадии он свой.
   */
  private note(): string {
    const view = this.view;
    if (view === null) return 'Лаборатория не отвечает.';
    const inc = view.incubator;
    const creature = inc.creature;
    if (creature === null) {
      return view.seedCost === 0
        ? 'Посев даёт случайную точку — какая достанется, решает прибор. Первая бесплатно.'
        : `Посев даёт случайную точку — какая достанется, решает прибор. ${view.seedCost} ж.`;
    }
    if (inc.lostAt !== null) return 'Культура утрачена. Стекло можно засеять заново.';
    if (creature.stage === 1) {
      // Первая стадия — не уход, а замес: три тумблера и покой.
      return `Точка досталась случайной. Выставь условия тремя тумблерами — из них выйдет форма — и жди ${hoursSaid(HATCH_HOURS)}.`;
    }
    if (creature.stage === 2) {
      return `Уход: два тумблера в комфорт и корм раз в сутки. Стрелки под ними называют сторону. Взрослая форма — через ${hoursSaid(inc.growHours)}; небрежные сутки отодвигают срок ещё на сутки.`;
    }
    return 'Взрослая форма стабильна: ухода не требует и погибнуть не может. Переложи её на стекло или в коллекцию.';
  }

  /**
   * Номер культуры под стеклом — начало её номера, как и у поля в игре.
   * Пустое стекло номера не имеет: выдумывать его нечему.
   */
  private sample(): string {
    const id = this.view?.incubator.creature?.id;
    return id === undefined ? 'образец —' : `образец #${id.slice(0, 8)}`;
  }

  /** Что сказать прибору: строка состояния и приборные числа. */
  private tell(line: string): void {
    const view = this.view;
    const inc = view?.incubator;
    this.on.panel({
      line,
      note: this.note(),
      day: view === null || view === undefined ? '—' : view.day.slice(8) + '.' + view.day.slice(5, 7),
      grow: inc === undefined || inc === null ? '—' : this.growth(inc),
      tokens: view?.tokens ?? 0,
      slots: `${(view?.slots ?? []).filter((creature) => creature !== null).length} / 2`,
      tell: view === null ? '—' : view.tell ? 'вкл' : 'выкл',
      sample: this.sample(),
    });
  }

  /** Одно действие за раз: две кормёжки в один клик — уже перекорм. */
  private async act(what: () => Promise<LabView>, sheet = false): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      this.apply(await what());
      if (sheet) this.renderSheet();
      return true;
    } catch (error) {
      this.tell(this.why(error));
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Ход клавиши: вниз и обратно. Без него нажатие ничем не отзывается. */
  private press(): void {
    this.feedKey.classList.add('press');
    window.setTimeout(() => this.feedKey.classList.remove('press'), 130);
  }

  /**
   * Корм сыплется в стекло.
   *
   * Это и есть ответ прибора на нажатие: провалившаяся клавиша говорит, что
   * её нажали, а крупинки — что от этого что-то произошло. Без них кормёжка
   * меняла только маленькую подпись под клавишей, и нажатие выглядело
   * несработавшим.
   */
  private crumble(): void {
    const layer = this.glass.querySelector('g[clip-path]');
    if (layer === null) return;
    const now = performance.now() / 1000;
    for (let i = 0; i < 4; i++) {
      const node = svgNode('circle', { r: 1.7, fill: '#f0e7d2' });
      layer.appendChild(node);
      this.crumbs.push({
        node,
        x: GLASS_W * (0.34 + i * 0.11),
        from: EDGE + 2,
        to: this.glassH - EDGE - 2,
        // Сыплются не разом: горсть, а не четыре одинаковые точки.
        at: now + i * 0.11,
      });
    }
  }

  /** Падение крупинок: разгон, касание дна и тихое исчезновение. */
  private fall(now: number): void {
    if (this.crumbs.length === 0) return;
    const left: typeof this.crumbs = [];
    for (const crumb of this.crumbs) {
      const t = now - crumb.at;
      if (t > 1.9) {
        crumb.node.remove();
        continue;
      }
      left.push(crumb);
      if (t < 0) {
        crumb.node.setAttribute('fill-opacity', '0');
        continue;
      }
      // Ускорение, а не равномерный ход: падает, а не спускается.
      const drop = Math.min(1, t * t * 2.4);
      crumb.node.setAttribute('cx', crumb.x.toFixed(2));
      crumb.node.setAttribute('cy', (crumb.from + (crumb.to - crumb.from) * drop).toFixed(2));
      // Полежав на дне, крупинка растворяется в среде.
      crumb.node.setAttribute('fill-opacity', (t < 1.2 ? 0.9 : Math.max(0, 0.9 - (t - 1.2) * 1.3)).toFixed(2));
    }
    this.crumbs = left;
  }

  /**
   * Почему прибор отказал. Каждая причина — правило, а не поломка, и звучать
   * должна как правило: иначе игрок будет пробовать снова.
   */
  private why(error: unknown): string {
    const code = (error as { code?: string }).code ?? '';
    const said: Record<string, string> = {
      busy: 'В стекле уже кто-то растёт',
      empty: 'Стекло чистое',
      poor: 'Не хватает жетонов на посев',
      'not-grown': 'Ещё не выросло',
      'no-room': 'Оба стекла заняты',
      'no-pair': 'Нужны двое взрослых на стёклах',
      network: 'Лаборатория не отвечает',
    };
    return said[code] ?? 'Лаборатория не приняла';
  }

  private apply(view: LabView): void {
    this.view = view;
    const inc = view.incubator;
    const creature = inc.creature;
    const alive = creature !== null && inc.lostAt === null;

    this.empty.hidden = alive;
    this.seedNote.textContent =
      view.seedCost === 0
        ? 'Первая точка бесплатно'
        : `Посев — ${view.seedCost} ж · у тебя ${view.tokens}`;
    el<HTMLButtonElement>('lab-seed').disabled = view.seedCost > view.tokens;

    /*
     * Третье гнездо: пока в стекле точка — тумблер питательной среды, после
     * вылупления — кормёжка. Это одно и то же место на приборе: среда
     * выбирает отростки будущей формы и на этом кончается, а еду дают уже
     * тому, кто вылупился.
     */
    const feeding = alive && creature !== null && creature.stage >= 2;
    const medium = this.dialsEl.querySelector<HTMLElement>('.dial[data-dial="medium"]');
    if (medium) medium.hidden = feeding;
    if (this.feedSlot) this.feedSlot.hidden = !feeding;
    // Взрослая форма законсервирована: кормить её незачем.
    this.feedKey.disabled = creature?.stage !== 2;
    /*
     * Что с кормёжкой сегодня. Клавиша при этом **не запирается** после
     * первой: перекорм — настоящая опасность ухода, и убрать её значило бы
     * убрать половину игры. Но прибор говорит, что корм уже дан: ошибаться
     * человек должен по невнимательности, а не потому, что ему не сказали.
     */
    if (this.feedState) {
      this.feedState.textContent =
        inc.feeds === 0 ? '' : inc.feeds === 1 ? 'дано' : 'перекорм';
      this.feedState.className = `hint ${inc.feeds === 1 ? 'fits' : ''}`;
    }

    this.drawDish(alive ? creature : null);
    this.renderDials();
    this.say();
  }

  /** Строка в экранчик: что с культурой и что случилось ночью. */
  private say(): void {
    const view = this.view;
    if (view === null) return;
    const inc = view.incubator;
    const news = inc.lostAt !== null ? 'Культура погибла' : this.nightly();
    if (news !== null) {
      this.tell(news);
      return;
    }
    const creature = inc.creature;
    if (creature === null) {
      this.tell('Стекло чистое');
      return;
    }
    if (creature.stage === 1) {
      // Что с ней делать, сказано в панели — здесь только то, что она есть.
      this.tell('Точка');
      return;
    }
    if (creature.stage === 3) {
      this.tell(`Взрослая форма · ${nameOf(creature)}`);
      return;
    }
    this.tell(MOOD_NAME[inc.mood] ?? 'штатный цикл');
  }

  /** Что было, пока не заходили. Прибор рассказывает это один раз. */
  private nightly(): string | null {
    const news = this.view?.news ?? [];
    if (news.length === 0) return null;
    const grew = news.find((day) => day.grew !== null);
    if (grew?.grew === 2) return 'Вылупилась · среда выбрана';
    if (grew?.grew === 3) return 'Выросла взрослая форма';
    const bad = news.filter((day) => day.verdict !== 'good' && day.verdict !== 'point').length;
    return bad > 0 ? `Без ухода: суток ${bad}` : null;
  }

  // ---------- Чашка ----------

  /**
   * Рисует чашку заново. Тело собирается из примитивов тем же кодом, что и
   * каталог форм: два разных рисователя однажды разошлись бы, и в чашке
   * оказалось бы не то, что в паспорте.
   */
  private drawDish(creature: Creature | null): void {
    this.glass.textContent = '';
    this.eyeSpots = [];
    // Стекло перерисовано — крупинки с него тоже стёрлись: держать список
    // узлов, которых уже нет в разметке, значит однажды на них наткнуться.
    this.crumbs = [];
    this.body = null;
    this.eyes = [];
    this.shape = null;
    // Черты пола нет намеренно: стекло чистое, а где низ — видно по тому,
    // кто на нём стоит. Линия читалась бы полкой, а не дном препарата.
    if (creature === null) return;

    // Всё, что под стеклом, обрезается его краем: за стеклом культуре
    // делать нечего.
    const clip = svgNode('clipPath', { id: 'petri-glass' });
    clip.appendChild(svgNode('rect', { x: 1, y: 1, width: GLASS_W - 2, height: this.glassH - 2, rx: 6 }));
    this.glass.appendChild(clip);

    const shape = bodyOf(creature);
    const skin = skinOf(creature);
    /*
     * Масштаб один на все тела, а не «вписать в кадр».
     *
     * Вписывание раздуло бы точку до размера взрослого — и «взрослая форма
     * крупнее на сорок процентов», главное, что видно в третьей стадии,
     * перестало бы быть видно вовсе. Стекло показывает настоящий размер.
     */
    /*
     * Мелко — и это правильно. Культура в препарате занимает малую часть
     * стекла: тогда видно и пол, и стенки, и то, что существо по ним
     * ходит. Тело во весь окуляр было бы портретом, а не наблюдением.
     */
    const scale = 0.42;
    /*
     * Насколько тело торчит ниже крепления — по этому числу цикл движения
     * и сажает его на стекло.
     *
     * Считаем из самого тела: у одних подошва широкая и выступает за
     * крепление, у других её нет вовсе. Веди всех по одной дорожке — и
     * половина повиснет в воздухе, а половина уедет за стекло.
     */
    const box = boundsOf(shape);
    this.below = (box.y + box.h - shape.anchor.y) * scale;
    // Половина ширины: ею тело упирается в боковые стенки, когда идёт
    // свободно, а не держится за них подошвой.
    this.wide = (box.w / 2) * scale;
    // Точка ещё никуда не ползёт: она просто лежит на дне. Двигаться — это
    // уже поведение, а поведение появляется вместе с телом.
    this.behaviour = creature.stage === 1 ? null : behaviourOf(creature);
    this.seed = seedOf(creature.id);
    const pose = this.poseNow(0);
    const at = { x: pose.x, y: pose.y };
    this.angle = pose.turn;

    const group = svgNode('g');
    group.setAttribute(
      'transform',
      `translate(${at.x} ${at.y}) rotate(${this.angle}) scale(${scale}) translate(${-shape.anchor.x} ${-shape.anchor.y})`,
    );
    /*
     * Глаза живут **вне** повёрнутого тела.
     *
     * Прилепившийся к стенке развёрнут поперёк, и вместе с телом заваливалась
     * бы пара глаз — а это читается не как «висит на стенке», а как «лежит
     * на боку». Глаза смотрят в мир: их ставят по мировым координатам того
     * места, где они на теле, и держат ровно. Моргание — свой слой, а не
     * перерисовка тела.
     */
    const face = svgNode('g');
    // Глаза узнаём по номеру части, а не по цвету заливки: белым рисуется и
    // белок, и блик у мокрого синего.
    const lids = new Map<number, SVGGElement>();
    for (const drawn of drawBody(shape, skin)) {
      const node = svgNode(drawn.tag, drawn.attrs);
      const from = shape.parts[drawn.of];
      if (from?.kind !== 'eye') {
        group.appendChild(node);
        continue;
      }
      let lid = lids.get(drawn.of);
      if (lid === undefined) {
        lid = svgNode('g');
        lids.set(drawn.of, lid);
        face.appendChild(lid);
        this.eyes.push(lid);
        this.eyeSpots.push({ x: from.x, y: from.y });
      }
      lid.appendChild(node);
    }
    const inside = svgNode('g', { 'clip-path': 'url(#petri-glass)' });
    inside.appendChild(group);
    inside.appendChild(face);
    this.glass.appendChild(inside);
    this.body = group;
    this.shape = shape;
    this.place = { at, scale };
  }

  private place: { at: { x: number; y: number }; scale: number } = { at: { x: 50, y: 50 }, scale: 1 };
  /** Под каким углом тело сидит под стеклом: это выбирает поведение, а не тело. */
  private angle = 0;
  /** Насколько тело торчит ниже крепления — им цикл сажает его на стекло. */
  private below = 0;
  /** Половина ширины тела — ею оно упирается в боковые стенки. */
  private wide = 0;
  /** Каким циклом оно живёт. У точки поведения ещё нет. */
  private behaviour: Behaviour | null = null;
  private seed = 0;

  /**
   * Где тело в этот миг. Считает цикл поведения; точка лежит на дне и
   * никуда не идёт — ей цикл не нужен.
   */
  private poseNow(time: number): Pose {
    if (this.behaviour === null) {
      return {
        x: GLASS_W * 0.52,
        y: this.glassH - EDGE - this.below + BITE,
        turn: 0,
        sx: 1,
        sy: 1,
      };
    }
    return poseOf(this.behaviour, time, {
      glass: { w: GLASS_W, h: this.glassH },
      edge: EDGE,
      below: this.below,
      wide: this.wide,
      seed: this.seed,
    });
  }

  /**
   * Один цикл анимации: покачивание с затуханием и моргание отдельным слоем.
   *
   * Скорость цикла — основной индикатор состояния, и она приходит с сервера
   * вместе с настроением. Моргание идёт по тем же часам: голодное существо
   * и моргает реже — один ритм на всё, а не два независимых.
   */
  private tick = (): void => {
    if (!this.open) return;
    this.frame = requestAnimationFrame(this.tick);
    // Крупинки летят своим чередом: они не часть тела, и падать должны
    // даже тогда, когда в стекле рисовать некого.
    this.fall(performance.now() / 1000);
    const body = this.body;
    const shape = this.shape;
    if (body === null || shape === null) return;
    const pace = this.view?.incubator.pace ?? 1;
    const now = (performance.now() / 1000) * pace;
    const pose = this.poseNow(now);
    this.angle = pose.turn;
    const k = this.place.scale;
    body.setAttribute(
      'transform',
      `translate(${pose.x.toFixed(2)} ${pose.y.toFixed(2)}) rotate(${pose.turn.toFixed(2)}) scale(${(k * pose.sx).toFixed(3)} ${(k * pose.sy).toFixed(3)}) translate(${-shape.anchor.x} ${-shape.anchor.y})`,
    );

    // Веко второго глаза опаздывает на доли секунды. Раньше оно вместо
    // этого просто закрывалось не до конца — пара при этом всё равно
    // моргала в один кадр, и читалось это как механизм, а не как взгляд.
    const lag = 0.015 + (this.seed % 40) / 1000;
    // Куда уехала точка тела при нынешней позе — по этому и ставим глаз.
    const rad = (pose.turn * Math.PI) / 180;
    const world = (x: number, y: number): { x: number; y: number } => {
      const dx = (x - shape.anchor.x) * k * pose.sx;
      const dy = (y - shape.anchor.y) * k * pose.sy;
      return {
        x: pose.x + dx * Math.cos(rad) - dy * Math.sin(rad),
        y: pose.y + dx * Math.sin(rad) + dy * Math.cos(rad),
      };
    };
    /*
     * Пара глаз держится ровно, а не вдоль тела.
     *
     * Место лица берём с тела — это его середина глаз, повёрнутая вместе с
     * ним, — а вот саму пару разводим по мировым осям, без поворота. Иначе
     * прилепившийся к стенке смотрит одним глазом вверх, другим вниз, и
     * читается это как «лежит на боку», а не «висит на стенке».
     */
    const spots = this.eyeSpots;
    if (spots.length === 0) return;
    const mid = {
      x: spots.reduce((sum, part) => sum + part.x, 0) / spots.length,
      y: spots.reduce((sum, part) => sum + part.y, 0) / spots.length,
    };
    const face = world(mid.x, mid.y);
    for (const [index, eye] of this.eyes.entries()) {
      const own = lidOf(now, this.seed, index === 0 ? 0 : lag * index);
      const centre = spots[index];
      if (centre === undefined) continue;
      const at = { x: face.x + (centre.x - mid.x) * k, y: face.y + (centre.y - mid.y) * k };
      eye.setAttribute(
        'transform',
        `translate(${at.x.toFixed(2)} ${at.y.toFixed(2)}) scale(${k.toFixed(3)} ${(k * own).toFixed(3)}) translate(${-centre.x} ${-centre.y})`,
      );
    }
  };

  // ---------- Тумблеры ----------

  private buildDials(): void {
    this.dialsEl.textContent = '';
    for (const dial of DIALS) {
      const box = document.createElement('div');
      box.className = 'dial';
      box.dataset.dial = dial;
      // Ручка своего цвета: три одинаковые чёрные шайбы игрок различал бы
      // только по подписи, а тумблер узнают рукой, не читая.
      box.innerHTML =
        `<svg viewBox="0 0 ${KNOB * 2} ${KNOB * 2}">` +
        `<circle cx="${KNOB}" cy="${KNOB}" r="27" fill="var(--case-2)" stroke="var(--edge)" />` +
        `<circle cx="${KNOB}" cy="${KNOB}" r="21" fill="${DIAL_COLOR[dial]}" />` +
        // Засечки краёв шкалы: без них «до упора» не отличить от «почти».
        `<path d="M 12 47 L 15 44 M 52 47 L 49 44" stroke="var(--silk-2)" stroke-width="1.6" fill="none" />` +
        `<line class="mark" x1="${KNOB}" y1="${KNOB}" x2="${KNOB}" y2="${KNOB - 18}" stroke="#f4f1ea" stroke-width="3.2" stroke-linecap="round" />` +
        `</svg>` +
        `<span class="cap">${DIAL_NAME[dial]}</span>` +
        `<span class="hint"></span>`;
      this.dialsEl.appendChild(box);
      this.grip(box, dial);
    }
    /*
     * Кормёжка живёт в том же гнезде, что и питательная среда, и выглядит
     * тем же органом прибора: кольцо шайбы, колпачок, подпись под ним.
     * Тумблер не прячется, а сменяется — своё дело среда сделала при
     * вылуплении, и на её место встаёт клавиша.
     *
     * Внутри колпачка три крупинки — те же точки, из которых сделан весь
     * прибор: корм здесь тоже точечный.
     */
    const slot = document.createElement('div');
    slot.className = 'dial feed-slot';
    this.feedKey.innerHTML =
      `<svg viewBox="0 0 ${KNOB * 2} ${KNOB * 2}" aria-hidden="true">` +
      `<circle cx="${KNOB}" cy="${KNOB - 6}" r="4.2" />` +
      `<circle cx="${KNOB - 8}" cy="${KNOB + 6}" r="4.2" />` +
      `<circle cx="${KNOB + 8}" cy="${KNOB + 6}" r="4.2" />` +
      `</svg>`;
    // Прячется теперь всё гнездо целиком, а не одна клавиша в нём: подпись
    // без клавиши висела бы в ряду сама по себе.
    this.feedKey.hidden = false;
    slot.appendChild(this.feedKey);
    const cap = document.createElement('span');
    cap.className = 'cap';
    cap.textContent = 'Корм';
    slot.appendChild(cap);
    const state = document.createElement('span');
    state.className = 'hint';
    state.id = 'lab-feed-state';
    slot.appendChild(state);
    this.dialsEl.appendChild(slot);
    this.feedSlot = slot;
    this.feedState = state;
  }

  /**
   * Тумблер крутят перетаскиванием вбок, а не по кругу.
   *
   * Круглая ручка честнее к прибору, но палец на телефоне ведёт по дуге
   * плохо, а шкала непрерывная — промах в полсотни делений здесь стоит
   * суток ухода. Ручка круглая, а движение — вдоль: видно прибор, а
   * попадать удобно.
   */
  private grip(box: HTMLElement, dial: Dial): void {
    let from = 0;
    let start = 0;
    const width = (): number => Math.max(120, this.dialsEl.clientWidth);

    box.addEventListener('pointerdown', (event) => {
      if (this.view === null) return;
      box.setPointerCapture(event.pointerId);
      this.dragging = dial;
      from = event.clientX;
      start = this.view.incubator.dials[dial];
    });
    box.addEventListener('pointermove', (event) => {
      if (this.dragging !== dial || this.view === null) return;
      const moved = ((event.clientX - from) / width()) * SCALE;
      const value = Math.max(0, Math.min(SCALE, Math.round(start + moved)));
      this.view.incubator.dials[dial] = value;
      this.renderDials();
    });
    const release = (event: PointerEvent): void => {
      if (this.dragging !== dial) return;
      this.dragging = null;
      box.releasePointerCapture?.(event.pointerId);
      this.send();
    };
    box.addEventListener('pointerup', release);
    box.addEventListener('pointercancel', release);
  }

  /**
   * Отправляет положения на сервер, но не на каждое движение пальца: за одно
   * кручение их набегают сотни, а считается всё равно то, как тумблеры
   * стоят к концу суток.
   */
  private send(): void {
    if (this.pending !== null) window.clearTimeout(this.pending);
    this.pending = window.setTimeout(() => {
      this.pending = null;
      const dials = this.view?.incubator.dials;
      if (dials === undefined) return;
      void this.act(() => this.on.dials({ ...dials }));
    }, 220);
  }

  private renderDials(): void {
    const view = this.view;
    if (view === null) return;
    // Только тумблеры: гнездо кормёжки стоит в том же ряду и той же
    // разметкой, и без этой проверки обход стирал его подпись — «дано»
    // появлялось и тут же пропадало.
    for (const box of this.dialsEl.querySelectorAll<HTMLElement>('.dial[data-dial]')) {
      const dial = box.dataset.dial as Dial;
      const value = view.incubator.dials[dial];
      // Ручка ходит на 270°: край шкалы должен быть виден как край, а не как
      // «почти там же, откуда начали».
      const angle = -135 + (value / SCALE) * 270;
      const mark = box.querySelector<SVGLineElement>('.mark');
      mark?.setAttribute('transform', `rotate(${angle} ${KNOB} ${KNOB})`);
      const hint = box.querySelector<HTMLElement>('.hint');
      // Стрелка бывает только у тумблеров ухода: питательной средой после
      // вылупления никто не управляет, и советовать по ней нечего.
      const said = dial === 'medium' ? undefined : view.incubator.hints?.[dial];
      if (hint) {
        hint.textContent = said === undefined ? '' : HINT_NAME[said];
        hint.className = `hint ${said ?? ''}`;
      }
    }
  }

  // ---------- Стёкла и коллекция ----------

  /** Открыть окно стёкол. Зовут его из панели режима — на корпусе кнопки нет. */
  openSheet(): void {
    this.sheet.hidden = false;
    this.renderSheet();
  }

  private renderSheet(): void {
    const view = this.view;
    if (view === null) return;
    const inc = view.incubator.creature;
    const ready = inc !== null && inc.stage === 3 && view.incubator.lostAt === null;

    this.slotsEl.textContent = '';
    for (const [index, creature] of view.slots.entries()) {
      const box = document.createElement('div');
      box.className = creature === null ? 'lab-glass free' : 'lab-glass';
      if (creature === null) {
        const cap = document.createElement('span');
        cap.className = 'cap';
        cap.textContent = 'стекло свободно';
        box.appendChild(cap);
        // Переложить можно только выросшего — и только когда он есть.
        if (ready && index === view.slots.findIndex((slot) => slot === null)) {
          const put = document.createElement('button');
          put.className = 'acc';
          put.textContent = 'Переложить сюда';
          put.addEventListener('click', () => void this.act(() => this.on.store(), true));
          box.appendChild(put);
        }
      } else {
        box.appendChild(portrait(creature));
        const cap = document.createElement('span');
        cap.className = 'cap';
        cap.textContent = nameOf(creature);
        box.appendChild(cap);
        const shelve = document.createElement('button');
        shelve.textContent = 'В коллекцию';
        shelve.addEventListener('click', () => void this.act(() => this.on.shelf(creature.id), true));
        box.appendChild(shelve);
      }
      this.slotsEl.appendChild(box);
    }

    const pair = view.slots.every((creature) => creature !== null && creature.bredAt === null);
    this.breedKey.hidden = !pair;
    this.breedNote.textContent = pair
      ? inc !== null && view.incubator.lostAt === null
        ? 'Сперва освободите инкубатор: новой точке некуда лечь'
        : 'Родители уйдут в коллекцию, а в стекле окажется новая точка'
      : ready
        ? 'Взрослая форма готова: переложите её на стекло или в коллекцию'
        : 'Нужны двое взрослых на стёклах хранения';
    this.breedKey.disabled = inc !== null && view.incubator.lostAt === null;

    this.renderShelf();
  }

  /**
   * Коллекция. Архив, а не витрина: сюда уходят все, кого довели до взрослой
   * формы, и оба родителя после скрещивания — она растёт вдвое быстрее линии.
   *
   * В подписи стоит поколение: низкий номер значит близость к дикому предку,
   * и число таких только убывает. Это встроенная редкость, без единого
   * искусственного правила.
   */
  private renderShelf(): void {
    const view = this.view;
    if (view === null) return;
    this.shelfEl.textContent = '';
    for (const creature of view.collection.slice(0, 60)) {
      const figure = document.createElement('figure');
      figure.appendChild(portrait(creature));
      const cap = document.createElement('figcaption');
      cap.textContent = nameOf(creature);
      figure.appendChild(cap);
      this.shelfEl.appendChild(figure);
    }
    this.shelfNote.textContent =
      view.collection.length === 0
        ? 'Пусто. Сюда уходят те, кого довели до взрослой формы, и родители после скрещивания.'
        : `Всего: ${view.collection.length}` +
          (view.collection.length > 60 ? ' · показаны последние 60' : '');
  }
}
