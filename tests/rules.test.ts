import { describe, expect, it } from 'vitest';
import { ACTION_IDS, RAW_RULES, RULES, loadRules, withPatch } from '../src/core/rules';
import type { RawRules } from '../src/core/rules';

function raw(mut: (r: RawRules) => void): RawRules {
  const r = structuredClone(RAW_RULES);
  mut(r);
  return r;
}

describe('資料檔讀取', () => {
  it('預設資料讀得進來，註解鍵被略過', () => {
    expect(Object.keys(RULES.drives).sort()).toEqual(['jet', 'tracked', 'walker']);
    expect(Object.keys(RULES.chassis).sort()).toEqual(['hy1', 'jt1', 'tk1', 'wk1']);
    expect(Object.keys(RULES.terrain).sort()).toEqual(['highland', 'open', 'ridge', 'rubble']);
    expect(Object.keys(RULES.actions).sort()).toEqual([...ACTION_IDS].sort());
    for (const d of Object.values(RULES.drives)) expect(Object.keys(d).some((k) => k.startsWith('_'))).toBe(false);
    expect('id' in RULES.economy).toBe(false);
    expect('id' in RULES.combat).toBe(false);
  });

  it('噴射 = 設計者給的高速機範例', () => {
    expect(RULES.drives.jet).toMatchObject({
      maxSpeed: 5,
      taps: { front: 3, frontSide: 2, rearSide: 0, rear: 3 },
      turnLoss: { d60: 1, d120: 2 },
      decay: 1,
      facingTurnSpeedLoss: 1,
    });
  });

  it('成本表逐項與規格相同', () => {
    const table: Record<string, [number, number]> = {
      wait: [0, 0], lock: [1, 2], fireLight: [1, 6], fireHeavy: [3, 20], reload: [2, 2],
      swap: [2, 0], cool: [1, -25], switchDrive: [1, 5], turn: [1, 0],
    };
    for (const [id, [ap, heat]] of Object.entries(table)) {
      expect(RULES.actions[id as keyof typeof RULES.actions]).toMatchObject({ ap, heat });
    }
    expect(RULES.economy.apDebtCap).toBe(2);
    expect(RULES.actions.wait.requires).toEqual([]);
  });

  it('規格給過的戰鬥常數都在 combat.json', () => {
    expect(RULES.combat).toMatchObject({ baseHit: 75, k1: 4, k2: 3, stableBonus: 10, heatPenalty: 15, debtPenalty: 10 });
  });

  it('資料有錯時一次列出全部問題', () => {
    const bad = raw((r) => {
      const d = r.drives as Record<string, Record<string, unknown>>;
      d.walker.maxSpeed = 2.5;
      d.walker.taps = { front: 1, frontSide: 1, rearSide: -1 };
      d.jet.turnLoss = { d60: 1 };
      d.jet.decay = 'x';
      d.tracked.turnRule = {};
      d.tracked.heatPerTap = -1;
      const c = r.chassis as Record<string, Record<string, unknown>>;
      c.wk1.drives = ['legs'];
      c.tk1.drives = [];
      c.jt1.heatCap = 0;
      delete r.actions.actions.cool;
      (r.actions.economy as Record<string, unknown>).overheatShutdownPhases = 0;
      const t = r.terrain as Record<string, Record<string, unknown>>;
      t.rubble.glyph = '.';
      t.ridge.glyph = '##';
      t.highland.blocksLos = 'yes';
    });
    let msg = '';
    try {
      loadRules(bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const needle of [
      'drives.walker.maxSpeed', 'drives.walker.taps.rearSide', 'drives.walker.taps.rear',
      'drives.jet.turnLoss.d120', 'drives.jet.decay', 'drives.tracked.turnRule.freeFacesPerTurn',
      'drives.tracked.heatPerTap', '不存在的驅動 "legs"', 'chassis.tk1.drives 至少要有一種驅動',
      'chassis.jt1.heatCap', 'actions.cool 缺少定義', 'economy.overheatShutdownPhases',
      'terrain.rubble.glyph "." 與其他地形重複', 'terrain.ridge.glyph 必須是單一字元', 'terrain.highland.blocksLos',
    ]) {
      expect(msg).toContain(needle);
    }
  });
});

describe('覆寫（調參面板與 bot 的 A/B）', () => {
  it('逐層合併、回傳新物件，不改動原本的 Rules', () => {
    const next = withPatch(RULES, {
      drives: { jet: { taps: { frontSide: 1 }, decay: 2 } },
      chassis: { wk1: { apQuota: 3 } },
      terrain: { rubble: { elevation: 1 } },
      economy: { apDebtCap: 4 },
    });
    // 只改了 frontSide，其他扇區保留
    expect(next.drives.jet.taps).toEqual({ front: 3, frontSide: 1, rearSide: 0, rear: 3 });
    expect(next.drives.jet.decay).toBe(2);
    expect(next.chassis.wk1.apQuota).toBe(3);
    expect(next.terrain.rubble.elevation).toBe(1);
    expect(next.economy.apDebtCap).toBe(4);
    expect(RULES.drives.jet.taps.frontSide).toBe(2);
    expect(RULES.chassis.wk1.apQuota).toBe(1);
    expect(RULES.economy.apDebtCap).toBe(2);
  });

  it('陣列整個取代；指向不存在的 id 的覆寫會被忽略', () => {
    expect(withPatch(RULES, { chassis: { hy1: { drives: ['jet'] } } }).chassis.hy1.drives).toEqual(['jet']);
    expect(withPatch(RULES, { drives: { hover: { decay: 1 } } }).drives.hover).toBeUndefined();
    expect(withPatch(RULES, {})).toEqual(RULES);
  });
});
