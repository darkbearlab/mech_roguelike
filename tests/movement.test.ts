import { describe, expect, it } from 'vitest';
import { DIR_VEC, add, hexDist, scale } from '../src/core/hex';
import type { Dir } from '../src/core/hex';
import { hexToOffset } from '../src/core/map';
import {
  accelHeat, accelLegality, allOrders, driveProfile, maxTaps, orderKey, resolveMotion, resolveSpeed,
  sectorOf, worldOf,
} from '../src/core/movement';
import { RULES, withPatch } from '../src/core/rules';
import type { Unit } from '../src/core/state';
import { flatMap, game, player } from './helpers';

const JET = RULES.drives.jet;
const ms = (heading: Dir, speed: number, facing: Dir) => ({ heading, speed, facing });

describe('設計者的高速機範例（2026-09-11）', () => {
  // 極速 5；前 3、左右前 2、左右後 0、後 3；偏 60° 折損 1、偏 120° 暫定 2；衰減 1；轉向扣速 1
  it('靜止、面向北，往前點 3 下 → 往北 3 速', () => {
    expect(resolveSpeed(JET, ms(0, 0, 0), { rel: 0, taps: 3 })).toEqual({ kind: 'START', heading: 0, speed: 3, loss: 0 });
  });

  it('3 速往北，往左前點 2 下 → 3 − 1 + 2 = 4 速，速度方向變西北，面向不變', () => {
    expect(resolveSpeed(JET, ms(0, 3, 0), { rel: 5, taps: 2 })).toEqual({ kind: 'VEER60', heading: 5, speed: 4, loss: 1 });
  });

  it('右盤把機首轉到西北（扣 1 速 → 3），再往後點 3 下 → 靜止', () => {
    expect(resolveSpeed(JET, ms(5, 3, 5), { rel: 3, taps: 3 })).toEqual({ kind: 'BRAKE', heading: 5, speed: 0, loss: 0 });
  });

  it('沒先轉機首就煞不了車：速度的正後方在機首的右後，推不動', () => {
    // 面向北、往西北 4 速。速度的正後方是東南 = 相對機首右後（rel 2），左右後的點數是 0
    const u = { ...player(game('jt1')), heading: 5 as Dir, speed: 4 };
    expect(maxTaps(JET, 2)).toBe(0);
    expect(accelLegality(RULES, u, { rel: 2, taps: 1 }).ok).toBe(false);
    // 改點正後（南）：相對速度方向偏 120° —— 那是把速度扭向南，不是煞車
    expect(resolveSpeed(JET, ms(5, 4, 0), { rel: 3, taps: 3 })).toEqual({ kind: 'VEER120', heading: 3, speed: 5, loss: 2 });
  });
});

describe('左盤：能點幾下看機首', () => {
  it('相對機首的六個方向落在四個扇區', () => {
    expect([0, 1, 2, 3, 4, 5].map((r) => sectorOf(r as Dir))).toEqual([
      'front', 'frontSide', 'rearSide', 'rear', 'rearSide', 'frontSide',
    ]);
    expect([0, 1, 2, 3, 4, 5].map((r) => maxTaps(JET, r as Dir))).toEqual([3, 2, 0, 3, 0, 2]);
  });

  it('超過上限、推不動的方向、非整數與 0 下都不合法；不點永遠合法', () => {
    const u = player(game('jt1'));
    expect(accelLegality(RULES, u, { rel: 0, taps: 3 }).ok).toBe(true);
    expect(accelLegality(RULES, u, { rel: 0, taps: 4 }).reason).toContain('最多點 3 下');
    expect(accelLegality(RULES, u, { rel: 4, taps: 1 }).reason).toContain('推不動');
    expect(accelLegality(RULES, u, { rel: 0, taps: 0 }).ok).toBe(false);
    expect(accelLegality(RULES, u, { rel: 0, taps: 1.5 }).ok).toBe(false);
    expect(accelLegality(RULES, u, null).ok).toBe(true);
  });

  it('停機中只能不點', () => {
    const u = { ...player(game('jt1')), shutdown: 1 };
    expect(accelLegality(RULES, u, { rel: 0, taps: 1 }).reason).toContain('停機');
    expect(accelLegality(RULES, u, null).ok).toBe(true);
  });

  it('機首決定「前」是哪邊，與速度方向無關', () => {
    expect(resolveSpeed(JET, ms(2, 0, 2), { rel: 0, taps: 2 })).toMatchObject({ heading: 2, speed: 2 });
  });
});

