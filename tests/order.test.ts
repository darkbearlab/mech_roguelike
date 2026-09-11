import { describe, expect, it } from 'vitest';
import { ORDERS, SEQUENTIAL } from '../src/core/order';
import { createRng, nextFloat, nextInt } from '../src/core/rng';
import { game } from './helpers';

describe('解算順序模組', () => {
  it('循序制：每個單位 宣告 → 位移 → 行動，最後是世界階段；陣亡的不排', () => {
    const s = game('wk1', { enemies: [{ chassis: 'tk1', hex: { q: 3, r: 3 }, facing: 3 }] });
    const units = s.units.map((u, i) => (i === 1 ? { ...u, alive: false } : u));
    expect(SEQUENTIAL.schedule(units)).toEqual([
      { kind: 'DECLARE', unitId: 'player' },
      { kind: 'MOVE', unitIds: ['player'] },
      { kind: 'ACT', unitId: 'player' },
      { kind: 'WORLD' },
    ]);
    expect(ORDERS.SEQUENTIAL).toBe(SEQUENTIAL);
  });
});

describe('可播種亂數', () => {
  it('同一個種子 → 同一串；不同種子 → 不同串', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const sa = Array.from({ length: 20 }, () => nextFloat(a));
    const sb = Array.from({ length: 20 }, () => nextFloat(b));
    const sc = Array.from({ length: 20 }, () => nextFloat(c));
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    expect(a.count).toBe(20);
  });

  it('nextFloat 在 [0,1)、nextInt 在 [0,n)', () => {
    const r = createRng(1);
    for (let i = 0; i < 2000; i++) {
      const f = nextFloat(r);
      expect(f >= 0 && f < 1).toBe(true);
      const n = nextInt(r, 6);
      expect(Number.isInteger(n) && n >= 0 && n < 6).toBe(true);
    }
  });

  it('狀態可以 JSON 往返後接著抽', () => {
    const r = createRng(9);
    nextFloat(r);
    const copy = JSON.parse(JSON.stringify(r));
    expect(nextFloat(copy)).toBe(nextFloat(r));
  });
});
