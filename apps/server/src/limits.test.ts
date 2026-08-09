import { describe, expect, it } from 'vitest';
import { SignupGuard, SIGNUP_LIMIT, SIGNUP_WINDOW_MS } from './limits.js';

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
