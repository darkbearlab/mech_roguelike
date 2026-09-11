import { describe, expect, it } from 'vitest';
import { addHeat, checkAp, isHot, passiveCool, payQuota, spendAp } from '../src/core/economy';
import { RULES } from '../src/core/rules';
import type { Unit } from '../src/core/state';
import { game, player } from './helpers';

function unit(patch: Partial<Unit> = {}): Unit {
  return { ...player(game('wk1')), ap: 0, debt: 0, heat: 0, ...patch };
}

describe('§4.1 行動點', () => {
  it('配額先扣抵債務', () => {
    const u = unit({ debt: 2 });
    payQuota(u, 1);
    expect([u.debt, u.ap]).toEqual([1, 0]);
    payQuota(u, 1);
    expect([u.debt, u.ap]).toEqual([0, 0]);
    payQuota(u, 1);
    expect([u.debt, u.ap]).toEqual([0, 1]);
    const big = unit({ debt: 1 });
    payQuota(big, 3);
    expect([big.debt, big.ap]).toEqual([0, 2]);
  });

  it('透支：差額成為債務，上限 apDebtCap', () => {
    expect(checkAp(RULES, unit({ ap: 1 }), 1)).toEqual({ ok: true, overdraft: 0 });
    expect(checkAp(RULES, unit({ ap: 1 }), 3)).toEqual({ ok: true, overdraft: 2 });
    const over = checkAp(RULES, unit({ ap: 0 }), 3);
    expect(over.ok).toBe(false);
    expect(over.overdraft).toBe(3);
    expect(over.reason).toContain('上限 2');
  });

  it('還清前不能做要花 AP 的行動，但免費的事照做', () => {
    expect(checkAp(RULES, unit({ debt: 1, ap: 5 }), 1).ok).toBe(false);
    expect(checkAp(RULES, unit({ debt: 1 }), 0)).toEqual({ ok: true, overdraft: 0 });
  });

  it('付 AP 先用手上的，不夠的記債', () => {
    const u = unit({ ap: 1 });
    spendAp(u, 3);
    expect([u.ap, u.debt]).toEqual([0, 2]);
    const v = unit({ ap: 2 });
    spendAp(v, 1);
    expect([v.ap, v.debt]).toEqual([1, 0]);
  });
});

describe('§4.2 熱量', () => {
  it('夾在 [0, heatCap]', () => {
    const u = unit({ heat: 10 });
    addHeat(RULES, u, -25);
    expect(u.heat).toBe(0);
    addHeat(RULES, u, 250);
    expect(u.heat).toBe(100);
  });

  it('加熱到上限才算過熱；已經停機的不重新觸發；散熱永遠不觸發', () => {
    expect(addHeat(RULES, unit({ heat: 90 }), 5)).toBe(false);
    expect(addHeat(RULES, unit({ heat: 95 }), 5)).toBe(true);
    expect(addHeat(RULES, unit({ heat: 100 }), 1)).toBe(true);
    expect(addHeat(RULES, unit({ heat: 100, shutdown: 1 }), 5)).toBe(false);
    expect(addHeat(RULES, unit({ heat: 100 }), -1)).toBe(false);
    expect(addHeat(RULES, unit({ heat: 100 }), 0)).toBe(false);
  });

  it('被動散熱 heatPassive；債務 > 0 時不散熱', () => {
    const u = unit({ heat: 10 });
    passiveCool(RULES, u);
    expect(u.heat).toBe(7);
    const d = unit({ heat: 10, debt: 1 });
    passiveCool(RULES, d);
    expect(d.heat).toBe(10);
    const low = unit({ heat: 1 });
    passiveCool(RULES, low);
    expect(low.heat).toBe(0);
  });

  it('熱量 > 70% 進入命中懲罰區', () => {
    expect(isHot(RULES, unit({ heat: 70 }))).toBe(false);
    expect(isHot(RULES, unit({ heat: 71 }))).toBe(true);
  });
});
