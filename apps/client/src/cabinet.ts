import {
  cleanMarks,
  FACES,
  isOwnMark,
  OWN_MARK,
  PLACEMENT_GAMES,
  OWN_PRICE,
  FRAMES,
  FRAME_PRICE,
  markAllowed,
  markById,
  MARKS,
  MARK_SLOTS,
  slotItem,
  slotPrice,
  type Frame,
  type Mark,
} from '@doton/core';
import type {
  DuelHistoryEntry,
  FriendsResponse,
  MeResponse,
  TourneyHistoryEntry,
  TourneyResponse,
} from '@doton/protocol';
import {
  addFriend,
  ApiError,
  buy,
  serviceAll,
  serviceKey,
  serviceNone,
  serviceSet,
  setAvatar,
  setFrame,
  setMarks,
  getConfig,
  getFriends,
  getHistory,
  getMe,
  openInTelegram,
  removeFriend,
  rename,
  telegramLinkUrl,
  getTourney,
  tourneyEnter,
  tourneyHistory,
} from './api';
import { brandLockup } from './brand';
import { dayName, renderRounds, tourneyAction, tourneyNote, tourneyWhen } from './tourney';
import { markChip } from './plate';

/**
 * Личный кабинет: кто я, какая лига, что сыграно.
 *
 * Живёт отдельным окном поверх игры и ничего о ней не знает — партия под
 * ним не трогается. Наружу отдаёт только действия, которые меняют игру:
 * прокрутить матч и открыть таблицу рейтинга.
 */

/** Чем кончилась наладка — коротко, той же строкой, что и звала. */
const DONE: Record<string, string> = {
  all: 'весь прилавок и жетоны',
  none: 'корпус пуст',
  poor: 'жетонов нет',
  rich: 'жетонов с запасом',
  league: 'учёный, калибровка пройдена',
  raw: 'рейтинг новичка',
};

/** Что открыто в кабинете под шапкой профиля. */
type CabTab = 'rating' | 'history' | 'friends' | 'tourney' | 'marks';

/**
 * Строка раздела «Рейтинг»: режим, своё число в нём и своё место. Таблицы
 * лежали четырьмя кнопками вразнобой, и по ним не читалось, что это одно и
 * то же — места по режимам; здесь они собраны в один список.
 */
