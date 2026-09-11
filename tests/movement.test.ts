import { describe, expect, it } from 'vitest';
import { DIRS, DIR_VEC, SUB, hexDist, hexLen, hexToSub, scale, subToHex, vec } from '../src/core/hex';
import type { Dir, SubVec } from '../src/core/hex';
import {
  ALL_CHOICES, accelHeat, accelLegality, choiceFromKey, choiceKey, driveProfile, integrateVelocity,
  resolveMotion, scaleToLength, shrink, unitAccel, worldOf,
} from '../src/core/movement';
import { RULES, withPatch } from '../src/core/rules';
import type { Unit } from '../src/core/state';
import { DIR_CHOICE, flatMap, game, player } from './helpers';

function at(u: Unit, pos: SubVec, vel: SubVec = vec(0, 0), facing: Dir = u.facing): Unit {
  return { ...u, posSub: pos, velSub: vel, facing };
}

describe('向量長度運算', () => {
  it('scaleToLength 永遠不超過目標長度（對所有 |q|,|r| ≤ 64、len ≤ 64 窮舉）', () => {
    // 速度最大是 maxSpeed + accel，遠小於 64。窮舉而不是抽樣：這是一條「永不」的保證。
    let bad = 0;
    for (let q = -64; q <= 64; q++) for (let r = -64; r <= 64; r++) {
      const cur = hexLen({ q, r });
      for (let len = 0; len <= 64; len++) {
        const out = scaleToLength({ q, r }, len);
        const l = hexLen(out);
        if (l > len || (cur <= len && (out.q !== q || out.r !== r))) bad++;
        // 縮放是縮到剛好 len，不是「不超過就好」
        if (cur > len && l !== len) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it('縮放後的方向與原本相差不到一個 sub', () => {
    const v = { q: 17, r: -29 };
    const out = scaleToLength(v, 12);
    expect(hexLen(out)).toBe(12);
    const ideal = { q: (v.q * 12) / hexLen(v), r: (v.r * 12) / hexLen(v) };
    expect(Math.abs(out.q - ideal.q)).toBeLessThan(1);
    expect(Math.abs(out.r - ideal.r)).toBeLessThan(1);
  });

  it('shrink 減少長度，不越過零', () => {
    expect(hexLen(shrink({ q: 0, r: -18 }, 9))).toBe(9);
    expect(shrink({ q: 0, r: -5 }, 9)).toEqual({ q: 0, r: 0 });
    expect(shrink({ q: 0, r: 0 }, 3)).toEqual({ q: 0, r: 0 });
  });
});

describe('§3.1 第 2～4 步：加速 → 阻力 → 上限', () => {
  it('順序是字面順序：阻力扣在加速之後', () => {
    // 靜止、推 15、阻力 9 → 6
    expect(integrateVelocity(vec(0, 0), DIR_CHOICE(0), 15, 9, 18).velSub).toEqual({ q: 0, r: -6 });
  });

  it('規格表格原本的 accel == drag 會在同一回合完全抵銷（這就是預設數值改過的原因）', () => {
    for (const [accel, drag] of [[4, 4], [6, 6]]) {
      let v = vec(0, 0);
      for (let t = 0; t < 10; t++) v = integrateVelocity(v, DIR_CHOICE(0), accel, drag, 20).velSub;
      expect(v).toEqual({ q: 0, r: 0 });
    }
  });

  it('制動朝反向縮減 accel、不越過零，並回報實際減掉的量', () => {
    const r = integrateVelocity({ q: 0, r: -10 }, { kind: 'BRAKE' }, 14, 0, 40);
    expect(r.velSub).toEqual({ q: 0, r: 0 });
    expect(r.accelApplied).toBe(10);
    const r2 = integrateVelocity({ q: 0, r: -30 }, { kind: 'BRAKE' }, 14, 2, 40);
    expect(hexLen(r2.velSub)).toBe(14);
    expect(r2.accelApplied).toBe(14);
  });

  it('巡航不加速，只吃阻力', () => {
    const r = integrateVelocity({ q: 12, r: -12 }, { kind: 'CRUISE' }, 14, 2, 40);
    expect(hexLen(r.velSub)).toBe(10);
    expect(r.accelApplied).toBe(0);
  });

  it('速度夾在 maxSpeed 以內', () => {
    const r = integrateVelocity({ q: 0, r: -40 }, DIR_CHOICE(0), 14, 2, 40);
    expect(hexLen(r.velSub)).toBe(40);
  });

  it('加速產熱 = 實際加速量 × heatPerAccel / SUB（§4.2：噴射每 10 sub +4）', () => {
    expect(accelHeat(10, 4)).toBe(4);
    expect(accelHeat(14, 4)).toBe(6);
    expect(accelHeat(0, 4)).toBe(0);
  });
});

describe('§3.2 側向加速與合法性', () => {
  it('地面驅動只能往前方三面推，巡航與制動永遠可以', () => {
    const s = game('wk1', { facing: 0 });
    const u = player(s);
    const ok = DIRS.filter((d) => accelLegality(RULES, u, DIR_CHOICE(d)).ok);
    expect(ok).toEqual([0, 1, 5]);
    expect(accelLegality(RULES, u, DIR_CHOICE(3)).reason).toContain('側向加速');
    expect(accelLegality(RULES, u, { kind: 'CRUISE' }).ok).toBe(true);
    expect(accelLegality(RULES, u, { kind: 'BRAKE' }).ok).toBe(true);
  });

  it('噴射可以往任何方向推 —— 側滑射擊的來源', () => {
    const u = player(game('jt1', { facing: 0 }));
    expect(DIRS.every((d) => accelLegality(RULES, u, DIR_CHOICE(d)).ok)).toBe(true);
  });

  it('停機中只能巡航', () => {
    const u = { ...player(game('jt1')), shutdown: 1 };
    expect(accelLegality(RULES, u, DIR_CHOICE(0)).ok).toBe(false);
    expect(accelLegality(RULES, u, { kind: 'BRAKE' }).reason).toContain('停機');
    expect(accelLegality(RULES, u, { kind: 'CRUISE' }).ok).toBe(true);
  });
});

describe('§3.1 完整解算', () => {
  it('位移 = 解算後的速度，佔格用取整', () => {
    const s = game('jt1');
    const u = player(s);
    const r = resolveMotion(worldOf(s, u.id), u, DIR_CHOICE(2));
    expect(r.velSub).toEqual({ q: 12, r: 0 });
    expect(r.posSub).toEqual({ q: u.posSub.q + 12, r: u.posSub.r });
    expect(r.path[0]).toEqual(subToHex(u.posSub));
    expect(r.path[r.path.length - 1]).toEqual(subToHex(r.posSub));
    expect(r.collision).toBeNull();
    expect(r.heat).toBe(6);
    expect(unitAccel(RULES, u)).toBe(14);
  });

  it('次格位置會累積：兩個 0.6 格的位移 = 1.2 格', () => {
    const s = game('jt1');
    const u = at(player(s), hexToSub({ q: 10, r: 0 }), { q: 6, r: 0 });
    const r = resolveMotion(worldOf(s, u.id), u, { kind: 'CRUISE' });
    expect(r.posSub).toEqual({ q: 104, r: 0 });   // 6 − 阻力 2 = 4
  });

  it('地形阻力取出發那一格', () => {
    // 碎石 drag +2：步行在碎石上推一次只剩 15 − 9 − 2 = 4
    const map = flatMap(21, 21, [[10, 10, ',']]);
    const s = game('wk1', { map });
    const u = player(s);
    expect(map.cells[10 * 21 + 10].terrain).toBe('rubble');
    expect(hexLen(resolveMotion(worldOf(s, u.id), u, DIR_CHOICE(0)).velSub)).toBe(4);
    // 從碎石外出發、衝進碎石：這一回合不受影響
    const outside = at(u, hexToSub({ q: 10, r: 6 }));
    expect(hexLen(resolveMotion(worldOf(s, u.id), outside, DIR_CHOICE(3)).velSub)).toBe(6);
  });

  it('撞上稜線：停在前一格中心、速度歸零，回報撞擊前的速度', () => {
    // 出生點 (10,10)；正北兩格 (10,8) 是稜線
    const s = game('jt1', { map: flatMap(21, 21, [[10, 8, '#']]) });
    const u = at(player(s), player(s).posSub, { q: 0, r: -30 });
    const r = resolveMotion(worldOf(s, u.id), u, { kind: 'CRUISE' });
    expect(r.collision).toMatchObject({ blocker: 'TERRAIN', at: { q: 10, r: 3 }, speed: 28 });
    expect(r.posSub).toEqual(hexToSub({ q: 10, r: 4 }));
    expect(r.velSub).toEqual({ q: 0, r: 0 });
    expect(r.path).toEqual([{ q: 10, r: 5 }, { q: 10, r: 4 }]);
  });

  it('撞上地圖邊緣', () => {
    const s = game('jt1', { map: flatMap(5, 5) });
    const u = at(player(s), player(s).posSub, { q: 0, r: -40 });
    const r = resolveMotion(worldOf(s, u.id), u, { kind: 'CRUISE' });
    expect(r.collision?.blocker).toBe('EDGE');
    expect(subToHex(r.posSub)).toEqual({ q: 2, r: -1 });   // (col 2, row 0) 的 axial
  });

  it('撞上其他單位', () => {
    const s = game('jt1', { enemies: [{ chassis: 'tk1', hex: { q: 10, r: 2 }, facing: 3 }] });
    const u = at(player(s), player(s).posSub, { q: 0, r: -40 });
    const r = resolveMotion(worldOf(s, u.id), u, { kind: 'CRUISE' });
    expect(r.collision).toMatchObject({ blocker: 'UNIT', unitId: 'enemy1' });
    expect(subToHex(r.posSub)).toEqual({ q: 10, r: 3 });
  });

  it('路徑逐格相鄰；動畫與逐格判定走同一條線', () => {
    const s = game('jt1');
    const u = at(player(s), player(s).posSub, { q: 25, r: -35 });
    const r = resolveMotion(worldOf(s, u.id), u, { kind: 'CRUISE' });
    for (let i = 1; i < r.path.length; i++) expect(hexDist(r.path[i - 1], r.path[i])).toBe(1);
  });

  it('解算不改動傳入的單位', () => {
    const s = game('jt1');
    const u = player(s);
    const before = structuredClone(u);
    resolveMotion(worldOf(s, u.id), u, DIR_CHOICE(1));
    expect(u).toEqual(before);
  });
});

describe('驅動輪廓（手感的四個數字）', () => {
  it('預設數值：地面驅動兩回合內滑停、制動一回合停；噴射要滑很久', () => {
    const tk = driveProfile(RULES, 'tk1', 'tracked');
    const wk = driveProfile(RULES, 'wk1', 'walker');
    const jt = driveProfile(RULES, 'jt1', 'jet');
    expect([tk.turnsToMax, tk.coastTurns, tk.brakeTurns]).toEqual([5, 2, 1]);
    expect([wk.turnsToMax, wk.coastTurns, wk.brakeTurns]).toEqual([3, 2, 1]);
    expect([jt.turnsToMax, jt.coastTurns, jt.brakeTurns]).toEqual([4, 20, 3]);
    expect([tk.heatPerPush, wk.heatPerPush, jt.heatPerPush]).toEqual([1, 3, 6]);
  });

  it('推不動、停不下來、極速為 0 都有明確的回報', () => {
    const stuck = withPatch(RULES, { drives: { walker: { drag: 20 } } });
    expect(driveProfile(stuck, 'wk1', 'walker')).toMatchObject({ netPush: 0, turnsToMax: null });
    const slick = withPatch(RULES, { drives: { jet: { drag: 0 } } });
    expect(driveProfile(slick, 'jt1', 'jet').coastTurns).toBeNull();
    const parked = withPatch(RULES, { drives: { tracked: { maxSpeed: 0 } } });
    expect(driveProfile(parked, 'tk1', 'tracked')).toMatchObject({ turnsToMax: null, coastTurns: 0, brakeTurns: 0 });
    const noBrake = withPatch(RULES, { drives: { jet: { drag: 0, thrust: 0 } } });
    expect(driveProfile(noBrake, 'jt1', 'jet').brakeTurns).toBeNull();
  });
});

describe('宣告選項', () => {
  it('八個選項、key 往返不變', () => {
    expect(ALL_CHOICES).toHaveLength(8);
    for (const c of ALL_CHOICES) expect(choiceFromKey(choiceKey(c))).toEqual(c);
    expect(choiceKey({ kind: 'DIR', dir: 4 })).toBe('4');
  });

  it('方向向量 × accel 就是那一個選項的速度增量', () => {
    expect(scale(DIR_VEC[1], SUB)).toEqual({ q: 10, r: -10 });
  });
});
