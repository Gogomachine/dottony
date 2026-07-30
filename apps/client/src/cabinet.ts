import type { DuelHistoryEntry, FriendsResponse, MeResponse } from '@doton/protocol';
import {
  addFriend,
  getFriends,
  getHistory,
  getMe,
  openInTelegram,
  removeFriend,
  rename,
  telegramLinkUrl,
} from './api';
import { emblemSvg } from './emblem';

/**
 * Личный кабинет: кто я, какая лига, что сыграно.
 *
 * Живёт отдельным окном поверх игры и ничего о ней не знает — партия под
 * ним не трогается. Наружу отдаёт только действия, которые меняют игру:
 * прокрутить матч и открыть таблицу рейтинга.
 */

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

/** «12 марта» — дата матча без года: история короткая, год избыточен. */
function shortDate(iso: string): string {
  const parsed = new Date(`${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export interface CabinetHandlers {
  onReplay(duelId: string): void;
  onRatingBoard(): void;
  /** Имя поменялось — снаружи его показывают ещё в паре мест. */
  onRenamed(name: string): void;
  /**
   * Позвать друга в матч: снаружи это открывает приватную комнату.
   * Код друга нужен, чтобы дослать приглашение сообщением в Telegram.
   */
  onInvite(friendCode: string): void;
}

export class Cabinet {
  private readonly overlay = el<HTMLDivElement>('cabinet');
  private readonly nameEl = el<HTMLSpanElement>('cab-name');
  private readonly loginEl = el<HTMLSpanElement>('cab-login');
  private readonly leagueEl = el<HTMLDivElement>('cab-league');
  private readonly historyEl = el<HTMLOListElement>('cab-history');
  private readonly friendsEl = el<HTMLDivElement>('cab-friends');
  private readonly friendListEl = el<HTMLOListElement>('friend-list');
  private readonly recentListEl = el<HTMLOListElement>('recent-list');
  private readonly historyTab = el<HTMLButtonElement>('tab-history');
  private readonly friendsTab = el<HTMLButtonElement>('tab-friends');
  private miniApp: string | null = null;

  constructor(private readonly handlers: CabinetHandlers) {
    el<HTMLDivElement>('cab-emblem').innerHTML = emblemSvg({ size: 46 });
    this.historyTab.addEventListener('click', () => this.openTab('history'));
    this.friendsTab.addEventListener('click', () => this.openTab('friends'));
    el<HTMLButtonElement>('cab-add-friend').addEventListener('click', () => void this.addByCode());
    el<HTMLButtonElement>('cab-link-tg').addEventListener('click', () => void this.linkTelegram());
    el<HTMLButtonElement>('cab-close').addEventListener('click', () => this.hide());
    el<HTMLButtonElement>('cab-rating-board').addEventListener('click', () => {
      this.hide();
      handlers.onRatingBoard();
    });
    el<HTMLButtonElement>('cab-rename').addEventListener('click', () => void this.rename());
    // Клик мимо окна закрывает кабинет — привычный жест.
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.hide();
    });
  }

  get visible(): boolean {
    return !this.overlay.hidden;
  }

  hide(): void {
    this.overlay.hidden = true;
  }

  /** Открывает кабинет и подтягивает свежие данные. */
  async show(tab: 'history' | 'friends' = 'history'): Promise<void> {
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

  private openTab(tab: 'history' | 'friends'): void {
    const friends = tab === 'friends';
    this.historyEl.hidden = friends;
    this.friendsEl.hidden = !friends;
    this.historyTab.classList.toggle('active', !friends);
    this.friendsTab.classList.toggle('active', friends);
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
      const saved = await rename(next);
      this.nameEl.textContent = saved;
      this.handlers.onRenamed(saved);
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

  private renderProfile(me: MeResponse): void {
    this.nameEl.textContent = me.name;
    const logins = me.identities.map((identity) => LOGIN_NAMES[identity.kind] ?? identity.kind);
    this.loginEl.textContent = `вход: ${logins.join(', ')}`;
    // Кнопку привязки показываем только тем, у кого Telegram ещё не привязан.
    const hasTelegram = me.identities.some((identity) => identity.kind === 'telegram');
    const linkBtn = el<HTMLButtonElement>('cab-link-tg');
    linkBtn.hidden = hasTelegram || this.miniApp === null;
    if (!linkBtn.hidden) linkBtn.textContent = 'Привязать Telegram';

    el<HTMLSpanElement>('cab-rating').textContent = String(me.rating);
    el<HTMLSpanElement>('cab-rank').textContent = me.rank === null ? '—' : `#${me.rank}`;
    el<HTMLSpanElement>('cab-duels').textContent = `${me.duels.won}/${me.duels.played}`;
    el<HTMLSpanElement>('cab-daily').textContent =
      me.daily.best === null ? '—' : String(me.daily.best);

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

  private renderFriends(data: FriendsResponse): void {
    el<HTMLSpanElement>('cab-code').textContent = data.code;

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
