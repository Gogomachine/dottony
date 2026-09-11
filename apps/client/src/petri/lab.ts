import {
  DIALS,
  SCALE,
  bodyOf,
  boundsOf,
  drawBody,
  mutationCount,
  skinOf,
  speciesId,
  speciesOf,
  viewBoxOf,
  type BodyShape,
  type Creature,
  type Dial,
  type Dials,
  type Hint,
  type LabView,
} from '@doton/petri';

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
  load(): Promise<LabView>;
  /** Что показать в приборной строке и в панели режима. */
  panel(state: { line: string; day: string; grow: string; tokens: number; slots: string }): void;
}

export class Lab {
  private readonly root = el<HTMLDivElement>('lab');
  private readonly glass = document.getElementById('lab-glass') as unknown as SVGSVGElement;
  private readonly empty = el<HTMLDivElement>('lab-empty');
  private readonly seedNote = el<HTMLSpanElement>('lab-seed-note');
  private readonly dialsEl = el<HTMLDivElement>('lab-dials');
  private readonly feedKey = el<HTMLButtonElement>('lab-feed');
  private readonly sheet = el<HTMLDivElement>('lab-sheet');
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

  private view: LabView | null = null;
  private body: SVGGElement | null = null;
  private eyes: SVGGElement[] = [];
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
    this.feedKey.addEventListener('click', () => void this.act(() => this.on.feed()));
    el<HTMLButtonElement>('lab-close').addEventListener('click', () => this.closeSheet());
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

  closeSheet(): void {
    this.sheet.hidden = true;
  }

  /** Открыто ли окно стёкол — прибору это нужно, чтобы знать, что закрывать. */
  get sheetOpen(): boolean {
    return !this.sheet.hidden;
  }

  private async reload(): Promise<void> {
    try {
      this.apply(await this.on.load());
    } catch {
      this.tell('Лаборатория не отвечает');
    }
  }

  /**
   * Что стоит в поле «рост». У точки это часы до вылупления: полсуток —
   * не «когда-нибудь», а сегодня вечером или завтра утром, и человек
   * вправе знать, когда возвращаться.
   */
  private growth(inc: LabView['incubator']): string {
    const creature = inc.creature;
    if (creature === null) return '—';
    if (inc.lostAt !== null) return 'утрачена';
    if (creature.stage === 3) return 'взрослая';
    if (creature.stage === 2) return `${inc.goodDays}/${inc.grow}`;
    if (inc.hatchAt === null) return 'точка';
    const left = Date.parse(inc.hatchAt) - Date.now();
    if (left <= 0) return 'вот-вот';
    const hours = Math.floor(left / 3600_000);
    return hours >= 1 ? `${hours} ч` : `${Math.max(1, Math.round(left / 60_000))} мин`;
  }

  /** Что сказать прибору: строка состояния и приборные числа. */
  private tell(line: string): void {
    const view = this.view;
    const inc = view?.incubator;
    this.on.panel({
      line,
      day: view === null || view === undefined ? '—' : view.day.slice(8) + '.' + view.day.slice(5, 7),
      grow: inc === undefined || inc === null ? '—' : this.growth(inc),
      tokens: view?.tokens ?? 0,
      slots: `${(view?.slots ?? []).filter((creature) => creature !== null).length} / 2`,
    });
  }

