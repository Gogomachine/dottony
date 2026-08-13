import type { ClaimWindow, Color, GameConfig, OrderState, PhaseState } from '@doton/core';

/**
 * Что показывает служебный экранчик над окуляром. Вынесено из main, чтобы
 * обучение говорило теми же словами, что и прибор в бою: текст один, а
 * подставить в него можно и настоящие часы партии, и часы сценария.
 */
export interface MiniState {
  /** Строка экранчика; допускает <b> внутри. */
  text: string;
  /** Отсчёт справа: две цифры или прочерк. */
  cd: string;
  /** Цвет светодиода и полоски; null — гасим. */
  color: Color | null;
  /** Длина полоски, 0…1. */
  fill: number;
}

/** Ведущая заявка: цвет, длина и чья она. */
export interface MiniLeader {
  color: Color;
  length: number;
  mine: boolean;
}

export function miniState(
  phase: PhaseState,
  window: ClaimWindow,
  leader: MiniLeader | null,
  cfg: GameConfig,
  started: boolean,
): MiniState {
  if (phase.active !== null) {
    return {
      text: `Резонанс · <b>×${cfg.phaseMultiplier}</b>`,
      cd: pad(phase.remaining),
      color: phase.active,
      fill: phase.remaining / cfg.phaseDuration,
    };
  }

  if (window.open) {
    return {
      text:
        leader === null
          ? 'Заявка · <b>свободна</b>'
          : `Заявка · <b>${leader.length}</b> · ${leader.mine ? 'твоя' : 'его'}`,
      cd: pad(window.remaining),
      color: leader === null ? null : leader.color,
      fill: window.remaining / cfg.claimWindow,
    };
  }

  return {
    text: started ? 'Резонанс · сигнал ровный' : 'Резонанс · ожидание',
    cd: '--',
    color: null,
    fill: 0,
  };
}

/**
 * Экранчик в режиме заказов. Место то же, но показывает он не заявку, а
 * окно резонанса: каким цветом прибор сейчас звенит и сколько окну
 * осталось.
 */
export function orderMini(order: OrderState, cfg: GameConfig): MiniState {
  return {
    text: `Резонанс · <b>${cfg.orderTarget}+</b> за раз`,
    cd: pad(order.remaining),
    color: order.color,
    fill: order.remaining / cfg.orderWindow,
  };
}

function pad(seconds: number): string {
  return String(Math.ceil(seconds)).padStart(2, '0');
}