interface BoardRow {
  name: string;
  /** Рейтинг дуэли или рекорд захода — что в этом режиме и есть счёт. */
  value: string;
  /** Место в таблице; null — игрок в неё ещё не попал. */
  place: number | null;
  open(): void;
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

const LOGIN_NAMES: Record<string, string> = {
  guest: 'гость',
  telegram: 'Telegram',
  ton: 'кошелёк TON',
};

/** «1 234 567» — крупные числа читаются только с разрядами. */
function groupDigits(value: number): string {
  return value.toLocaleString('ru-RU');
}

/** «12 марта» — дата матча без года: история короткая, год избыточен. */
function shortDate(iso: string): string {
  const parsed = new Date(`${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export interface CabinetHandlers {
  onReplay(duelId: string): void;
  onRatingBoard(kind: 'chain' | 'order'): void;
  /** Таблица рекордов цепочек. */
  onSprintBoard(): void;
  /** Таблица рекордов тапа. */
  onOrderBoard(): void;
  /**
   * Позвать друга в матч: снаружи это открывает приватную комнату.
   * Код друга нужен, чтобы дослать приглашение сообщением в Telegram.
   */
  onInvite(friendCode: string): void;
  /** Игрок сменил шильдики: корпус на игровом экране рисует не кабинет. */
  onMarks(marks: (string | null)[]): void;
  /** Игрок сменил оправу полосы; null — снял. */
  onFrame(frame: string | null): void;
  /** Свой рисунок с сервера: на корпусе его рисует не кабинет. */
  onArt(art: string | null): void;
  /**
   * Игрок начинает турнирный заход. Партию заводит не кабинет: сид общий,
   * прибор переставляется на цепочки, а сброс на время захода запирается —
   * всё это дело игрового экрана.
   */
  onTourneyRound(): Promise<void>;
  /** Открыть таблицу турнира: сегодняшнего или прошедшего дня. */
  onTourneyBoard(day?: string): void;
}

export class Cabinet {
  private readonly overlay = el<HTMLDivElement>('cabinet');
  private readonly nameEl = el<HTMLSpanElement>('cab-name');
  private readonly loginEl = el<HTMLSpanElement>('cab-login');
  private readonly photoEl = el<HTMLDivElement>('cab-photo');
  private readonly renameEl = el<HTMLButtonElement>('cab-rename');
  private readonly nameRowEl = el<HTMLDivElement>('cab-name-row');
  private readonly nameEditEl = el<HTMLDivElement>('cab-name-edit');
  private readonly nameInputEl = el<HTMLInputElement>('cab-name-input');
  private readonly nameNoteEl = el<HTMLSpanElement>('cab-name-note');
  private readonly leagueEl = el<HTMLDivElement>('cab-league');
  private readonly historyEl = el<HTMLOListElement>('cab-history');
  private readonly friendsEl = el<HTMLDivElement>('cab-friends');
  private readonly friendListEl = el<HTMLOListElement>('friend-list');
  private readonly recentListEl = el<HTMLOListElement>('recent-list');
  private readonly navEl = el<HTMLElement>('cab-nav');
  private readonly backEl = el<HTMLButtonElement>('cab-back');
  private readonly ratingEl = el<HTMLDivElement>('cab-rating');
  private readonly boardsEl = el<HTMLOListElement>('cab-boards');
  private readonly marksEl = el<HTMLDivElement>('cab-marks');
  private readonly slotsEl = el<HTMLDivElement>('cab-slots');
  private readonly slotHintEl = el<HTMLSpanElement>('cab-slot-hint');
  private readonly catalogEl = el<HTMLDivElement>('cab-catalog');
  private readonly framesEl = el<HTMLDivElement>('cab-frames');
  private readonly frameHintEl = el<HTMLSpanElement>('cab-frame-hint');
  private readonly facesEl = el<HTMLDivElement>('cab-faces');
  private readonly tourneyEl = el<HTMLDivElement>('cab-tourney');
  private readonly tourneyPoolEl = el<HTMLSpanElement>('cab-tourney-pool');
  private readonly tourneyWhenEl = el<HTMLSpanElement>('cab-tourney-when');
  private readonly tourneyNoteEl = el<HTMLSpanElement>('cab-tourney-note');
  private readonly tourneyRoundsEl = el<HTMLDivElement>('cab-tourney-rounds');
  private readonly tourneyGoEl = el<HTMLButtonElement>('cab-tourney-go');
  private readonly tourneyBoardEl = el<HTMLButtonElement>('cab-tourney-board');
  private readonly tourneyDaysEl = el<HTMLOListElement>('cab-tourney-days');
  /** Турнир дня, как его последний раз прочитали: по нему и жмут клавишу. */
  private tourney: TourneyResponse | null = null;
  /** Какой раздел сейчас открыт; null — виден сам столбик разделов. */
  private tab: CabTab | null = null;
  private readonly serviceEl = el<HTMLDivElement>('cab-service');
  private readonly serviceNoteEl = el<HTMLSpanElement>('cab-service-note');
  /** Выбранные шильдики, выданные отметки и ячейка, которую заполняют. */
  private marks: (string | null)[] = cleanMarks([]);
  private earned: string[] = [];
  private slot = 0;
  private miniApp: string | null = null;
  /** Привязан ли Telegram у игрока — по последнему прочитанному профилю. */
  private hasTelegram = false;
  /** Ссылка привязки, уже взятая у сервера: по ней уходят второй раз. */
  private linkUrl: string | null = null;
  /** Жетоны игрока: по ним видно, хватает ли на наклейку. */
  private tokens = 0;
  /**
   * Наклейка, на которую занесена рука: первое нажатие называет цену,
   * второе покупает. Диалога подтверждения нет — он бы спрашивал то же
   * самое, только окном поверх каталога.
   */
  private buying: string | null = null;
  /** Надетая оправа полосы; null — полоса без оправы. */
  private frame: string | null = null;
  /**
   * Свой рисунок. Кабинет его не рисует и не продаёт — это дело листа; здесь
   * он нужен, чтобы шильдик в каталоге и в ячейке выглядел собой, а не
   * надписью «свой».
   */
  private art: string | null = null;
  /** Сколько ячеек корпуса открыто: первая даром, вторая и третья за жетоны. */
  private slots = 1;

  constructor(private readonly handlers: CabinetHandlers) {
    el<HTMLSpanElement>('cab-brand').innerHTML = brandLockup(116);
    this.buildService();
    for (const button of this.navEl.querySelectorAll<HTMLButtonElement>('.nav')) {
      button.addEventListener('click', () => this.openTab(button.dataset.tab as CabTab));
    }
    this.backEl.addEventListener('click', () => this.openTab(null));
    this.tourneyGoEl.addEventListener('click', () => void this.tourneyGo());
    this.tourneyBoardEl.addEventListener('click', () =>
      this.handlers.onTourneyBoard(this.tourney?.day),
    );
    this.buildCatalog();
    this.buildFrames();
    el<HTMLButtonElement>('cab-add-friend').addEventListener('click', () => void this.addByCode());
    el<HTMLButtonElement>('cab-link-tg').addEventListener('click', () => void this.linkTelegram());
    this.renameEl.addEventListener('click', () => this.startRename());
    el<HTMLButtonElement>('cab-name-cancel').addEventListener('click', () => this.stopRename());
    el<HTMLButtonElement>('cab-name-save').addEventListener('click', () => void this.saveName());
    this.nameInputEl.addEventListener('keydown', (event) => {
      // Ввод с клавиатуры доводят клавишей, а не поиском кнопки глазами.
      if (event.key === 'Enter') void this.saveName();
      if (event.key === 'Escape') this.stopRename();
    });
    el<HTMLDivElement>('cab-photo').addEventListener('click', () => this.toggleFaces());
    // Клик мимо окна закрывает кабинет — привычный жест.
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.hide();
    });
  }

  get visible(): boolean {
    return !this.overlay.hidden;
  }

  /**
   * Своей кнопки «Закрыть» у кабинета нет: окно убирают клавишей «Меню»
   * или щелчком мимо него — кнопка лишь повторяла бы клавишу.
   */
  hide(): void {
    this.overlay.hidden = true;
  }

  /**
   * Открывает кабинет и подтягивает свежие данные. Без раздела открывается
   * сам столбик: в его строках уже написано, что за каждой, — лига, сколько
   * матчей, сколько друзей, сколько шильдиков выдано.
   */
  async show(tab: CabTab | null = null): Promise<void> {
    this.overlay.hidden = false;
    this.openTab(tab);
    void this.askConfig();
    this.historyEl.innerHTML = '<li class="empty">Загружаю…</li>';
    this.boardsEl.innerHTML = '<li class="empty">Загружаю…</li>';
    try {
      const [me, history] = await Promise.all([getMe(), getHistory()]);
      this.renderProfile(me);
      this.renderHistory(history.entries);
    } catch {
      this.historyEl.innerHTML = '<li class="empty">Профиль недоступен — сервер не ответил.</li>';
      this.boardsEl.innerHTML = '<li class="empty">Таблицы недоступны — сервер не ответил.</li>';
    }
    await Promise.all([this.loadFriends(), this.loadTourney()]);
  }

  /**
   * Раздел «Турниры»: турнир дня карточкой и свои прошедшие дни списком.
   *
   * Турнир живёт сутки и в полночь начинается заново, поэтому без истории
   * вчерашний вечер исчезал бесследно: сыграл, выиграл — а к утру ни следа.
   * Здесь же и записываются в следующий: жетоны лежат в кабинете, и ходить
   * за ними в другое окно незачем.
   */
  private async loadTourney(): Promise<void> {
    this.tourneyDaysEl.innerHTML = '<li class="empty">Загружаю…</li>';
    try {
      const [state, history] = await Promise.all([getTourney(), tourneyHistory()]);
      this.renderTourney(state);
      this.renderTourneyDays(history.days);
    } catch {
      this.tourney = null;
      this.tourneyGoEl.hidden = true;
      this.tourneyBoardEl.hidden = true;
      this.tourneyRoundsEl.hidden = true;
      this.tourneyPoolEl.textContent = '—';
      this.tourneyWhenEl.textContent = '';
      this.tourneyNoteEl.textContent = 'Турнир недоступен — прибор не отвечает.';
      this.tourneyDaysEl.innerHTML = '<li class="empty">Турниры недоступны.</li>';
      this.setNote('tourney', '—');
    }
  }

  private renderTourney(state: TourneyResponse): void {
    this.tourney = state;
    this.tourneyPoolEl.textContent = `${groupDigits(state.pool)} ж`;
    this.tourneyWhenEl.textContent = tourneyWhen(state);
    this.tourneyNoteEl.textContent = tourneyNote(state);
    renderRounds(this.tourneyRoundsEl, state);
    const act = tourneyAction(state);
    this.tourneyGoEl.hidden = act === null;
    if (act) this.tourneyGoEl.textContent = act.label;
    // Таблицу предлагаем, только когда в ней есть на что смотреть.
    this.tourneyBoardEl.hidden = state.board.length === 0;
    // Подпись раздела в столбике: по ней видно, идёт ли турнир и твой ли он.
    this.setNote(
      'tourney',
      state.phase === 'open'
        ? state.mine
          ? `идёт · заходов ${state.rounds - state.mine.rounds}`
          : `идёт · котёл ${groupDigits(state.pool)}`
        : state.signup.entered
          ? 'вы записаны'
          : `взнос ${groupDigits(state.entry)}`,
    );
  }

  /** Свои турниры: день, место и что из котла досталось. */
  private renderTourneyDays(days: TourneyHistoryEntry[]): void {
    this.tourneyDaysEl.innerHTML = '';
    if (days.length === 0) {
      this.tourneyDaysEl.innerHTML = '<li class="empty">Турниров ещё не было.</li>';
      return;
    }
    for (const day of days) {
      const item = document.createElement('li');
      item.className = 'playable';
      // Золото за первое место, зелень за долю котла: место без денег и
      // место с деньгами — разные истории, и по цвету это видно сразу.
      if (day.place === 1) item.classList.add('gold');
      else if ((day.prize ?? 0) > 0) item.classList.add('paid');
      item.innerHTML =
        '<span class="mark"></span><span class="who"><b></b><span class="when"></span></span>' +
        '<span class="pts"></span><span class="rd"></span>';
      const [, who, pts, rd] = [...item.children] as HTMLElement[];
      who!.querySelector('b')!.textContent = dayName(day.day);
      who!.querySelector('.when')!.textContent =
        day.rounds === 0
          ? `не играл · вошло ${day.entered}`
          : `место ${day.place ?? '—'} из ${day.entered} · заходов ${day.rounds}`;
      pts!.textContent = groupDigits(day.score);
      // Выигрыш крупнее взноса — это плюс дня, а не просто число.
      const prize = day.prize ?? 0;
      rd!.textContent = prize > 0 ? `+${groupDigits(prize)}` : `−${groupDigits(day.paid)}`;
      rd!.classList.add(prize > day.paid ? 'up' : prize > 0 ? '' : 'down');
      item.addEventListener('click', () => this.handlers.onTourneyBoard(day.day));
      this.tourneyDaysEl.appendChild(item);
    }
  }

  /** Запись в турнир или начало захода — тем же правилом, что и в окне. */
  private async tourneyGo(): Promise<void> {
    const state = this.tourney;
    if (!state) return;
    const act = tourneyAction(state);
    if (act === null) return;
    this.tourneyGoEl.disabled = true;
    try {
      if (act.kind === 'enter') {
        this.renderTourney(await tourneyEnter());
        // Взнос ушёл из кошелька — число в пропуске обязано это показать.
        this.tokens -= state.entry;
        el<HTMLSpanElement>('cab-tokens').textContent = groupDigits(this.tokens);
      } else {
        await this.handlers.onTourneyRound();
      }
    } catch (error) {
      this.tourneyNoteEl.textContent =
        error instanceof ApiError && error.code === 'not-enough'
          ? `Не хватает жетонов: взнос ${groupDigits(state.entry)}.`
          : error instanceof ApiError && error.code === 'already-in'
            ? 'Вы уже записаны.'
            : 'Не вышло — попробуйте ещё раз.';
    } finally {
      this.tourneyGoEl.disabled = false;
    }
  }

  /**
   * Открывает раздел вместо столбика; null возвращает к самому столбику.
   * Разделов четыре, и каждый занимает всю высоту карточки — иначе в окуляр
   * не помещается ни один.
   */
  private openTab(tab: CabTab | null): void {
    this.tab = tab;
    // Сетка смайликов и ввод имени закрываются вместе со сменой раздела:
    // оба открыты в шапке и в разделе только мешались бы, отодвигая его вниз.
    this.facesEl.hidden = true;
    this.stopRename();
    // Занесённая над наклейкой рука опускается: цену называют заново.
    this.buying = null;
    this.ratingEl.hidden = tab !== 'rating';
    this.historyEl.hidden = tab !== 'history';
    this.friendsEl.hidden = tab !== 'friends';
    this.tourneyEl.hidden = tab !== 'tourney';
    this.marksEl.hidden = tab !== 'marks';
    this.navEl.hidden = tab !== null;
    this.backEl.hidden = tab === null;
    // Раздел открывается со своего начала, а не с середины: браузер, подводя
    // нажатую строку столбика к пальцу, оставляет карточку прокрученной —
    // и раздел, вставший на место столбика, начинался выше экрана. Наверх
    // выводим не всю карточку, а строку возврата: на узком телефоне шапка
    // пропуска съедает окуляр целиком, и до самого раздела дело не доходит.
    if (tab === null) this.overlay.querySelector('.modal')?.scrollTo({ top: 0 });
    else this.backEl.scrollIntoView({ block: 'start' });
    if (tab !== null) {
      const opened = this.navEl.querySelector<HTMLButtonElement>(`.nav[data-tab="${tab}"] b`);
      el<HTMLElement>('cab-back-name').textContent = opened?.textContent ?? '';
    }
  }

  /**
   * Наладка: прибор со снятой задней крышкой.
   *
   * Нужна ровно затем, чтобы посмотреть состояния, до которых игрой идти
   * часами: полный корпус, все оправы, свой шильдик, лига, пустой аккаунт
   * новичка. Полоса появляется, только если игру открыли со служебным
   * ключом (`?service=…`), и трогает она один-единственный аккаунт — тот,
   * которым в неё зашли: кого налаживать, говорит токен, а не кнопка.
   */
  private buildService(): void {
    if (serviceKey() === null) return;
    this.serviceEl.hidden = false;
    for (const button of this.serviceEl.querySelectorAll<HTMLButtonElement>('[data-service]')) {
      button.addEventListener('click', () => void this.service(button.dataset.service ?? ''));
    }
  }

  private async service(what: string): Promise<void> {
    const say = (text: string): void => {
      this.serviceNoteEl.textContent = text;
    };
    say('Налаживаю…');
    try {
      // Рейтинг «учёного» ставим вместе с пройденной калибровкой: без неё
      // лига на пропуске не показывается вовсе, и проверять было бы нечего.
      if (what === 'all') await serviceAll();
      else if (what === 'none') await serviceNone();
      else if (what === 'poor') await serviceSet({ tokens: 0 });
      else if (what === 'rich') await serviceSet({ tokens: 9999 });
      else if (what === 'league') await serviceSet({ rating: 1950, games: PLACEMENT_GAMES });
      else if (what === 'raw') await serviceSet({ rating: 1500, games: 0 });
      else return;
      // Перечитываем пропуск целиком: наладка меняет и жетоны, и корпус, и
      // лигу разом, а собирать это по кусочкам — плодить рассинхроны.
      // Открытый раздел оставляем тот же: наладчик смотрит именно в него.
      await this.show(this.tab);
      say(`Готово · ${DONE[what] ?? ''}`);
    } catch (error) {
      // Дверей наладки без ключа на сервере нет вовсе — оттуда приходит
      // «нет такой страницы», и это самый частый ответ при опечатке в ключе.
      say(error instanceof ApiError && error.status === 404 ? 'Ключ не подошёл.' : 'Не вышло.');
    }
  }

  /** Подпись раздела в столбике: что за ним, ещё до нажатия. */
  private setNote(tab: CabTab, note: string): void {
    el<HTMLSpanElement>(`nav-${tab}`).textContent = note;
  }

  /**
   * Раздел «Рейтинг»: по строке на режим. Место показываем отдельно от
   * числа — рейтинг без места не говорит ничего, а место без рейтинга
   * говорит половину.
   */
  private renderBoards(rows: BoardRow[]): void {
    this.boardsEl.innerHTML = '';
    for (const row of rows) {
      const item = document.createElement('li');
      item.innerHTML =
        '<span class="mode-name"></span><span class="value"></span><span class="place"></span>';
      const [nameEl, valueEl, placeEl] = [...item.children] as HTMLElement[];
      nameEl!.textContent = row.name;
      valueEl!.textContent = row.value;
      placeEl!.textContent = row.place === null ? '—' : `#${row.place}`;
      placeEl!.classList.toggle('in', row.place !== null);
      item.addEventListener('click', () => {
        this.hide();
        row.open();
      });
      this.boardsEl.appendChild(item);
    }
  }

