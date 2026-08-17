import { describe, expect, it } from 'vitest';
import { RateGuard, SignupGuard, SIGNUP_LIMIT, SIGNUP_WINDOW_MS } from './limits.js';

describe('RateGuard', () => {
  it('порог и окно задаются каждой двери своими', () => {
    const guard = new RateGuard(2, 1000);
    expect(guard.allow('ключ', 0)).toBe(true);
    expect(guard.allow('ключ', 0)).toBe(true);
    expect(guard.allow('ключ', 0)).toBe(false);
    // Окно у этой двери короткое — через секунду счёт с нуля.
    expect(guard.allow('ключ', 1001)).toBe(true);
  });

  it('ключом может быть не только адрес: у своей двери он свой', () => {
    const guard = new RateGuard(1, 1000);
    expect(guard.allow('игрок-1', 0)).toBe(true);
    expect(guard.allow('игрок-1', 0)).toBe(false);
    expect(guard.allow('игрок-2', 0)).toBe(true);
  });
});

describe('SignupGuard', () => {
  it('пропускает до порога и отсекает дальше', () => {
    const guard = new SignupGuard();
    for (let i = 0; i < SIGNUP_LIMIT; i++) {
      expect(guard.allow('1.2.3.4', 1000)).toBe(true);
    }
    expect(guard.allow('1.2.3.4', 1000)).toBe(false);
  });

  it('считает адреса врозь: сосед по NAT не запирает дверь', () => {
    const guard = new SignupGuard();
    for (let i = 0; i < SIGNUP_LIMIT + 1; i++) guard.allow('1.2.3.4', 1000);
    expect(guard.allow('5.6.7.8', 1000)).toBe(true);
  });

  it('окно кончилось — счёт начинается заново', () => {
    const guard = new SignupGuard();
    for (let i = 0; i < SIGNUP_LIMIT + 1; i++) guard.allow('1.2.3.4', 1000);
    expect(guard.allow('1.2.3.4', 1000)).toBe(false);
    expect(guard.allow('1.2.3.4', 1000 + SIGNUP_WINDOW_MS + 1)).toBe(true);
  });
});
