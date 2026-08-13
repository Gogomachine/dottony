import { cleanMarks, markById, MARKS } from '@doton/core';
import type { DuelHistoryEntry, FriendsResponse, MeResponse } from '@doton/protocol';
import {
  addFriend,
  setAvatar,
  setMarks,
  getFriends,
  getHistory,
  getMe,
  openInTelegram,
  removeFriend,
  rename,
  telegramLinkUrl,
} from './api';
import { brandLockup } from './brand';
import { markChip } from './plate';

/**
 * Личный кабинет: кто я, какая лига, что сыграно.
 *
 * Живёт отдельным окном поверх игры и ничего о ней не знает — партия под
 * ним не трогается. Наружу отдаёт только действия, которые меняют игру:
 * прокрутить матч и открыть таблицу рейтинга.
 */

/** Что открыто в кабинете под шапкой профиля. */
type CabTab = 'history' | 'friends' | 'marks';

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

/**
 * Отметки наработки. Пока они только показывают, куда игрок движется;
 * награды за них появятся отдельной механикой, и тогда эти же числа
 * переедут в общий модуль вместе с достижениями.
 */
const MILESTONES = [10_000, 100_000, 1_000_000, 10_000_000];

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
  onRatingBoard(): void;
  /** Таблица рекордов спринта. */
  onSprintBoard(): void;
  /** Таблица рекордов заказов. */
  onOrderBoard(): void;
  /**
   * Позвать друга в матч: снаружи это открывает приватную комнату.
   * Код друга нужен, чтобы дослать приглашение сообщением в Telegram.
   */
  onInvite(friendCode: string): void;
  /** Игрок сменил шильдики: корпус на игровом экране рисует не кабинет. */
  onMarks(marks: (string | null)[]): void;
}

export class Cabinet {
  private readonly overlay = el<HTMLDivElement>('cabinet');
  private readonly nameEl = el<HTMLSpanElement>('cab-name');
  private readonly loginEl = el<HTMLSpanElement>('cab-login');
  private readonly photoEl = el<HTMLDivElement>('cab-photo');
  private readonly leagueEl = el<HTMLDivElement>('cab-league');
  private readonly historyEl = el<HTMLOListElement>('cab-history');
  private readonly friendsEl = el<HTMLDivElement>('cab-friends');
  private readonly friendListEl = el<HTMLOListElement>('friend-list');
  private readonly recentListEl = el<HTMLOListElement>('recent-list');
  private readonly historyTab = el<HTMLButtonElement>('tab-history');
  private readonly friendsTab = el<HTMLButtonElement>('tab-friends');
  private readonly marksTab = el<HTMLButtonElement>('tab-marks');
  private readonly marksEl = el<HTMLDivElement>('cab-marks');
  private readonly slotsEl = el<HTMLDivElement>('cab-slots');
  private readonly slotHintEl = el<HTMLSpanElement>('cab-slot-hint');
  private readonly catalogEl = el<HTMLDivElement>('cab-catalog');
  /** Выбранные шильдики, выданные отметки и ячейка, которую заполняют. */
  private marks: (string | null)[] = cleanMarks([]);
  private earned: string[] = [];
  private slot = 0;
  private miniApp: string | null = null;

