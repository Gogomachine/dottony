import type { DuelHistoryEntry, MeResponse } from '@doton/protocol';
import { getHistory, getMe, rename } from './api';
import { mascotSvg } from './mascot';

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
}

export class Cabinet {
  private readonly overlay = el<HTMLDivElement>('cabinet');
  private readonly nameEl = el<HTMLSpanElement>('cab-name');
  private readonly loginEl = el<HTMLSpanElement>('cab-login');
  private readonly leagueEl = el<HTMLDivElement>('cab-league');
  private readonly historyEl = el<HTMLOListElement>('cab-history');

  constructor(private readonly handlers: CabinetHandlers) {
    el<HTMLDivElement>('cab-mascot').innerHTML = mascotSvg({ size: 46 });
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
  async show(): Promise<void> {
    this.overlay.hidden = false;
    this.historyEl.innerHTML = '<li class="empty">Загружаю…</li>';
    try {
      const [me, history] = await Promise.all([getMe(), getHistory()]);
      this.renderProfile(me);
      this.renderHistory(history.entries);
    } catch {
      this.historyEl.innerHTML = '<li class="empty">Профиль недоступен — сервер не ответил.</li>';
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

  private renderProfile(me: MeResponse): void {
    this.nameEl.textContent = me.name;
    const logins = me.identities.map((identity) => LOGIN_NAMES[identity.kind] ?? identity.kind);
    this.loginEl.textContent = `вход: ${logins.join(', ')}`;

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
