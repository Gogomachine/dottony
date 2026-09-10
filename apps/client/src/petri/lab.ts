import {
  DIALS,
  SCALE,
  bodyOf,
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
 * Куда прибор кладёт существо в чашке.
 *
 * Жёлтый прилеплен к стенке — это его поведение, а не украшение: без
 * привязки к краю мутация «жёлтый пополз, как красный» не читалась бы
 * вовсе. Цикл движения принадлежит поведению, поэтому и место тут выбирает
 * оно, а не тело.
 */
const CLING_ANGLE = 215;

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
  /** Что показать в приборной строке: она у лаборатории и у игры одна. */
  panel(state: { line: string; day: string; grow: string; tokens: number }): void;
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
    el<HTMLButtonElement>('lab-seed').addEventListener('click', () => void this.act(() => this.on.seed()));
    this.feedKey.addEventListener('click', () => void this.act(() => this.on.feed()));
    el<HTMLButtonElement>('lab-glasses').addEventListener('click', () => this.openSheet());
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
    void this.reload();
    this.tick();
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

  /** Строка в экранчик, всё остальное в строке — как есть. */
  private tell(line: string): void {
    const view = this.view;
    const inc = view?.incubator;
    this.on.panel({
      line,
      day: view === null || view === undefined ? '—' : view.day.slice(8) + '.' + view.day.slice(5, 7),
      grow:
        inc?.creature == null
          ? '—'
          : inc.creature.stage === 3
            ? 'взрослая'
            : inc.creature.stage === 1
              ? 'точка'
              : `${inc.goodDays}/${inc.grow}`,
      tokens: view?.tokens ?? 0,
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

    // Кормят только вылупившихся: точке еда не нужна, взрослая
    // законсервирована.
    this.feedKey.disabled = !alive || creature?.stage !== 2;

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
      this.tell('Точка · форму выберут тумблеры');
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
    // Волосяная сетка стекла — та же, что в окуляре игры: прибор один.
    this.glass.appendChild(
      svgNode('circle', { cx: 50, cy: 50, r: 47.5, fill: 'none', stroke: 'rgba(255,255,255,0.07)' }),
    );
    if (creature === null) return;

    // Чашка круглая, и всё, что в ней, обрезается её стенкой. Без этого
    // прилепившийся к краю вылезал за стекло на корпус — а за стеклом
    // культуре делать нечего.
    const clip = svgNode('clipPath', { id: 'petri-dish' });
    clip.appendChild(svgNode('circle', { cx: 50, cy: 50, r: 47 }));
    this.glass.appendChild(clip);

    const shape = bodyOf(creature);
    const skin = skinOf(creature);
    /*
     * Масштаб один на все тела, а не «вписать в кадр».
     *
     * Вписывание раздуло бы точку до размера взрослого — и «взрослая форма
     * крупнее на сорок процентов», главное, что видно в третьей стадии,
     * перестало бы быть видно вовсе. Чашка показывает настоящий размер.
     */
    const scale = 0.46;
    // Точка ещё никуда не прилепилась: она просто лежит на дне. Прилепиться
    // к стенке — это уже поведение, а поведение появляется с телом.
    const angle = creature.stage === 1 ? 180 : CLING_ANGLE;
    const rad = (angle * Math.PI) / 180;
    const at = { x: 50 + Math.sin(rad) * 44, y: 50 - Math.cos(rad) * 44 };
    this.angle = angle;

    const group = svgNode('g');
    group.setAttribute(
      'transform',
      `translate(${at.x} ${at.y}) rotate(${angle - 180}) scale(${scale}) translate(${-shape.anchor.x} ${-shape.anchor.y})`,
    );
    for (const drawn of drawBody(shape, skin)) {
      const node = svgNode(drawn.tag, drawn.attrs);
      // Глаза складываем отдельными узлами: моргание — свой слой, а не
      // перерисовка тела.
      if (drawn.attrs.fill === '#FFFFFF') {
        const lid = svgNode('g');
        lid.appendChild(node);
        this.eyes.push(lid);
        group.appendChild(lid);
        continue;
      }
      const last = this.eyes[this.eyes.length - 1];
      if (last !== undefined && last.childNodes.length === 1) last.appendChild(node);
      else group.appendChild(node);
    }
    const inside = svgNode('g', { 'clip-path': 'url(#petri-dish)' });
    inside.appendChild(group);
    this.glass.appendChild(inside);
    this.body = group;
    this.shape = shape;
    this.place = { at, scale };
  }

  private place: { at: { x: number; y: number }; scale: number } = { at: { x: 50, y: 50 }, scale: 1 };
  /** Под каким углом тело сидит в чашке: это выбирает поведение, а не тело. */
  private angle = CLING_ANGLE;

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
      `translate(${this.place.at.x} ${this.place.at.y}) rotate(${this.angle - 180 + sway}) scale(${this.place.scale}) translate(${-shape.anchor.x} ${-shape.anchor.y})`,
    );

    const id = this.view?.incubator.creature?.id ?? '';
    const period = 3.1 + (id.charCodeAt(0) % 7) * 0.43;
    const phase = (now * pace) % period;
    const shut = phase < 0.14 ? 1 - phase / 0.14 : 1;
    for (const [index, eye] of this.eyes.entries()) {
      // Второй глаз моргает чуть иначе: рассинхрон — это характер, а у
      // мутантов ещё и признак.
      const own = index === 1 ? Math.min(1, shut + 0.08) : shut;
      const centre = shape.parts.filter((part) => part.kind === 'eye')[index];
      if (centre === undefined) continue;
      eye.setAttribute(
        'transform',
        `translate(${centre.x} ${centre.y}) scale(1 ${own.toFixed(3)}) translate(${-centre.x} ${-centre.y})`,
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
      box.innerHTML =
        `<svg viewBox="0 0 60 60">` +
        `<circle cx="30" cy="30" r="26" fill="#26231f" stroke="rgba(255,255,255,0.12)" />` +
        `<circle cx="30" cy="30" r="20" fill="#1a1815" />` +
        `<line class="mark" x1="30" y1="30" x2="30" y2="12" stroke="#e8e2d6" stroke-width="3" stroke-linecap="round" />` +
        `</svg>` +
        `<span class="cap">${DIAL_NAME[dial]}</span>` +
        `<span class="hint"></span>`;
      this.dialsEl.appendChild(box);
      this.grip(box, dial);
    }
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
      mark?.setAttribute('transform', `rotate(${angle} 30 30)`);
      const hint = box.querySelector<HTMLElement>('.hint');
      const said = view.incubator.hints?.[dial];
      if (hint) {
        hint.textContent = said === undefined ? '' : HINT_NAME[said];
        hint.className = `hint ${said ?? ''}`;
      }
    }
  }

  // ---------- Стёкла и коллекция ----------

  private openSheet(): void {
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