  /**
   * Каталог шильдиков. Он не меняется от игрока к игроку, поэтому строится
   * один раз при заводе кабинета; выбор потом только подсвечивается.
   */
  private buildCatalog(): void {
    const clear = document.createElement('button');
    clear.className = 'none';
    clear.textContent = 'Пусто';
    clear.addEventListener('click', () => void this.put(null));
    this.catalogEl.appendChild(clear);
    for (const mark of MARKS) {
      const pick = document.createElement('button');
      pick.className = 'pick';
      pick.dataset.mark = mark.id;
      if (mark.needs !== undefined) pick.dataset.needs = mark.needs;
      pick.appendChild(markChip(mark, isOwnMark(mark.id) ? this.art : null));
      pick.addEventListener('click', () => void this.take(mark));
      this.catalogEl.appendChild(pick);
    }
  }

  /**
   * Свой рисунок сменился — на листе его только что поставили на пропуск.
   * Перерисовываем то, где он виден: ячейку корпуса и место в каталоге.
   */
  setArt(art: string | null): void {
    if (art === this.art) return;
    this.art = art;
    const pick = this.catalogEl.querySelector<HTMLElement>(`.pick[data-mark="${OWN_MARK}"]`);
    if (pick) {
      const own = markById(OWN_MARK);
      if (own) {
        pick.innerHTML = '';
        pick.appendChild(markChip(own, art));
      }
    }
    if (this.visible) this.showMarks(this.marks);
  }