describe('速度結算：效果看速度方向', () => {
  it('同向加速，最多到極速', () => {
    expect(resolveSpeed(JET, ms(0, 4, 0), { rel: 0, taps: 3 })).toMatchObject({ kind: 'PUSH', speed: 5 });
  });

  it('偏 60° / 120° 先扣折損（不會扣到負）再加點數', () => {
    expect(resolveSpeed(JET, ms(0, 1, 0), { rel: 1, taps: 1 })).toMatchObject({ kind: 'VEER60', heading: 1, speed: 1 });
    expect(resolveSpeed(JET, ms(0, 1, 1), { rel: 1, taps: 2 })).toMatchObject({ kind: 'VEER120', heading: 2, speed: 2 });
  });

  it('反向煞車扣到 0 就靜止，不會倒退；速度方向不變', () => {
    expect(resolveSpeed(JET, ms(0, 2, 3), { rel: 0, taps: 3 })).toEqual({ kind: 'BRAKE', heading: 0, speed: 0, loss: 0 });
  });

  it('不點：減衰減，扣到 0 為止', () => {
    expect(resolveSpeed(JET, ms(0, 3, 0), null)).toMatchObject({ kind: 'COAST', speed: 2 });
    expect(resolveSpeed(RULES.drives.walker, ms(0, 1, 0), null)).toMatchObject({ speed: 0 });
  });

  it('產熱 = 點數 × heatPerTap；不點不產熱', () => {
    expect(accelHeat(JET, { rel: 0, taps: 3 })).toBe(6);
    expect(accelHeat(JET, null)).toBe(0);
  });
});

describe('位移：永遠停在格子中心、沿速度方向筆直走', () => {
  it('走「速率」格，每一步都是速度方向的相鄰格', () => {
    const s = game('jt1');
    const u = { ...player(s), heading: 1 as Dir, speed: 4 };
    const r = resolveMotion(worldOf(s, u.id), u, null);
    expect(r.speed).toBe(3);
    expect(r.path).toHaveLength(4);
    for (let i = 1; i < r.path.length; i++) expect(r.path[i]).toEqual(add(r.path[i - 1], DIR_VEC[1]));
    expect(r.pos).toEqual(add(u.pos, scale(DIR_VEC[1], 3)));
    expect(r.collision).toBeNull();
  });

  it('地形目前不影響移動：稜線、碎石都照樣開過去（先無視地形限制）', () => {
    // 出生點 (col 10,row 10)；正北一格稜線、再一格碎石
    const s = game('jt1', { map: flatMap(21, 21, [[10, 9, '#'], [10, 8, ',']]) });
    const r = resolveMotion(worldOf(s, 'player'), player(s), { rel: 0, taps: 3 });
    expect(r.collision).toBeNull();
    expect(r.speed).toBe(3);
    expect(hexDist(r.pos, player(s).pos)).toBe(3);
  });

  it('撞上地圖邊緣：停在前一格、速度歸零，回報撞擊前的速度', () => {
    const s = game('jt1', { map: flatMap(5, 5) });
    const e = resolveMotion(worldOf(s, 'player'), { ...player(s), heading: 0, speed: 5 }, null);
    expect(e.collision).toMatchObject({ blocker: 'EDGE', speed: 4 });
    expect(e.speed).toBe(0);
    expect(hexToOffset(e.pos).row).toBe(0);
  });

  it('撞上其他機體', () => {
    const s = game('jt1', { enemies: [{ chassis: 'tk1', hex: { q: 10, r: 2 }, facing: 3 }] });
    const r = resolveMotion(worldOf(s, 'player'), { ...player(s), heading: 0, speed: 5 }, null);
    expect(r.collision).toMatchObject({ blocker: 'UNIT', unitId: 'enemy1' });
    expect(r.pos).toEqual({ q: 10, r: 3 });
    expect(r.path).toHaveLength(3);
  });

  it('解算不改動傳入的單位', () => {
    const s = game('jt1');
    const u: Unit = player(s);
    const before = structuredClone(u);
    resolveMotion(worldOf(s, u.id), u, { rel: 0, taps: 2 });
    expect(u).toEqual(before);
  });
});

describe('合法宣告清單與驅動輪廓', () => {
  it('所有合法宣告 = 不點 + 每個方向 1..上限', () => {
    expect(allOrders(RULES, player(game('jt1')))).toHaveLength(1 + 3 + 2 + 2 + 3);
    expect(allOrders(RULES, player(game('wk1')))).toHaveLength(1 + 6);
    expect(allOrders(RULES, { ...player(game('jt1')), shutdown: 1 })).toEqual([null]);
    expect(orderKey(null)).toBe('COAST');
    expect(orderKey({ rel: 5, taps: 2 })).toBe('5x2');
  });

  it('預設數值的手感：到極速、滑行停、煞車停、極速轉 60° 剩多少、推滿產熱', () => {
    const row = (id: string) => {
      const p = driveProfile(RULES, id);
      return [p.maxSpeed, p.turnsToMax, p.coastTurns, p.brakeTurns, p.veer60AtMax, p.heatFullPush];
    };
    expect(row('tracked')).toEqual([3, 3, 3, 2, 3, 1]);
    expect(row('walker')).toEqual([2, 2, 1, 2, 2, 2]);
    expect(row('jet')).toEqual([5, 2, 5, 2, 5, 6]);
  });

  it('推不動、停不下來、煞不了車、不能側推、極速 0 都有明確的回報', () => {
    const r = withPatch(RULES, {
      drives: {
        jet: { taps: { front: 0, frontSide: 0, rear: 0 }, decay: 0 },
        tracked: { maxSpeed: 0 },
      },
    });
    expect(driveProfile(r, 'jet')).toMatchObject({ turnsToMax: null, coastTurns: null, brakeTurns: null, veer60AtMax: null });
    expect(driveProfile(r, 'tracked')).toMatchObject({ turnsToMax: null, coastTurns: 0, brakeTurns: 0 });
  });
});
