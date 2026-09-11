import { describe, expect, it } from 'vitest';
import { driveProfile } from '../src/core/movement';
import { ACTION_IDS, RAW_RULES, RULES, accelOf, loadRules, withPatch } from '../src/core/rules';
import type { RawRules } from '../src/core/rules';

function raw(mut: (r: RawRules) => void): RawRules {
  const r = structuredClone(RAW_RULES);
  mut(r);
  return r;
}

describe('§10 資料檔讀取', () => {
  it('預設資料讀得進來，註解鍵被略過', () => {
    expect(Object.keys(RULES.drives).sort()).toEqual(['jet', 'tracked', 'walker']);
    expect(Object.keys(RULES.chassis).sort()).toEqual(['hy1', 'jt1', 'tk1', 'wk1']);
    expect(Object.keys(RULES.terrain).sort()).toEqual(['highland', 'open', 'ridge', 'rubble']);
    expect(Object.keys(RULES.actions).sort()).toEqual([...ACTION_IDS].sort());
    for (const d of Object.values(RULES.drives)) expect(Object.keys(d).some((k) => k.startsWith('_'))).toBe(false);
    expect('id' in RULES.economy).toBe(false);
    expect('id' in RULES.combat).toBe(false);
  });

  it('§4.1 成本表逐項與規格相同', () => {
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

  it('§6 規格給過的戰鬥常數都在 combat.json', () => {
    expect(RULES.combat).toMatchObject({ baseHit: 75, k1: 4, k2: 3, stableBonus: 10, heatPenalty: 15, debtPenalty: 10 });
  });

  it('§3.2 accel = round(thrust / mass × SUB)', () => {
    expect(accelOf(RULES, 'tk1', 'tracked')).toBe(14);
    expect(accelOf(RULES, 'wk1', 'walker')).toBe(15);
    expect(accelOf(RULES, 'jt1', 'jet')).toBe(14);
    // 同一具推進器裝在比較重的機體上就比較慢
    expect(accelOf(RULES, 'hy1', 'walker')).toBe(14);
    expect(accelOf(RULES, 'hy1', 'jet')).toBe(13);
  });

  it('預設數值重現規格表格的「淨推進」4 / 6 / 12 與極速 20 / 18 / 40', () => {
    const p = (c: string, d: string) => driveProfile(RULES, c, d);
    expect([p('tk1', 'tracked').netPush, p('wk1', 'walker').netPush, p('jt1', 'jet').netPush]).toEqual([4, 6, 12]);
    expect([p('tk1', 'tracked').maxSpeed, p('wk1', 'walker').maxSpeed, p('jt1', 'jet').maxSpeed]).toEqual([20, 18, 40]);
  });

  it('資料有錯時一次列出全部問題', () => {
    const bad = raw((r) => {
      (r.drives.walker as Record<string, unknown>).drag = 'x';
      (r.drives.walker as Record<string, unknown>).maxSpeed = 18.5;
      (r.drives.jet as Record<string, unknown>).sideAccel = 1;
      (r.drives.tracked as Record<string, unknown>).turnRule = {};
      (r.chassis.wk1 as Record<string, unknown>).drives = ['legs'];
      (r.chassis.tk1 as Record<string, unknown>).drives = [];
      (r.chassis.jt1 as Record<string, unknown>).mass = 0;
      delete r.actions.actions.cool;
      (r.actions.economy as Record<string, unknown>).overheatShutdownPhases = 0;
      (r.terrain.rubble as Record<string, unknown>).glyph = '.';
      (r.terrain.ridge as Record<string, unknown>).glyph = '##';
      (r.terrain.highland as Record<string, unknown>).passable = 'yes';
    });
    let msg = '';
    try {
      loadRules(bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const needle of [
      'drives.walker.drag', 'drives.walker.maxSpeed 必須是整數', 'drives.jet.sideAccel', 'drives.tracked.turnRule.freeFacesPerTurn',
      '不存在的驅動 "legs"', 'chassis.tk1.drives 至少要有一種驅動', 'chassis.jt1.mass',
      'actions.cool 缺少定義', 'economy.overheatShutdownPhases',
      'terrain.rubble.glyph "." 與其他地形重複', 'terrain.ridge.glyph 必須是單一字元',
      'terrain.highland.passable',
    ]) {
      expect(msg).toContain(needle);
    }
  });
});

describe('覆寫（調參面板與 bot 的 A/B）', () => {
  it('回傳新物件，不改動原本的 Rules', () => {
    const next = withPatch(RULES, {
      drives: { walker: { drag: 3 } },
      chassis: { wk1: { mass: 60 } },
      terrain: { rubble: { dragModifier: 5 } },
      economy: { apDebtCap: 4 },
    });
    expect(next.drives.walker.drag).toBe(3);
    expect(next.chassis.wk1.mass).toBe(60);
    expect(next.terrain.rubble.dragModifier).toBe(5);
    expect(next.economy.apDebtCap).toBe(4);
    expect(RULES.drives.walker.drag).toBe(9);
    expect(RULES.chassis.wk1.mass).toBe(50);
    expect(RULES.economy.apDebtCap).toBe(2);
  });

  it('指向不存在的 id 的覆寫會被忽略', () => {
    const next = withPatch(RULES, { drives: { hover: { drag: 1 } } });
    expect(next.drives.hover).toBeUndefined();
    expect(withPatch(RULES, {})).toEqual(RULES);
  });
});