  /**
   * Оправы полосы. Их немного и они не меняются, поэтому строятся разом:
   * это не каталог с прокруткой, а короткий ряд материалов.
   */
  private buildFrames(): void {
    const bare = document.createElement('button');
    bare.className = 'frame-pick none';
    bare.textContent = 'Без оправы';
    bare.dataset.frame = '';
    bare.addEventListener('click', () => void this.wearFrame(null));
    this.framesEl.appendChild(bare);
    for (const frame of FRAMES) {
      const pick = document.createElement('button');
      pick.className = `frame-pick ${frame.id}`;
      pick.dataset.frame = frame.id;
      pick.textContent = frame.name;
      pick.addEventListener('click', () => void this.takeFrame(frame));
      this.framesEl.appendChild(pick);
    }
  }

  /** Нажатие по оправе: своя надевается, чужая называет цену и покупается. */
  private async takeFrame(frame: Frame): Promise<void> {
    if (this.earned.includes(frame.id)) {
      this.buying = null;
      await this.wearFrame(frame.id);
      return;
    }
    if (this.tokens < FRAME_PRICE) {
      this.buying = null;
      this.frameHintEl.textContent = `${FRAME_PRICE} жетонов · у вас ${this.tokens}`;
      return;
    }
    if (this.buying !== frame.id) {
      this.buying = frame.id;
      this.frameHintEl.textContent = `${FRAME_PRICE} жетонов · нажмите ещё раз`;
      return;
    }
    this.buying = null;
    try {
      const bought = await buy(frame.id);
      this.tokens = bought.tokens;
      this.earned = bought.earned;
      this.slots = bought.slots;
      el<HTMLSpanElement>('cab-tokens').textContent = groupDigits(bought.tokens);
      await this.wearFrame(frame.id);
      this.frameHintEl.textContent = `осталось ${bought.tokens} жетонов`;
    } catch {
      this.frameHintEl.textContent = 'не купилось — попробуйте ещё раз';
    }
  }

