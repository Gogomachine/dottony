import { isOwnMark, markById, type Mark } from '@doton/core';
import type { AdminCard, AdminFound, MeResponse } from '@doton/protocol';
import {
  adminBan,
  adminCard,
  adminClearArt,
  adminClearReports,
  adminReports,
  adminFind,
  adminLog,
  adminName,
  adminNotices,
  adminTokens,
  adminUnban,
  ApiError,
  getMe,
} from './api';
import { markChip, artPicture } from './plate';

/**
 * Служебный пульт: поиск игрока, его карточка и три действия — жетоны,
 * снять рисунок, сменить имя. Каждое пишется в журнал вместе с причиной.
 *
 * Пульт живёт отдельной страницей, а не разделом кабинета: это инструмент
 * за столом, а не часть прибора. Права он не даёт — он их показывает: кто
 * служащий, решает список номеров в настройках сервера, и без служащего
 * токена сервер отвечает пульту «нет такой страницы».
 *
 * Входит служащий обычным способом — тем же аккаунтом, что и играет. В
 * браузере на столе это значит «открыть игру, привязать Telegram в кабинете
 * и вернуться сюда»: аккаунт у пульта и у игры один и тот же.
 */

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

const shutEl = el<HTMLDivElement>('shut');
const shutNoteEl = el<HTMLSpanElement>('shut-note');
const shutHintEl = el<HTMLSpanElement>('shut-hint');
const shutKeysEl = el<HTMLDivElement>('shut-keys');
const findCardEl = el<HTMLDivElement>('find-card');
const reportsCardEl = el<HTMLDivElement>('reports-card');
const reportsEl = el<HTMLDivElement>('reports');
const reportsNoteEl = el<HTMLSpanElement>('reports-note');
const noticesCardEl = el<HTMLDivElement>('notices-card');
const noticesEl = el<HTMLDivElement>('notices');
const noticesNoteEl = el<HTMLSpanElement>('notices-note');
const foundEl = el<HTMLTableElement>('found');
const findNoteEl = el<HTMLSpanElement>('find-note');
const playerEl = el<HTMLDivElement>('player');
const logCardEl = el<HTMLDivElement>('log-card');
const logEl = el<HTMLTableElement>('log');
const queryEl = el<HTMLInputElement>('q');

