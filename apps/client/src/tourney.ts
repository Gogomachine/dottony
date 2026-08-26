import { TOURNEY_OPEN_HOUR, tourneyDay } from '@doton/core';
import type { TourneyResponse } from '@doton/protocol';

/**
 * Турнир показывается в двух местах: окном поверх игры и карточкой в
 * кабинете. Слова и правила у них обязаны совпадать — иначе про один и тот
 * же турнир прибор говорит два разных ответа, — поэтому и котёл, и строка
 * под ним, и клавиша живут здесь, а не в каждом из двух мест по разу.
 */

/** Чем турнир занят прямо сейчас — подпись перед «через сколько». */
const PHASE: Record<TourneyResponse['phase'], string> = {
  before: 'Открытие',
  open: 'До закрытия',
  closed: 'Итоги',
  done: 'Следующий',
};

/** «1 234 567» — крупные числа читаются только с разрядами. */
function digits(value: number): string {
  return value.toLocaleString('ru-RU');
}

/** Сколько ждать до ближайшей вехи расписания. */
export function untilWhen(iso: string): string {
  const left = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(left) || left <= 0) return 'вот-вот';
  const hours = Math.floor(left / 3600_000);
  const minutes = Math.round((left % 3600_000) / 60_000);
  if (hours > 0) return `через ${hours} ч ${minutes} мин`;
  return `через ${minutes} мин`;
}

/** «26 августа» — день турнира словами, без года: история короткая. */
export function dayName(day: string): string {
  const parsed = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/**
 * Правая строка шапки: у сегодняшнего турнира — до какой вехи ждать, у
 * прошедшего — его дата. «Следующий через 11 часов» над вчерашней таблицей
 * говорил бы о чужом дне.
 */
export function tourneyWhen(state: TourneyResponse): string {
  if (state.day !== tourneyDay(new Date())) return `Итоги · ${dayName(state.day)}`;
  return `${PHASE[state.phase]} ${untilWhen(state.nextAt)}`;
}

/** Строка под котлом: ровно то, что с турниром происходит и что в нём твоё. */
export function tourneyNote(state: TourneyResponse): string {
  const mine = state.mine;
  const signedNext = state.signup.day !== state.day && state.signup.entered;
  const tomorrow = signedNext ? ' Вы записаны на завтра.' : '';

  if (state.phase === 'before') {
    const start = `${TOURNEY_OPEN_HOUR}:00`;
    return mine
      ? `Вы записаны. Образец выдадут в ${start}, заходов ${state.rounds}.`
      : `Образец выдадут в ${start}. Взнос ${digits(state.entry)} жетонов, ${state.rounds} захода за день.`;
  }
  if (state.phase === 'closed') {
    return `Заходы кончились. Котёл ${digits(state.pool)} разделят в 23:00.${tomorrow}`;
  }
  if (state.phase === 'done') {
    if (mine && mine.place !== null) {
      return mine.prize
        ? `Ваше место ${mine.place} · выигрыш ${digits(mine.prize)} жетонов.${tomorrow}`
        : `Ваше место ${mine.place} · котёл ушёл выше.${tomorrow}`;
    }
    return `Турнир дня посчитан. Следующий — в ${TOURNEY_OPEN_HOUR}:00.${tomorrow}`;
  }
  // Турнир идёт. Первым делом — своё положение в нём: вошёл ли ты и
  // остались ли заходы. Общие числа идут следом: они одинаковы для всех, а
  // «что мне сейчас делать» — нет.
  //
  // Двоеточием, а не «1 играют»: число тут любое, и согласовывать слово с
  // ним пришлось бы правилом про одиннадцать-четырнадцать.
  const split =
    state.scorers === 0
      ? 'котёл делят те, кто сыграет'
      : `играют: ${state.scorers} · мест в котле: ${state.prizes.length}`;
  if (mine === null) return `Взнос ${digits(state.entry)} жетонов · ${split}.`;
  const left = state.rounds - mine.rounds;
  if (left <= 0) return `Заходы кончились · ${split}. Котёл разделят в 23:00.`;
  return `Вы в турнире · осталось ${left} из ${state.rounds} заходов.`;
}

/**
 * Что предлагает клавиша. Действий у турнира всего два — записаться и
 * играть заход, — и какое из них сейчас осмысленно, решает не место на
 * экране, а состояние турнира.
 */
export type TourneyAct = { kind: 'enter' | 'play'; label: string } | null;

export function tourneyAction(state: TourneyResponse): TourneyAct {
  const mine = state.mine;
  const today = state.day === tourneyDay(new Date());
  // Прошедший день — только чтение: ни записаться в него, ни сыграть.
  if (!today) return null;
  if (state.phase === 'open' && mine !== null && mine.rounds < state.rounds) {
    return { kind: 'play', label: `Заход ${mine.rounds + 1} из ${state.rounds}` };
  }
  if (!state.signup.entered) {
    // «Войти» — только когда турнир уже идёт и заход начнётся сразу. До
    // открытия и на завтра — «записаться»: обещание, а не вход.
    const label =
      state.signup.day !== state.day
        ? `Записаться на завтра · ${digits(state.entry)}`
        : state.phase === 'before'
          ? `Записаться · ${digits(state.entry)} жетонов`
          : `Войти · ${digits(state.entry)} жетонов`;
    return { kind: 'enter', label };
  }
  return null;
}

/** Свои заходы коробочками: сыгранный со счётом, ещё не начатый прочерком. */
export function renderRounds(box: HTMLElement, state: TourneyResponse): void {
  const mine = state.mine;
  box.hidden = mine === null;
  box.innerHTML = '';
  if (!mine) return;
  for (let round = 0; round < state.rounds; round++) {
    const cell = document.createElement('i');
    const score = mine.scores[round];
    cell.textContent = score === undefined ? '—' : digits(score);
    cell.className = score === undefined ? (round === mine.rounds ? 'now' : '') : 'done';
    box.appendChild(cell);
  }
}