  /** Надевает оправу и сразу шлёт её на сервер: её видит соперник. */
  private async wearFrame(id: string | null): Promise<void> {
    this.frame = id;
    this.showFrame();
    this.handlers.onFrame(id);
    try {
      await setFrame(id);
    } catch {
      // Не дошло — свою полосу мы уже перерисовали, соперник увидит позже.
    }
  }

  /** Подсветка выбранной оправы и подпись под рядом. */
  private showFrame(): void {
    for (const pick of this.framesEl.querySelectorAll<HTMLElement>('.frame-pick')) {
      const id = pick.dataset.frame ?? '';
      pick.classList.toggle('on', id === (this.frame ?? ''));
      pick.classList.toggle('locked', id !== '' && !this.earned.includes(id));
    }
    const worn = this.frame === null ? null : FRAMES.find((frame) => frame.id === this.frame);
    this.frameHintEl.textContent =
      worn === undefined || worn === null
        ? `Оправа полосы · ${FRAME_PRICE} жетонов`
        : `Оправа «${worn.name.toLowerCase()}» · её видит соперник`;
  }

  /**
   * Нажатие по каталогу. Своё — ставим в ячейку; чужое — объясняем, откуда
   * его берут: отметку заслуживают, наклейку покупают. Второе нажатие по
   * названной цене её и платит.
   */
  private async take(mark: Mark): Promise<void> {
    // Свой шильдик здесь не продаётся: платят за то, что видно на листе, и
    // клавиша стоит там же. Купленный ставится в ячейку как любой другой.
    if (isOwnMark(mark.id) && !markAllowed(mark.id, this.earned)) {
      this.buying = null;
      this.slotHintEl.textContent = `Свой рисунок · ${OWN_PRICE} жетонов · с листа`;
      return;
    }
    if (markAllowed(mark.id, this.earned)) {
      this.buying = null;
      await this.put(mark.id);
      return;
    }
    // Невыданная отметка не молчит: нажатие рассказывает, за что дают.
    if (mark.price === undefined) {
      this.buying = null;
      this.slotHintEl.textContent = mark.needs ?? '';
      return;
    }
    if (this.tokens < mark.price) {
      this.buying = null;
      this.slotHintEl.textContent = `${mark.price} жетонов · у вас ${this.tokens}`;
      return;
    }
    if (this.buying !== mark.id) {
      this.buying = mark.id;
      this.slotHintEl.textContent = `${mark.price} жетонов · нажмите ещё раз`;
      return;
    }
    this.buying = null;
    try {
      const bought = await buy(mark.id);
      this.tokens = bought.tokens;
      this.earned = bought.earned;
      this.slots = bought.slots;
      el<HTMLSpanElement>('cab-tokens').textContent = groupDigits(bought.tokens);
      // Купленное сразу надевается: за ним и шли.
      await this.put(mark.id);
      this.showFrame();
      this.slotHintEl.textContent = `осталось ${bought.tokens} жетонов`;
    } catch {
      this.slotHintEl.textContent = 'не купилось — попробуйте ещё раз';
    }
  }

  /**
   * Нажатие по ячейке. Открытая просто выбирается; закрытая называет цену,
   * а второе нажатие её покупает — тем же движением, что наклейка и оправа.
   */
  private async pickSlot(index: number): Promise<void> {
    if (index < this.slots) {
      this.buying = null;
      this.slot = index;
      this.showMarks(this.marks);
      return;
    }
    // Ячейки открываются подряд: третья без второй ничего не даёт.
    if (index > this.slots) {
      this.buying = null;
      this.slotHintEl.textContent = `Сначала ячейка ${this.slots + 1}`;
      return;
    }
    const id = slotItem(index);
    const price = slotPrice(index);
    if (id === null || price === null) return;
    if (this.tokens < price) {
      this.buying = null;
      this.slotHintEl.textContent = `Ячейка ${index + 1} · ${price} жетонов · у вас ${this.tokens}`;
      return;
    }
    if (this.buying !== id) {
      this.buying = id;
      this.slotHintEl.textContent = `Ячейка ${index + 1} · ${price} жетонов · нажмите ещё раз`;
      return;
    }
    this.buying = null;
    try {
      const bought = await buy(id);
      this.tokens = bought.tokens;
      this.earned = bought.earned;
      this.slots = bought.slots;
      el<HTMLSpanElement>('cab-tokens').textContent = groupDigits(bought.tokens);
      // Открытая ячейка сразу становится выбранной: за ней и шли.
      this.slot = index;
      this.showMarks(this.marks);
      this.slotHintEl.textContent = `Ячейка ${index + 1} открыта · осталось ${bought.tokens} жетонов`;
    } catch {
      this.slotHintEl.textContent = 'не купилось — попробуйте ещё раз';
    }
  }

  /** Ставит шильдик в выбранную ячейку и сразу шлёт корпус на сервер. */
  private async put(id: string | null): Promise<void> {
    const next = [...this.marks];
    next[this.slot] = id;
    this.showMarks(cleanMarks(next));
    this.handlers.onMarks(this.marks);
    try {
      await setMarks(this.marks);
    } catch {
      // Не дошло — корпус свой мы уже перерисовали, соперник увидит позже.
    }
  }