/** «12 марта, 19:04» — журналу нужны и день, и час. */
function moment(iso: string): string {
  const parsed = new Date(`${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function cell(row: HTMLTableRowElement, text: string, cls = ''): HTMLTableCellElement {
  const td = row.insertCell();
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

/**
 * Почему пульт не открылся. Про службу здесь не говорится ничего — только
 * про того, кто пришёл, и только ему самому: свой способ входа и свой номер
 * в Telegram. Сначала было одно «Пульт недоступен.» на все случаи, и это
 * оказалось глухо не для постороннего (тому и правда объяснять нечего), а
 * для хозяина: закрытый пульт нечем отличить от опечатки в настройке или от
 * сервера, до которого ещё не доехало обновление.
 */
function why(me: MeResponse): string {
  // Поля `admin` нет вовсе — значит, сервер старее этой страницы.
  if ((me as { admin?: boolean }).admin === undefined) {
    return 'Сервер старее пульта: службы на нём ещё нет. Обнови сервер.';
  }
  if (me.telegram === null) {
    return (
      'Вход: гость. Пульт узнаёт служащего по Telegram — ' +
      'открой игру, в кабинете нажми «Привязать Telegram» и вернись сюда.'
    );
  }
  return `Вход: Telegram · ${me.telegram}. Пульт открыт тому, чей номер стоит в ADMIN_TELEGRAM_IDS на сервере.`;
}

async function open(): Promise<void> {
  shutEl.hidden = false;
  shutKeysEl.hidden = true;
  shutHintEl.textContent = '';
  try {
    const me = await getMe();
    el<HTMLSpanElement>('who').textContent = `${me.name}${me.admin ? ' · служба' : ''}`;
    if (!me.admin) {
      shutNoteEl.textContent = why(me);
      // Пульт — эта самая страница, и с закрытой двери это не очевидно:
      // ссылка «Открыть игру» рядом с отказом читалась как «панель там».
      shutHintEl.textContent =
        'Пульт — эта страница. Ничего открывать не нужно: поправь настройку и нажми «Проверить снова».';
      shutKeysEl.hidden = false;
      return;
    }
  } catch (error) {
    // Токена нет вовсе — сюда пришли, не открыв игру ни разу.
    shutNoteEl.textContent =
      error instanceof ApiError && error.status === 0
        ? 'Прибор не отвечает.'
        : 'Сначала открой игру: пульт входит тем же аккаунтом, что и она.';
    return;
  }
  shutEl.hidden = true;
  reportsCardEl.hidden = false;
  noticesCardEl.hidden = false;
  findCardEl.hidden = false;
  logCardEl.hidden = false;
  await Promise.all([showReports(), showNotices(), showLog()]);
}

/**
 * Очередь жалоб. Сгруппирована по тому, на кого жалуются: три жалобы на
 * одного — это сигнал, а тот же список по одной строке на жалобу заставлял
 * бы считать их глазами.
 */
async function showReports(): Promise<void> {
  try {
    const { reports } = await adminReports();
    reportsEl.innerHTML = '';
    reportsNoteEl.textContent = reports.length === 0 ? 'Пусто — и хорошо.' : '';
    for (const report of reports) {
      const row = document.createElement('div');
      row.className = 'report';

      // Пустое стекло рядом с именем ничего не говорит: у кого рисунка нет,
      // тому и места под него в строке не нужно.
      if (report.art !== null) {
        const art = document.createElement('div');
        art.className = 'art-box';
        art.appendChild(artPicture(report.art));
        row.appendChild(art);
      }

      const who = document.createElement('div');
      who.className = 'who';
      const name = document.createElement('b');
      name.textContent = report.targetName;
      who.appendChild(name);
      const facts = document.createElement('div');
      facts.className = 'note';
      facts.textContent =
        `жалоб: ${report.count} · последняя ${moment(report.lastAt)}` +
        (report.ban ? ' · прибор уже изъят' : '');
      who.appendChild(facts);
      row.appendChild(who);

      const open = document.createElement('button');
      open.textContent = 'Карточка';
      open.addEventListener('click', () => void showPlayer(report.targetId));
      row.appendChild(open);

      const done = document.createElement('button');
      done.textContent = 'Разобрано';
      done.addEventListener('click', () => {
        void (async () => {
          done.disabled = true;
          try {
            await adminClearReports(report.targetId, 'разобрано из очереди');
            await Promise.all([showReports(), showLog()]);
          } catch {
            done.disabled = false;
            reportsNoteEl.textContent = 'Не вышло.';
          }
        })();
      });
      row.appendChild(done);

      reportsEl.appendChild(row);
    }
  } catch {
    reportsNoteEl.textContent = 'Очередь не открылась.';
  }
}

/**
 * Замеченное прибором: заходы, не похожие на человеческие.
 *
 * Строка называет игрока, место (турнир или рекорд), счёт и словами то, что
 * заметили. Отдельным числом — сколько раз прибор видел этого человека:
 * один раз ничего не значит, десять — уже почерк, и именно счётчик, а не
 * отдельная строка, решает, стоит ли открывать карточку.
 *
 * Кнопки «разобрано» здесь нет: жалобу закрывают, потому что её кто-то
 * подал, а измеренное закрывать не от кого. Служащий смотрит карточку и,
 * если решит, изымает прибор — это и будет записью в журнале.
 */
async function showNotices(): Promise<void> {
  try {
    const { notices } = await adminNotices();
    noticesEl.innerHTML = '';
    noticesNoteEl.textContent =
      notices.length === 0
        ? 'Пусто. Прибор смотрит на заходы турнира и на новые рекорды цепочек.'
        : 'Это не приговор: сильная игра и перебор различаются числом, а не природой. Смотри карточку.';
    for (const notice of notices) {
      const row = document.createElement('div');
      row.className = 'report';

      const who = document.createElement('div');
      who.className = 'who';
      const name = document.createElement('b');
      name.textContent = notice.name;
      who.appendChild(name);
      const facts = document.createElement('div');
      facts.className = 'note';
      facts.textContent = `${notice.place} · ${notice.score} · ${notice.detail} · ${moment(notice.at)}`;
      who.appendChild(facts);
      row.appendChild(who);

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `×${notice.count}`;
      row.appendChild(count);

      const card = document.createElement('button');
      card.textContent = 'Карточка';
      card.addEventListener('click', () => void showPlayer(notice.userId));
      row.appendChild(card);

      noticesEl.appendChild(row);
    }
  } catch {
    noticesNoteEl.textContent = 'Список не открылся.';
  }
}

async function find(): Promise<void> {
  const query = queryEl.value.trim();
  if (query.length === 0) return;
  findNoteEl.textContent = 'Ищу…';
  foundEl.hidden = true;
  try {
    const { found } = await adminFind(query);
    findNoteEl.textContent = found.length === 0 ? 'Никого.' : `Найдено: ${found.length}`;
    showFound(found);
  } catch {
    findNoteEl.textContent = 'Не вышло.';
  }
}

function showFound(found: AdminFound[]): void {
  const body = foundEl.tBodies[0]!;
  body.innerHTML = '';
  for (const player of found) {
    const row = body.insertRow();
    row.className = 'pick';
    // Изъятый прибор виден прямо в списке: иначе служба ищет одного и того
    // же дважды, не помня, наказан он уже или нет.
    cell(row, player.ban ? `${player.name} · изъят` : player.name, player.ban ? 'warn' : '');
    cell(row, player.code ?? '—', 'mono');
    cell(row, String(player.rating), 'mono');
    cell(row, String(player.tokens), 'mono');
    cell(row, player.identities.length === 0 ? 'гость' : player.identities.join(', '), 'dim');
    cell(row, player.seenAt === null ? '—' : moment(player.seenAt), 'dim');
    row.addEventListener('click', () => void showPlayer(player.id));
  }
  foundEl.hidden = found.length === 0;
}

/** Один шильдик в карточке: рисунок своего у каждого свой, он едет отдельно. */
function chip(id: string | null, art: string | null): HTMLElement | null {
  if (id === null) return null;
  const mark: Mark | undefined = markById(id);
  if (!mark) return null;
  return markChip(mark, isOwnMark(id) ? art : null);
}

/**
 * Что сказать над карточкой. После действия карточка перечитывается целиком
 * — иначе на ней остались бы старые числа, — и строка «готово» вместе с ней
 * исчезала бы раньше, чем её успели прочесть. Поэтому она переживает
 * перерисовку.
 */
let done: string | null = null;

async function showPlayer(id: string): Promise<void> {
  playerEl.hidden = false;
  playerEl.textContent = 'Загружаю…';
  let card: AdminCard;
  try {
    card = await adminCard(id);
  } catch {
    playerEl.textContent = 'Карточка не открылась.';
    return;
  }
  playerEl.innerHTML = '';

  if (done !== null) {
    const flash = document.createElement('span');
    flash.className = 'note';
    flash.textContent = done;
    playerEl.appendChild(flash);
    done = null;
  }

  const head = document.createElement('div');
  head.className = 'row';
  head.innerHTML =
    `<b style="font-size:18px">${card.name}</b>` +
    `<span class="note">${card.league} · рейтинг ${card.rating} · жетонов ${card.tokens}</span>`;
  playerEl.appendChild(head);

  const facts = document.createElement('span');
  facts.className = 'note';
  facts.textContent =
    `код ${card.code ?? '—'} · вход: ${card.identities.length === 0 ? 'гость' : card.identities.join(', ')}` +
    ` · дуэлей ${card.duels.played} (побед ${card.duels.won})` +
    ` · цепочки ${card.sprint} · тап ${card.order}` +
    ` · выдано и куплено: ${card.earned.length}` +
    ` · последний раз ${card.seenAt === null ? '—' : moment(card.seenAt)}`;
  playerEl.appendChild(facts);

  // Полоса корпуса — ровно то, что видит соперник.
  const plate = document.createElement('div');
  plate.className = 'plate';
  const chips = card.marks.map((mark) => chip(mark, card.art)).filter((node) => node !== null);
  if (chips.length === 0) {
    const none = document.createElement('span');
    none.className = 'none';
    none.textContent = 'Корпус пуст';
    plate.appendChild(none);
  } else {
    for (const node of chips) plate.appendChild(node!);
  }
  playerEl.appendChild(plate);

  if (card.art !== null) {
    const big = document.createElement('div');
    big.className = 'big-art';
    big.appendChild(artPicture(card.art));
    playerEl.appendChild(big);
  }

  if (card.ban) {
    const ban = document.createElement('span');
    ban.className = 'note warn';
    ban.textContent =
      `Прибор изъят ${card.ban.until === null ? 'навсегда' : `до ${moment(card.ban.until)}`}` +
      ` · ${card.ban.reason}`;
    playerEl.appendChild(ban);
  }

  playerEl.appendChild(
    deed('Жетоны', 'Поставить', card.id, [{ name: 'tokens', value: String(card.tokens), type: 'number' }], async (values, reason) =>
      adminTokens(card.id, Number(values.tokens), reason),
    ),
  );
  playerEl.appendChild(
    deed('Имя', 'Сменить', card.id, [{ name: 'name', value: card.name, type: 'text' }], async (values, reason) =>
      adminName(card.id, String(values.name), reason),
    ),
  );
  playerEl.appendChild(
    deed(
      card.art === null ? 'Рисунок · его нет' : 'Рисунок',
      'Снять',
      card.id,
      [],
      async (_values, reason) => adminClearArt(card.id, reason),
    ),
  );
  // Изъять или вернуть — одно место: наказание и прощение это одно решение,
  // принятое в разные стороны.
  playerEl.appendChild(
    card.ban
      ? deed('Прибор изъят', 'Вернуть', card.id, [], async (_values, reason) =>
          adminUnban(card.id, reason),
        )
      : deed(
          'Изъять прибор',
          'Изъять',
          card.id,
          [{ name: 'days', value: '', type: 'number', hint: 'дней · пусто — навсегда' }],
          async (values, reason) =>
            adminBan(card.id, values.days ? Number(values.days) : null, reason),
        ),
  );
}

/**
 * Действие над игроком. Причина — не украшение формы: через неделю ни один
 * служащий не помнит, за что снял имя, а игрок помнит всегда.
 */
function deed(
  what: string,
  verb: string,
  id: string,
  fields: { name: string; value: string; type: string; hint?: string }[],
  run: (values: Record<string, string>, reason: string) => Promise<unknown>,
): HTMLElement {
  const box = document.createElement('div');
  box.className = 'deed';
  const label = document.createElement('span');
  label.className = 'what';
  label.textContent = what;
  box.appendChild(label);

  const row = document.createElement('div');
  row.className = 'row';
  const inputs: Record<string, HTMLInputElement> = {};
  for (const field of fields) {
    const input = document.createElement('input');
    input.type = field.type;
    input.value = field.value;
    if (field.hint !== undefined) input.placeholder = field.hint;
    input.style.width = field.hint === undefined ? '140px' : '190px';
    inputs[field.name] = input;
    row.appendChild(input);
  }
  const reason = document.createElement('input');
  reason.className = 'grow';
  reason.placeholder = 'Причина — она попадёт в журнал';
  row.appendChild(reason);
  const go = document.createElement('button');
  go.textContent = verb;
  row.appendChild(go);
  box.appendChild(row);

  const note = document.createElement('span');
  note.className = 'note';
  box.appendChild(note);

  go.addEventListener('click', () => {
    void (async () => {
      if (reason.value.trim().length < 3) {
        note.className = 'note warn';
        note.textContent = 'Без причины — нет.';
        return;
      }
      note.className = 'note';
      note.textContent = 'Делаю…';
      const values: Record<string, string> = {};
      for (const [name, input] of Object.entries(inputs)) values[name] = input.value;
      try {
        await run(values, reason.value.trim());
        done = `Готово · ${what.toLowerCase()}: ${reason.value.trim()}`;
        reason.value = '';
        await Promise.all([showPlayer(id), showLog(), showReports()]);
      } catch (error) {
        note.className = 'note warn';
        note.textContent = error instanceof ApiError ? `Отказ: ${error.code}` : 'Не вышло.';
      }
    })();
  });
  return box;
}

async function showLog(): Promise<void> {
  try {
    const { entries } = await adminLog();
    const body = logEl.tBodies[0]!;
    body.innerHTML = '';
    for (const entry of entries) {
      const row = body.insertRow();
      cell(row, moment(entry.at), 'mono dim');
      cell(row, entry.admin);
      cell(row, entry.targetName);
      cell(row, entry.action);
      cell(row, entry.detail, 'dim');
      cell(row, entry.reason);
    }
  } catch {
    // Журнал не открылся — пульт всё равно работает; молчим, а не пугаем.
  }
}

// Проверить заново, не перезагружая страницу: настройку сервера правят в
// соседней вкладке, и возвращаться сюда за F5 — лишнее движение.
el<HTMLButtonElement>('shut-again').addEventListener('click', () => {
  shutNoteEl.textContent = 'Проверяю допуск…';
  void open();
});

el<HTMLButtonElement>('find').addEventListener('click', () => void find());
queryEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void find();
});

void open();
