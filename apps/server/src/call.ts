import { PUZZLE_MOVES, PUZZLE_PLAY, PUZZLE_WIN } from '@doton/core';
import type { BotButton } from './bot.js';

/**
 * Ежедневный зов к доске дня.
 *
 * Раз в сутки бот пишет тем, у кого сегодняшняя попытка ещё не взята.
 * Сыгравшему не пишем вовсе: доска одна и попытка одна, и зов означал бы
 * предложение сделать то, чего сделать уже нельзя.
 *
 * Живёт отдельным модулем, а не строкой в часах сервера: у зова есть и
 * час, и список, и правило «один раз в день», — то есть вся та логика, по
 * которой письмо либо уходит не вовремя, либо уходит дважды.
 */

/**
 * Час рассылки по Гринвичу: десять утра по Москве. Доска меняется в
 * полночь UTC, и к этому времени она уже семь часов как новая. Раньше
 * звать некуда: письмо придёт ночью.
 */
export const CALL_HOUR_UTC = 7;

/** Пауза между письмами: Bot API принимает около тридцати в секунду. */
export const CALL_GAP_MS = 40;

/** Что прибору нужно от базы, чтобы разослать зов. */
export interface CallStore {
  mailingClaim(day: string): Promise<boolean>;
  puzzleIdlers(day: string): Promise<{ id: string; chat: string }[]>;
  mailingDone(day: string, sent: number): Promise<void>;
}

/** И от бота — ровно два метода, а не весь клиент Bot API. */
export interface CallBot {
  miniAppLink(param: string): string | null;
  sendMessage(chatId: string, text: string, button?: BotButton): Promise<boolean>;
}

/**
 * Письмо зова. Коротко и по делу: что ждёт, сколько это стоит ходов и
 * сколько приносит жетонами, — и каким словом всё это выключить. Зов без
 * такого слова был бы не зовом, а навязчивостью.
 */
export function callText(): string {
  return (
    'Доска дня ждёт.\n' +
    `${PUZZLE_MOVES} ходов, одна попытка. За сыгранный заход — ${PUZZLE_PLAY} жетонов, ` +
    `первому к полуночи — ещё ${PUZZLE_WIN}.\n\n` +
    'Не звать больше — напиши «стоп».'
  );
}

/**
 * Рассылает зов, если пришло время и сегодня его ещё не рассылали.
 * Возвращает число ушедших писем; `null` — рассылки не было вовсе.
 *
 * Право рассылать берётся строкой в `mailings` раньше всего остального:
 * часы сервера тикают каждые пять минут, и без ключа один и тот же день
 * ушёл бы игрокам десяток раз — а с двух серверов и вдвое больше.
 */
export async function callToPuzzle(
  store: CallStore,
  bot: CallBot,
  day: string,
  now: Date,
  options: { gapMs?: number } = {},
): Promise<number | null> {
  if (now.getUTCHours() < CALL_HOUR_UTC) return null;
  if (!(await store.mailingClaim(day))) return null;

  const gap = options.gapMs ?? CALL_GAP_MS;
  const open = bot.miniAppLink('puzzle');
  const text = callText();
  const idle = await store.puzzleIdlers(day);
  let sent = 0;
  for (const player of idle) {
    const ok = await bot.sendMessage(
      player.chat,
      text,
      open ? { text: '🔭 Играть', url: open } : undefined,
    );
    if (ok) sent++;
    // Пауза между письмами, а не после последнего: ждать, когда писать уже
    // некому, — значит держать часы сервера ни за чем.
    if (gap > 0 && player !== idle[idle.length - 1]) {
      await new Promise((done) => setTimeout(done, gap));
    }
  }
  await store.mailingDone(day, sent);
  return sent;
}