  /** Перерисовывает ячейки и подсветку каталога. */
  private showMarks(marks: (string | null)[]): void {
    this.marks = marks;
    // Выбранной может остаться ячейка, которой уже нет: сервер мог сказать,
    // что открыта одна, пока выбрана была третья.
    if (this.slot >= this.slots) this.slot = this.slots - 1;
    this.slotsEl.innerHTML = '';
    for (let index = 0; index < MARK_SLOTS; index++) {
      const open = index < this.slots;
      const slot = document.createElement('button');
      slot.className = `slot${index === this.slot && open ? ' on' : ''}${open ? '' : ' shut'}`;
      if (open) {
        const mark = marks[index] === null ? undefined : markById(marks[index] ?? '');
        if (mark) slot.appendChild(markChip(mark, isOwnMark(mark.id) ? this.art : null));
      } else {
        // Закрытая ячейка показывает цену: это и есть весь её вид.
        const price = document.createElement('span');
        price.className = 'slot-price';
        price.textContent = `${slotPrice(index) ?? 0}`;
        slot.appendChild(price);
      }
      slot.addEventListener('click', () => void this.pickSlot(index));
      this.slotsEl.appendChild(slot);
    }
    this.slotHintEl.textContent = `Ячейка ${this.slot + 1} · выберите шильдик`;
    for (const pick of this.catalogEl.querySelectorAll<HTMLElement>('.pick')) {
      pick.classList.toggle('on', pick.dataset.mark === marks[this.slot]);
      // Чужое видно всегда: каталог заодно и список того, к чему идти —
      // и целей за игру, и того, что лежит на прилавке.
      pick.classList.toggle('locked', !markAllowed(pick.dataset.mark ?? '', this.earned));
    }
  }

  private async loadFriends(): Promise<void> {
    try {
      this.renderFriends(await getFriends());
    } catch {
      this.friendListEl.innerHTML = '<li class="empty">Список друзей недоступен.</li>';
    }
  }

  private async addByCode(): Promise<void> {
    const answer = prompt('Код друга:');
    if (!answer) return;
    try {
      await addFriend(answer.trim().toUpperCase());
      await this.loadFriends();
    } catch {
      this.friendListEl.innerHTML =
        '<li class="empty">Такого кода нет — проверь и попробуй ещё раз.</li>';
    }
  }

  /** Открывает ввод вместо строки имени: меняем там же, где оно стоит. */
  private startRename(): void {
    this.nameRowEl.hidden = true;
    this.nameEditEl.hidden = false;
    this.setNameNote('Имя меняется один раз', false);
    this.nameInputEl.value = this.nameEl.textContent ?? '';
    this.nameInputEl.focus();
    this.nameInputEl.select();
  }

  /** Закрывает ввод, ничего не меняя. */
  private stopRename(): void {
    this.nameEditEl.hidden = true;
    this.nameRowEl.hidden = false;
  }

  /** Строка под вводом: сперва предупреждение, потом отказ, если он был. */
  private setNameNote(text: string, bad: boolean): void {
    this.nameNoteEl.textContent = text;
    this.nameNoteEl.className = `note${bad ? ' warn' : ''}`;
  }

  private async saveName(): Promise<void> {
    const next = this.nameInputEl.value.trim().slice(0, 24);
    if (next.length === 0) {
      this.setNameNote('Имя не может быть пустым', true);
      return;
    }
    // Прежнее имя менять незачем — и тратить на него единственную замену
    // тем более: закрываем ввод молча.
    if (next === this.nameEl.textContent) {
      this.stopRename();
      return;
    }
    try {
      this.nameEl.textContent = await rename(next);
      // Замена потрачена — карандаш больше не нужен.
      this.renameEl.hidden = true;
      this.stopRename();
    } catch (error) {
      // Отказ по исчерпанной замене — не сбой связи: имя уже меняли, просто
      // на другом устройстве, и карандаш здесь ещё не успел погаснуть.
      if (error instanceof ApiError && error.status === 409) {
        this.renameEl.hidden = true;
        this.stopRename();
        this.loginEl.textContent = 'Имя уже менялось — оно даётся на одну замену';
        return;
      }
      this.setNameNote('Не сохранилось — попробуй ещё раз', true);
    }
  }

  /**
   * Ссылка на мини-приложение приезжает с сервера уже после открытия — и
   * может приехать позже, чем откроется кабинет.
   */
  setMiniApp(url: string | null): void {
    this.miniApp = url;
    this.showLink();
  }

  /**
   * Кнопку привязки показываем тому, у кого Telegram ещё не привязан, и
   * только если бот вообще настроен.
   */
  private showLink(): void {
    const button = el<HTMLButtonElement>('cab-link-tg');
    button.hidden = this.hasTelegram || this.miniApp === null;
    if (!button.hidden && this.linkUrl === null) button.textContent = 'Привязать Telegram';
  }

  /**
   * Дозапрашивает настройки сервера. Раньше их спрашивали один раз при
   * запуске игры, и если сервер в тот миг ещё не знал имени бота, привязка
   * Telegram пропадала до перезагрузки страницы. Спрашиваем при каждом
   * открытии кабинета, пока не узнаем.
   */
  private async askConfig(): Promise<void> {
    if (this.miniApp !== null) return;
    try {
      this.setMiniApp((await getConfig()).miniApp);
    } catch {
      // Бот не настроен или сервер молчит — привязку просто не показываем.
    }
  }