  constructor(private readonly handlers: CabinetHandlers) {
    el<HTMLSpanElement>('cab-brand').innerHTML = brandLockup(116);
    this.historyTab.addEventListener('click', () => this.openTab('history'));
    this.friendsTab.addEventListener('click', () => this.openTab('friends'));
    this.marksTab.addEventListener('click', () => this.openTab('marks'));
    this.buildCatalog();
    el<HTMLButtonElement>('cab-add-friend').addEventListener('click', () => void this.addByCode());
    el<HTMLButtonElement>('cab-link-tg').addEventListener('click', () => void this.linkTelegram());
    el<HTMLButtonElement>('cab-rating-board').addEventListener('click', () => {
      this.hide();
      handlers.onRatingBoard();
    });
    el<HTMLButtonElement>('cab-sprint-board').addEventListener('click', () => {
      this.hide();
      handlers.onSprintBoard();
    });
    el<HTMLButtonElement>('cab-order-board').addEventListener('click', () => {
      this.hide();
      handlers.onOrderBoard();
    });
    el<HTMLButtonElement>('cab-rename').addEventListener('click', () => void this.rename());
    el<HTMLDivElement>('cab-photo').addEventListener('click', () => void this.pickAvatar());
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

  /** Открывает кабинет и подтягивает свежие данные. */
  async show(tab: CabTab = 'history'): Promise<void> {
    this.overlay.hidden = false;
    this.openTab(tab);
    this.historyEl.innerHTML = '<li class="empty">Загружаю…</li>';
    try {
      const [me, history] = await Promise.all([getMe(), getHistory()]);
      this.renderProfile(me);
      this.renderHistory(history.entries);
    } catch {
      this.historyEl.innerHTML = '<li class="empty">Профиль недоступен — сервер не ответил.</li>';
    }
    await this.loadFriends();
  }

  private openTab(tab: CabTab): void {
    this.historyEl.hidden = tab !== 'history';
    this.friendsEl.hidden = tab !== 'friends';
    this.marksEl.hidden = tab !== 'marks';
    this.historyTab.classList.toggle('active', tab === 'history');
    this.friendsTab.classList.toggle('active', tab === 'friends');
    this.marksTab.classList.toggle('active', tab === 'marks');
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
      pick.appendChild(markChip(mark));
      pick.addEventListener('click', () => {
        // Невыданная отметка не молчит: нажатие рассказывает, за что дают.
        if (mark.needs !== undefined && !this.earned.includes(mark.id)) {
          this.slotHintEl.textContent = mark.needs;
          return;
        }
        void this.put(mark.id);
      });
      this.catalogEl.appendChild(pick);
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
    this.slotsEl.innerHTML = '';
    marks.forEach((id, index) => {
      const slot = document.createElement('button');
      slot.className = `slot${index === this.slot ? ' on' : ''}`;
      const mark = id === null ? undefined : markById(id);
      if (mark) slot.appendChild(markChip(mark));
      slot.addEventListener('click', () => {
        this.slot = index;
        this.showMarks(this.marks);
      });
      this.slotsEl.appendChild(slot);
    });
    this.slotHintEl.textContent = `Ячейка ${this.slot + 1} · выберите шильдик`;
    for (const pick of this.catalogEl.querySelectorAll<HTMLElement>('.pick')) {
      pick.classList.toggle('on', pick.dataset.mark === marks[this.slot]);
      // Отметку за игру видно всегда: каталог заодно и список целей.
      const locked =
        pick.dataset.needs !== undefined && !this.earned.includes(pick.dataset.mark ?? '');
      pick.classList.toggle('locked', locked);
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

  private async rename(): Promise<void> {
    const answer = prompt('Новое имя:', this.nameEl.textContent ?? '');
    if (answer === null) return;
    const next = answer.trim().slice(0, 24);
    if (next.length === 0) return;
    try {
      this.nameEl.textContent = await rename(next);
    } catch {
      this.loginEl.textContent = 'Имя не сохранилось — попробуй ещё раз';
    }
  }

  /** Ссылка на мини-приложение приезжает с сервера уже после открытия. */
  setMiniApp(url: string | null): void {
    this.miniApp = url;
  }

  /**
   * Привязка Telegram к аккаунту, заведённому в браузере. Одноразовый код
   * уезжает в бота ссылкой: initData в обычном браузере взять неоткуда, и
   * без этого у человека завёлся бы второй профиль.
   */
  private async linkTelegram(): Promise<void> {
    const button = el<HTMLButtonElement>('cab-link-tg');
    button.disabled = true;
    try {
      const { url } = await telegramLinkUrl();
      // Внутри Telegram переход просим сделать сам мессенджер.
      if (!openInTelegram(url)) window.open(url, '_blank', 'noopener');
      button.textContent = 'Подтверди в Telegram…';
    } catch {
      button.textContent = 'Пока недоступно';
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Смайлик вместо фотографии. Спрашиваем системным окном: на телефоне оно
   * открывает клавиатуру смайликов, а это ровно то, что нужно.
   */
  private async pickAvatar(): Promise<void> {
    const answer = prompt('Смайлик на пропуск:', this.photoEl.textContent ?? '');
    if (answer === null) return;
    const emoji = answer.trim();
    if (emoji.length === 0) return;

    const previous = this.photoEl.textContent ?? '';
    this.showAvatar(emoji);
    try {
      await setAvatar(emoji);
    } catch {
      // Сервер не принял: вернём как было и скажем прямо.
      this.showAvatar(previous);
      this.loginEl.textContent = 'Нужен смайлик — буквы и цифры не подойдут';
    }
  }

  /** Пустая строка возвращает силуэт: место под фото снова свободно. */
  private showAvatar(emoji: string): void {
    this.photoEl.textContent = emoji;
    this.photoEl.classList.toggle('has-emoji', emoji.length > 0);
  }

  private renderProfile(me: MeResponse): void {
    // Корпус игрока знает сервер: он же показывает его сопернику.
    this.earned = me.earned;
    this.showMarks(cleanMarks(me.marks));
    this.nameEl.textContent = me.name;
    this.showAvatar(me.avatar ?? '');
    const logins = me.identities.map((identity) => LOGIN_NAMES[identity.kind] ?? identity.kind);
    this.loginEl.textContent = `вход: ${logins.join(', ')}`;
    // Кнопку привязки показываем только тем, у кого Telegram ещё не привязан.
    const hasTelegram = me.identities.some((identity) => identity.kind === 'telegram');
    const linkBtn = el<HTMLButtonElement>('cab-link-tg');
    linkBtn.hidden = hasTelegram || this.miniApp === null;
    if (!linkBtn.hidden) linkBtn.textContent = 'Привязать Telegram';

    this.renderTotal(me.total);
    el<HTMLSpanElement>('cab-rating').textContent = String(me.rating);
    el<HTMLSpanElement>('cab-rank').textContent = me.rank === null ? '—' : `#${me.rank}`;
    el<HTMLSpanElement>('cab-duels').textContent = `${me.duels.won}/${me.duels.played}`;
    // Рекорд спринта — вместе с местом: он интересен в сравнении.
    el<HTMLSpanElement>('cab-sprint').textContent =
      me.sprint.best === 0 ? '—' : groupDigits(me.sprint.best);
    el<HTMLSpanElement>('cab-sprint-rank').textContent =
      me.sprint.rank === null ? 'спринт' : `спринт · #${me.sprint.rank}`;
    // Комбо показываем вместе с местом: рекорд интересен в сравнении.
    el<HTMLSpanElement>('cab-order').textContent =
      me.order.best === 0 ? '—' : groupDigits(me.order.best);
    el<HTMLSpanElement>('cab-order-rank').textContent =
      me.order.rank === null ? 'заказы' : `заказы · #${me.order.rank}`;

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

  /** Наработка и путь до следующей отметки. */
  private renderTotal(total: number): void {
    el<HTMLSpanElement>('cab-total').textContent = groupDigits(total);
    const next = MILESTONES.find((mark) => mark > total);
    const bar = el<HTMLElement>('cab-total-bar');
    const note = el<HTMLSpanElement>('cab-total-next');

    if (next === undefined) {
      bar.style.width = '100%';
      note.textContent = 'все отметки пройдены';
      return;
    }
    // Полосу считаем от предыдущей отметки, иначе на подходе к миллиону
    // она годами стояла бы у нуля.
    const previous = [...MILESTONES].reverse().find((mark) => mark <= total) ?? 0;
    const done = ((total - previous) / (next - previous)) * 100;
    bar.style.width = `${Math.max(2, done)}%`;
    note.textContent = `до ${groupDigits(next)} — ещё ${groupDigits(next - total)}`;
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
      (who.children[1] as HTMLElement).textContent = shortDate(entry.playedAt);
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