  /** Одно действие за раз: две кормёжки в один клик — уже перекорм. */
  private async act(what: () => Promise<LabView>, sheet = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.apply(await what());
      if (sheet) this.renderSheet();
    } catch (error) {
      this.tell(this.why(error));
    } finally {
      this.busy = false;
    }
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
      // Точке нужен замес, а не уход: три тумблера и полсуток покоя.
      this.tell('Точка · замешай среду и жди');
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
     * Куда поставить крепление, чтобы существо **касалось** стекла.
     *
     * Считаем из самого тела: у одних подошва широкая и выступает за
     * крепление, у других её нет вовсе. Поставь всех по одной координате —
     * и половина повиснет в воздухе, а половина уедет за стекло. Поэтому
     * берём, насколько тело торчит ниже крепления, и на столько же отводим
     * его от края.
     */
    const box = boundsOf(shape);
    const below = (box.y + box.h - shape.anchor.y) * scale;
    const cling = creature.stage !== 1;
    // Прилипший к стенке развёрнут поперёк: его «низ» смотрит в стенку,
    // то есть влево. У стоящего на дне низ смотрит вниз.
    const at = cling
      ? { x: EDGE + below - BITE, y: this.glassH * WALL.at }
      : { x: FLOOR.x, y: this.glassH - EDGE - below + BITE };
    this.angle = cling ? WALL.turn : FLOOR.turn;

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
    for (const drawn of drawBody(shape, skin)) {
      const node = svgNode(drawn.tag, drawn.attrs);
      if (drawn.attrs.fill === '#FFFFFF') {
        const lid = svgNode('g');
        lid.appendChild(node);
        this.eyes.push(lid);
        face.appendChild(lid);
        continue;
      }
      const last = this.eyes[this.eyes.length - 1];
      if (last !== undefined && last.childNodes.length === 1) last.appendChild(node);
      else group.appendChild(node);
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

  /**
   * Один цикл анимации: покачивание с затуханием и моргание отдельным слоем.
   *
   * Скорость цикла — основной индикатор состояния, и она приходит с сервера
   * вместе с настроением. Периоды моргания у разных существ не кратны друг
   * другу: синхронное моргание превращает чашку в механизм.
   */
  private tick = (): void => {
    if (!this.open) return;
    this.frame = requestAnimationFrame(this.tick);
    const body = this.body;
    const shape = this.shape;
    if (body === null || shape === null) return;
    const pace = this.view?.incubator.pace ?? 1;
    const now = performance.now() / 1000;
    const sway = Math.sin(now * 1.1 * pace) * 3.2 + Math.sin(now * 0.37 * pace) * 1.4;
    body.setAttribute(
      'transform',
      `translate(${this.place.at.x} ${this.place.at.y}) rotate(${this.angle + sway}) scale(${this.place.scale}) translate(${-shape.anchor.x} ${-shape.anchor.y})`,
    );

    const id = this.view?.incubator.creature?.id ?? '';
    const period = 3.1 + (id.charCodeAt(0) % 7) * 0.43;
    const phase = (now * pace) % period;
    const shut = phase < 0.14 ? 1 - phase / 0.14 : 1;
    // Куда уехала точка тела при нынешнем повороте — по этому и ставим глаз.
    const rad = ((this.angle + sway) * Math.PI) / 180;
    const k = this.place.scale;
    const world = (x: number, y: number): { x: number; y: number } => {
      const dx = (x - shape.anchor.x) * k;
      const dy = (y - shape.anchor.y) * k;
      return {
        x: this.place.at.x + dx * Math.cos(rad) - dy * Math.sin(rad),
        y: this.place.at.y + dx * Math.sin(rad) + dy * Math.cos(rad),
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
    const spots = shape.parts.filter((part) => part.kind === 'eye');
    if (spots.length === 0) return;
    const mid = {
      x: spots.reduce((sum, part) => sum + part.x, 0) / spots.length,
      y: spots.reduce((sum, part) => sum + part.y, 0) / spots.length,
    };
    const face = world(mid.x, mid.y);
    for (const [index, eye] of this.eyes.entries()) {
      // Второй глаз моргает чуть иначе: рассинхрон — это характер, а у
      // мутантов ещё и признак.
      const own = index === 1 ? Math.min(1, shut + 0.08) : shut;
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
    for (const box of this.dialsEl.querySelectorAll<HTMLElement>('.dial')) {
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

    this.shelfEl.textContent = '';
    for (const creature of view.collection.slice(0, 24)) {
      const figure = document.createElement('figure');
      figure.appendChild(portrait(creature));
      const cap = document.createElement('figcaption');
      cap.textContent = nameOf(creature);
      figure.appendChild(cap);
      this.shelfEl.appendChild(figure);
    }
    this.shelfNote.textContent =
      view.collection.length === 0
        ? 'Пусто. Сюда уходят те, кого довели до взрослой формы.'
        : `Всего: ${view.collection.length}`;
  }
}