  /**
   * Привязка Telegram к аккаунту, заведённому в браузере. Одноразовый код
   * уезжает в бота ссылкой: initData в обычном браузере взять неоткуда, и
   * без этого у человека завёлся бы второй профиль.
   */
  private async linkTelegram(): Promise<void> {
    const button = el<HTMLButtonElement>('cab-link-tg');
    // Второе нажатие уходит по уже взятой ссылке этой же вкладкой. Так
    // бывает, когда браузер не дал открыть новую: между нажатием и открытием
    // мы успели сходить на сервер, и для браузера это уже не нажатие
    // человека, а самовольное окно — он его гасит молча.
    if (this.linkUrl !== null) {
      location.href = this.linkUrl;
      return;
    }
    button.disabled = true;
    try {
      const { url } = await telegramLinkUrl();
      this.linkUrl = url;
      // Внутри Telegram переход просим сделать сам мессенджер.
      const opened = openInTelegram(url) || window.open(url, '_blank', 'noopener') !== null;
      button.textContent = opened ? 'Подтверди в Telegram…' : 'Открыть Telegram';
    } catch {
      button.textContent = 'Пока недоступно';
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Сетка смайликов. Собирается при первом открытии, а не при заводе
   * кабинета: знаков в наборе больше тысячи, и заводить столько кнопок тому,
   * кто в профиль не заходил, незачем. Дальше сетка живёт готовой — меняется
   * в ней только подсветка выбранного.
   */
  private buildFaces(): void {
    if (this.facesEl.childElementCount > 0) return;
    // Кнопки складываем в отрывок и вставляем разом: тысяча вставок подряд
    // заставила бы страницу пересчитывать раскладку тысячу раз.
    const batch = document.createDocumentFragment();
    for (const face of FACES) {
      const pick = document.createElement('button');
      pick.dataset.face = face;
      pick.textContent = face;
      pick.addEventListener('click', () => void this.setFace(face));
      batch.appendChild(pick);
    }
    this.facesEl.appendChild(batch);
  }

  /** Открывает и закрывает сетку: нажатие на фото — то же самое движение. */
  private toggleFaces(): void {
    if (!this.facesEl.hidden) {
      this.facesEl.hidden = true;
      return;
    }
    this.buildFaces();
    this.facesEl.hidden = false;
    this.showAvatar(this.photoEl.textContent ?? '');
    // Прокручиваем к выбранному: искать его в тысяче знаков глазами — не
    // выбор, а поиск.
    this.facesEl.querySelector('button.on')?.scrollIntoView({ block: 'center' });
  }

  /** Ставит смайлик на пропуск и закрывает сетку. */
  private async setFace(face: string): Promise<void> {
    const previous = this.photoEl.textContent ?? '';
    this.showAvatar(face);
    this.facesEl.hidden = true;
    try {
      await setAvatar(face);
    } catch {
      // Сервер не принял: вернём как было и скажем прямо. Набор закрытый, так
      // что причина тут может быть только одна — до сервера не дошло.
      this.showAvatar(previous);
      this.loginEl.textContent = 'Смайлик не сохранился — сервер не ответил';
    }
  }

  /** Пустая строка возвращает силуэт: место под фото снова свободно. */
  private showAvatar(emoji: string): void {
    this.photoEl.textContent = emoji;
    this.photoEl.classList.toggle('has-emoji', emoji.length > 0);
    for (const pick of this.facesEl.querySelectorAll<HTMLElement>('button')) {
      pick.classList.toggle('on', pick.dataset.face === emoji);
    }
  }

  private renderProfile(me: MeResponse): void {
    // Корпус игрока знает сервер: он же показывает его сопернику. И он же
    // гасит золото, когда место в таблице потеряно, — свой корпус поэтому
    // приводим к серверному, а не к тому, что помнит устройство.
    this.earned = me.earned;
    this.tokens = me.tokens;
    this.slots = me.slots;
    this.frame = me.frame;
    this.showFrame();
    this.handlers.onFrame(me.frame);
    // Рисунок приезжает с сервера: на новом телефоне лист чистый, а шильдик
    // на пропуске тот же, что был поставлен со старого.
    this.setArt(me.art);
    this.handlers.onArt(me.art);
    const marks = cleanMarks(me.marks);
    this.showMarks(marks);
    this.handlers.onMarks(marks);
    this.nameEl.textContent = me.name;
    // Замена имени одна на аккаунт: потратил — карандаша больше нет.
    this.renameEl.hidden = !me.canRename;
    this.showAvatar(me.avatar ?? '');
    const logins = me.identities.map((identity) => LOGIN_NAMES[identity.kind] ?? identity.kind);
    this.loginEl.textContent = `вход: ${logins.join(', ')}`;
    this.hasTelegram = me.identities.some((identity) => identity.kind === 'telegram');
    this.showLink();

    el<HTMLSpanElement>('cab-tokens').textContent = groupDigits(me.tokens);
    // Рейтингов два: дуэли на цепочках и дуэли в тапе — разные механики,
    // и общее число врало бы про обе. Рекордов заходов тоже два, по механике
    // на каждый, — вместе это и есть «по всем режимам».
    const best = (value: number): string => (value === 0 ? '—' : groupDigits(value));
    this.renderBoards([
      {
        name: 'Дуэль · цепочки',
        value: String(me.rating),
        place: me.rank,
        open: () => this.handlers.onRatingBoard('chain'),
      },
      {
        name: 'Дуэль · тап',
        value: String(me.orderDuel.rating),
        place: me.orderDuel.rank,
        open: () => this.handlers.onRatingBoard('order'),
      },
      {
        name: 'Цепочки · рекорд',
        value: best(me.sprint.best),
        place: me.sprint.rank,
        open: () => this.handlers.onSprintBoard(),
      },
      {
        name: 'Тап · рекорд',
        value: best(me.order.best),
        place: me.order.rank,
        open: () => this.handlers.onOrderBoard(),
      },
    ]);
    // Дуэли своей таблицы не имеют — они и есть то, из чего складываются обе
    // верхние строки, поэтому счёт побед стоит под ними подписью.
    el<HTMLSpanElement>('cab-duels').textContent =
      me.duels.played === 0
        ? 'дуэлей ещё не было'
        : `дуэлей ${me.duels.played} · побед ${me.duels.won}`;
    // Подписи разделов: в столбике должно быть видно, что за строкой.
    this.setNote('rating', me.placement ? 'калибровка' : me.league);
    this.setNote('history', me.duels.played === 0 ? '—' : String(me.duels.played));
    // Считаем не выданное, а носимое: кличка есть у всех даром, и «0 из 64»
    // на полном каталоге кличек читалось бы как поломка.
    const mine = MARKS.filter((mark) => markAllowed(mark.id, me.earned)).length;
    this.setNote('marks', `${mine} из ${MARKS.length}`);

    this.leagueEl.innerHTML =
      '<span class="league-name"></span>' +
      '<div class="league-bar"><i></i></div>' +
      '<span class="league-note"></span>';
    const [nameEl, barEl, noteEl] = [...this.leagueEl.children] as HTMLElement[];

    if (me.placement) {
      // Лига до калибровки не присвоена — показываем, сколько осталось.
      const { played, required } = me.placement;
      nameEl!.textContent = 'Калибровка';
      (barEl!.firstElementChild as HTMLElement).style.width = `${(played / required) * 100}%`;
      noteEl!.textContent = `${played} из ${required} рейтинговых дуэлей — потом лига`;
      return;
    }

    nameEl!.textContent = me.league;
    if (me.next) {
      // Путь внутри текущей лиги: от её нижней границы до следующей.
      const span = me.rating + me.next.gap - me.leagueFrom;
      const done = span > 0 ? ((me.rating - me.leagueFrom) / span) * 100 : 0;
      (barEl!.firstElementChild as HTMLElement).style.width = `${Math.max(4, done)}%`;
      noteEl!.textContent = `до лиги «${me.next.league}» ещё ${me.next.gap}`;
    } else {
      (barEl!.firstElementChild as HTMLElement).style.width = '100%';
      noteEl!.textContent = 'высшая лига';
    }
  }

  /**
   * Штрихкод сотрудника. Рисуется из кода друга: у каждого игрока свой и
   * не меняется со временем. Это рисунок, а не Code 39 — сканировать его
   * нечем и незачем, код диктуют словами. Зато он делает пропуск
   * пропуском, а число под ним — настоящее.
   */
  private renderBarcode(code: string): void {
    const box = el<HTMLElement>('cab-barcode');
    // Ширины полос выводим из самих символов кода — отсюда и уникальность.
    const widths: number[] = [2, 1, 1, 1, 2];
    for (const ch of code) {
      const n = ch.charCodeAt(0);
      // Восемь полос на символ — штрихи выходят тонкими и частыми, как на
      // настоящем пропуске; пяти было мало, они читались забором.
      for (let bit = 0; bit < 8; bit++) widths.push(1 + ((n >> bit) & 1));
      widths.push(1, 1);
    }
    widths.push(2, 1, 1, 1, 2);

    const unit = 240 / widths.reduce((sum, w) => sum + w, 0);
    let x = 0;
    const bars = widths.map((w, i) => {
      const rect =
        i % 2 === 0
          ? `<rect x="${(x * unit).toFixed(2)}" y="0" width="${(w * unit).toFixed(2)}" height="52" fill="var(--silk)"/>`
          : '';
      x += w;
      return rect;
    });
    box.innerHTML = bars.join('');
  }

  private renderFriends(data: FriendsResponse): void {
    el<HTMLSpanElement>('cab-code').textContent = data.code;
    this.renderBarcode(data.code);
    this.setNote('friends', data.friends.length === 0 ? '—' : String(data.friends.length));

    this.friendListEl.innerHTML = '';
    if (data.friends.length === 0) {
      this.friendListEl.innerHTML =
        '<li class="empty">Друзей пока нет. Дай свой код или добавь по чужому.</li>';
    }
    for (const friend of data.friends) {
      const item = document.createElement('li');
      item.innerHTML =
        '<span class="mark"></span>' +
        '<span class="who"><b></b><span class="when"></span></span>' +
        '<span class="vs"></span><button class="act">Позвать</button>';
      const who = item.children[1] as HTMLElement;
      (who.children[0] as HTMLElement).textContent = friend.name;
      (who.children[1] as HTMLElement).textContent = friend.provisional
        ? 'калибровка'
        : `${friend.league} · ${friend.rating}`;
      // Личный счёт важнее общего рейтинга: с друзьями меряются им.
      (item.children[2] as HTMLElement).textContent =
        friend.record.played > 0
          ? `${friend.record.won}:${friend.record.played - friend.record.won}`
          : '';

      const invite = item.children[3] as HTMLButtonElement;
      invite.addEventListener('click', () => {
        this.hide();
        this.handlers.onInvite(friend.code);
      });
      // Удалить друга — долгим нажатием на строку, чтобы не плодить кнопки.
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (!confirm(`Удалить ${friend.name} из друзей?`)) return;
        void removeFriend(friend.code).then(() => this.loadFriends());
      });
      this.friendListEl.appendChild(item);
    }

    el<HTMLHeadingElement>('recent-title').hidden = data.recent.length === 0;
    this.recentListEl.innerHTML = '';
    for (const opponent of data.recent) {
      const item = document.createElement('li');
      item.innerHTML =
        '<span class="mark"></span>' +
        '<span class="who"><b></b><span class="when"></span></span>' +
        '<span class="vs"></span><button class="act">+ в друзья</button>';
      const who = item.children[1] as HTMLElement;
      (who.children[0] as HTMLElement).textContent = opponent.name;
      (who.children[1] as HTMLElement).textContent = shortDate(opponent.playedAt);
      (item.children[3] as HTMLButtonElement).addEventListener('click', () => {
        void addFriend(opponent.code).then(() => this.loadFriends());
      });
      this.recentListEl.appendChild(item);
    }
  }

