import { describe, expect, it } from 'vitest';
import { ACTION_IDS, RAW_RULES, RULES, loadRules, pilotChassis, withPatch } from '../src/core/rules';
import type { RawRules } from '../src/core/rules';

function raw(mut: (r: RawRules) => void): RawRules {
  const r = structuredClone(RAW_RULES);
  mut(r);
  return r;
}

describe('資料檔讀取', () => {
  it('預設資料讀得進來，註解鍵被略過', () => {
    expect(Object.keys(RULES.drives).sort()).toEqual(['drone', 'jet', 'static', 'tracked', 'walker']);
    expect(Object.keys(RULES.chassis).sort()).toEqual(['drone', 'hy1', 'jt1', 'tank', 'target', 'tk1', 'wk1']);
    expect(Object.keys(RULES.weapons)).toEqual(['rifle']);
    expect(Object.keys(RULES.terrain).sort()).toEqual(['debris', 'highland', 'open', 'ridge', 'rubble', 'track', 'wall']);
    expect(Object.keys(RULES.actions).sort()).toEqual([...ACTION_IDS].sort());
    for (const d of Object.values(RULES.drives)) expect(Object.keys(d).some((k) => k.startsWith('_'))).toBe(false);
    expect('id' in RULES.economy).toBe(false);
    expect('id' in RULES.combat).toBe(false);
  });

  it('玩家能開的是四台試驗機；靶不在清單裡', () => {
    expect(pilotChassis(RULES).map((c) => c.id)).toEqual(['tk1', 'wk1', 'jt1', 'hy1']);
    expect(RULES.chassis.target).toMatchObject({ role: 'TARGET', weapon: null, hp: 20 });
    expect(RULES.chassis.jt1).toMatchObject({ role: 'PILOT', weapon: 'rifle' });
  });

  it('基本步槍：射界 180°、射程 6（有利 2–4）、1 AP +6 熱、6 發；武器本身沒有命中值', () => {
    expect(RULES.weapons.rifle).toMatchObject({
      category: 'rifle', range: 6, optimal: { min: 2, max: 4, bonus: 10 },
      arcDegrees: 180, arcPenalty: [0, 0, 0], magazine: 6,
      fire: { ap: 1, heat: 6 }, reload: { ap: 2, heat: 2 },
    });
    expect('accuracy' in RULES.weapons.rifle).toBe(false);
  });

  it('火控：命中率的基礎是火控 × 武器類別的適性；四台試驗機都是標準火控', () => {
    expect(RULES.fireControls.std).toMatchObject({ tracking: 8, aptitude: { rifle: 75 } });
    for (const c of pilotChassis(RULES)) expect(c.fireControl).toBe('std');
    expect(RULES.chassis.target.fireControl).toBeNull();
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

  it('行動成本表（射擊與裝填跟著武器走，不在這裡）', () => {
    const table: Record<string, [number, number]> = {
      wait: [0, 0], lock: [1, 2], swap: [2, 0], cool: [1, -25], switchDrive: [1, 5], turn: [1, 0],
    };
    for (const [id, [ap, heat]] of Object.entries(table)) {
      expect(RULES.actions[id as keyof typeof RULES.actions]).toMatchObject({ ap, heat });
    }
    expect(RULES.economy).toMatchObject({ apDebtCap: 2, heatWarnAbove: 0.7 });
    expect(RULES.actions.wait.requires).toEqual([]);
  });

  it('命中率上下限', () => {
    expect(RULES.combat).toEqual({ minHit: 5, maxHit: 95 });
  });

  it('武器與機體的資料錯誤', () => {
    const bad = raw((r) => {
      const w = r.weapons as Record<string, Record<string, unknown>>;
      w.rifle.range = 0;
      w.rifle.arcDegrees = 400;
      w.rifle.arcPenalty = [];
      w.rifle.magazine = 1.5;
      w.rifle.fire = { ap: -1 };
      const c = r.chassis as Record<string, Record<string, unknown>>;
      c.wk1.weapon = 'laser';
      c.tk1.role = 'BOSS';
    });
    let msg = '';
    try {
      loadRules(bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const needle of [
      'weapons.rifle.range', 'arcDegrees 不能超過 360', 'arcPenalty 至少要有一格', 'weapons.rifle.magazine',
      'weapons.rifle.fire.ap', 'weapons.rifle.fire.heat', '不存在的武器 "laser"', 'chassis.tk1.role',
    ]) {
      expect(msg).toContain(needle);
    }
    // arcPenalty 裡的每一格也要是數字
    expect(() => loadRules(raw((r) => { (r.weapons.rifle as Record<string, unknown>).arcPenalty = ['x']; }))).toThrow('arcPenalty[0]');
  });

  it('火控與有利射程的資料錯誤', () => {
    const msgOf = (mut: (r: RawRules) => void): string => {
      try {
        loadRules(raw(mut));
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };
    const W = (r: RawRules) => r.weapons.rifle as Record<string, unknown>;
    const C = (r: RawRules) => r.chassis as Record<string, Record<string, unknown>>;
    const F = (r: RawRules) => r.fireControls as Record<string, Record<string, unknown>>;
    expect(msgOf((r) => { W(r).optimal = { min: 5, max: 3, bonus: 10 }; })).toContain('min ≤ max ≤ range');
    expect(msgOf((r) => { W(r).optimal = { min: 2, max: 9, bonus: 10 }; })).toContain('min ≤ max ≤ range');
    expect(msgOf((r) => { delete W(r).optimal; })).toContain('weapons.rifle.optimal.min');
    expect(msgOf((r) => { W(r).category = ''; })).toContain('weapons.rifle.category');
    expect(msgOf((r) => { C(r).jt1.fireControl = null; })).toContain('chassis.jt1 有武器就要有火控');
    expect(msgOf((r) => { C(r).jt1.fireControl = 'mk9'; })).toContain('不存在的火控 "mk9"');
    expect(msgOf((r) => { F(r).std.aptitude = { cannon: 50 }; })).toContain('火控 "std" 沒有 步槍（rifle）的適性');
    expect(msgOf((r) => { F(r).std.aptitude = 'high'; })).toContain('fireControls.std.aptitude 必須是');
    expect(msgOf((r) => { F(r).std.aptitude = { rifle: 'x' }; F(r).std.tracking = -1; }))
      .toMatch(/fireControls\.std\.tracking[\s\S]*fireControls\.std\.aptitude\.rifle/);
    // 沒武器的機體可以不寫火控
    expect(msgOf((r) => { delete C(r).target.fireControl; })).toBe('');
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
      fireControls: { std: { aptitude: { rifle: 60 } } },
      weapons: { rifle: { optimal: { bonus: 20 } } },
    });
    expect(next.fireControls.std).toMatchObject({ tracking: 8, aptitude: { rifle: 60 } });
    expect(next.weapons.rifle.optimal).toEqual({ min: 2, max: 4, bonus: 20 });
    expect(RULES.fireControls.std.aptitude.rifle).toBe(75);
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