  private renderHistory(entries: DuelHistoryEntry[]): void {
    this.historyEl.innerHTML = '';
    if (entries.length === 0) {
      this.historyEl.innerHTML = '<li class="empty">Матчей ещё не было. Сыграй дуэль!</li>';
      return;
    }

    for (const entry of entries) {
      const item = document.createElement('li');
      item.className = entry.outcome ?? '';
      item.innerHTML =
        '<span class="mark"></span>' +
        '<span class="who"><b></b><span class="when"></span></span>' +
        '<span class="pts"></span><span class="rd"></span>';
      const who = item.children[1] as HTMLElement;
      const opponent = entry.opponent ?? 'Соперник';
      (who.children[0] as HTMLElement).textContent = entry.ghost
        ? `${opponent} · запись`
        : opponent;
      // Дата и механика: по счёту 700:600 не понять, во что играли.
      (who.children[1] as HTMLElement).textContent =
        `${shortDate(entry.playedAt)} · ${entry.kind === 'order' ? 'тап' : 'цепочки'}`;
      (item.children[2] as HTMLElement).textContent =
        `${entry.score}:${entry.opponentScore ?? 0}`;

      const delta = item.children[3] as HTMLElement;
      if (entry.rating) {
        const change = entry.rating.after - entry.rating.before;
        delta.textContent = `${change > 0 ? '+' : ''}${change}`;
        delta.className = `rd ${change > 0 ? 'up' : change < 0 ? 'down' : ''}`;
      }

      if (entry.replay) {
        item.classList.add('playable');
        item.title = 'Посмотреть партию';
        item.addEventListener('click', () => {
          this.hide();
          this.handlers.onReplay(entry.duelId);
        });
      }
      this.historyEl.appendChild(item);
    }
  }
}
