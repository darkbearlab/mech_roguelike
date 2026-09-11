import { describe, expect, it } from 'vitest';
import {
  aptitude, arcBand, arcHexes, fireControlOf, hitChance, inOptimal, relativeSpeed, shotCheck, targetsFor, velocity, weaponOf,
} from '../src/core/combat';
import { applyCommand, checkLegal, judge, newGame } from '../src/core/engine';
import { offAxisDegrees } from '../src/core/hex';
import type { Dir, Hex } from '../src/core/hex';
import { loadMap } from '../src/core/map';
import type { RawMap } from '../src/core/map';
import { RULES } from '../src/core/rules';
import type { Rules } from '../src/core/rules';
import type { GameEvent, GameState, Unit } from '../src/core/state';
import { COAST, WAIT, customRules, flatMap, flatRaw, patch, player, run } from './helpers';

const RIFLE = RULES.weapons.rifle;
const STD = RULES.fireControls.std;

/** 玩家 (10,5) 朝北；在指定位置放一個固定靶。 */
function range(target: Hex, o: { rules?: Rules; facing?: Dir } = {}): GameState {
  const rules = o.rules ?? RULES;
  const raw = flatRaw(21, 21);
  const map = loadMap(rules, raw);
  map.units.push({ id: 't', chassis: 'target', hex: target, facing: 3, script: { kind: 'IDLE' } });
  return newGame(rules, map, { seed: 1, player: { chassis: 'jt1', facing: o.facing } });
}

const unit = (s: GameState, id: string): Unit => s.units.find((u) => u.id === id)!;
const moving = (u: Unit, heading: Dir, speed: number): Unit => ({ ...u, heading, speed });

describe('相對位移差', () => {
  it('同向同速 = 0、迎面 = 兩者相加、自己停著 = 目標的速度', () => {
    const s = range({ q: 10, r: 2 });
    const me = player(s);
    const t = unit(s, 't');
    expect(velocity(moving(me, 1, 3))).toEqual({ q: 3, r: -3 });
    expect(relativeSpeed(moving(me, 0, 3), moving(t, 0, 3))).toBe(0);
    expect(relativeSpeed(moving(me, 0, 3), moving(t, 3, 2))).toBe(5);
    expect(relativeSpeed(me, moving(t, 2, 2))).toBe(2);
    // 相鄰方向（夾 60°）同速：差一格方向 → 相對速度 = 速度
    expect(relativeSpeed(moving(me, 0, 2), moving(t, 1, 2))).toBe(2);
  });
});

describe('射界（看武器，步槍 180°）', () => {
  it('偏離機首的角度：正前 0、正後 180、正側面 90', () => {
    const o = { q: 0, r: 0 };
    expect(offAxisDegrees(o, 0, { q: 0, r: -3 })).toBeCloseTo(0);
    expect(offAxisDegrees(o, 0, { q: 0, r: 3 })).toBeCloseTo(180);
    expect(offAxisDegrees(o, 0, { q: 2, r: -1 })).toBeCloseTo(90);
    expect(offAxisDegrees(o, 1, { q: 1, r: -1 })).toBeCloseTo(0);
    expect(offAxisDegrees(o, 0, o)).toBe(0);
  });

  it('每 30° 一格的角度懲罰；超出表格用最後一格', () => {
    expect([0, 29, 30, 75, 90, 150].map((a) => arcBand(a, [0, 5, 10]))).toEqual([0, 0, 5, 10, 10, 10]);
  });

  it('介面畫的扇形與 shotCheck 同一條規則：亮的格子就是打得到的格子', () => {
    const s = range({ q: 10, r: 2 });
    const me = player(s);
    const t = unit(s, 't');
    const key = (h: Hex) => `${h.q},${h.r}`;
    const lit = new Set(arcHexes(RIFLE, me.pos, me.facing).map(key));
    // 射程 6 內 126 格：正前方半邊 60 格 + 正側面那一排 6 格（邊界算在內）
    expect(lit.size).toBe(66);
    for (let dq = -7; dq <= 7; dq++) {
      for (let dr = -7; dr <= 7; dr++) {
        const h = { q: me.pos.q + dq, r: me.pos.r + dr };
        if (dq === 0 && dr === 0) continue;
        expect(shotCheck(s, me, { ...t, pos: h }).ok, key(h)).toBe(lit.has(key(h)));
      }
    }
    // 360° 的武器：射程內每一格都算
    expect(arcHexes({ ...RIFLE, arcDegrees: 360 }, me.pos, 2)).toHaveLength(126);
  });
});

describe('命中率（設計者的模型）', () => {
  it('火控適性 + 有利射程 − 追蹤 × 相對速度 − 重量 × 自己的速度；掩體、電戰、角度先 0', () => {
    const s = range({ q: 10, r: 2 });   // 距離 3：在有利射程 2–4 內
    const me = moving(player(s), 0, 3);
    const t = unit(s, 't');
    const r = hitChance(RULES, STD, RIFLE, me, t);
    expect(r.terms.map((x) => [x.key, x.value])).toEqual([
      ['APTITUDE', 75], ['OPTIMAL', 10], ['RELATIVE', -24], ['WEIGHT', -6], ['ARC', -0], ['COVER', 0], ['EW', 0],
    ]);
    expect(r.chance).toBe(55);
    // 停下來打有利射程內的固定靶：適性 + 加成
    expect(hitChance(RULES, STD, RIFLE, player(s), t).chance).toBe(85);
  });

  it('基礎是火控 × 武器類別的適性，不是武器本身：換火控就換命中；表裡沒有的類別 = 0', () => {
    const s = range({ q: 10, r: 2 });
    const poor = { ...STD, aptitude: { rifle: 50 } };
    expect(hitChance(RULES, poor, RIFLE, player(s), unit(s, 't')).chance).toBe(60);
    expect(aptitude(STD, RIFLE)).toBe(75);
    expect(aptitude({ ...STD, aptitude: {} }, RIFLE)).toBe(0);
    expect(fireControlOf(RULES, player(s))).toBe(STD);
    expect(fireControlOf(RULES, unit(s, 't'))).toBeNull();
  });

  it('有利射程內命中提高（含兩端）；太近、太遠都沒有加成', () => {
    const at = (r: number) => {
      const s = range({ q: 10, r });
      return hitChance(RULES, STD, RIFLE, player(s), unit(s, 't')).chance;
    };
    // 玩家在 (10,5)：距離 1..5
    expect([4, 3, 2, 1, 0].map(at)).toEqual([75, 85, 85, 85, 75]);
    expect([0, 1, 2, 4, 5, 6].map((d) => inOptimal(RIFLE, d))).toEqual([false, false, true, true, false, false]);
  });

  it('越重的武器高速時越不準：同樣的相對速度，重量越大掉越多', () => {
    const s = range({ q: 10, r: 2 });
    const me = moving(player(s), 0, 5);
    const t = moving(unit(s, 't'), 0, 5);   // 同向同速：相對速度 0
    const light = hitChance(RULES, STD, { ...RIFLE, weight: 1 }, me, t).chance;
    const heavy = hitChance(RULES, STD, { ...RIFLE, weight: 6 }, me, t).chance;
    expect(light).toBe(80);
    expect(heavy).toBe(55);
  });

  it('角度懲罰照表；結果夾在上下限', () => {
    const s = range({ q: 13, r: 3 });   // 偏右前，距離 3
    const w = { ...RIFLE, arcPenalty: [0, 10, 20] };
    const off = offAxisDegrees(player(s).pos, 0, { q: 13, r: 3 });
    expect(hitChance(RULES, STD, w, player(s), unit(s, 't')).chance).toBe(85 - arcBand(off, w.arcPenalty));
    const fast = moving(player(s), 3, 5);
    expect(hitChance(RULES, { ...STD, tracking: 50 }, RIFLE, fast, unit(s, 't')).chance).toBe(RULES.combat.minHit);
    expect(hitChance(RULES, { ...STD, aptitude: { rifle: 200 } }, RIFLE, player(s), unit(s, 't')).chance).toBe(RULES.combat.maxHit);
  });
});

describe('能不能打', () => {
  it('射程、射界、子彈、目標狀態都會擋；可以打時帶著明細', () => {
    const s = range({ q: 10, r: 2 });
    const me = player(s);
    const t = unit(s, 't');
    expect(shotCheck(s, me, t)).toMatchObject({ ok: true, distance: 3, chance: 85 });
    expect(shotCheck(s, me, { ...t, pos: { q: 10, r: -3 } }).reason).toContain('超出射程');
    expect(shotCheck(s, { ...me, facing: 3 }, t).reason).toContain('不在射界內');
    expect(shotCheck(s, { ...me, ammo: 0 }, t).reason).toContain('沒子彈');
    expect(shotCheck(s, me, { ...t, alive: false }).reason).toContain('已經擊毀');
    expect(shotCheck(s, me, { ...t, side: 'PLAYER' }).reason).toContain('自己人');
    expect(shotCheck(s, t, me).reason).toBe('沒有武器');
    expect(weaponOf(RULES, t)).toBeNull();
    // 調參時把火控拔掉（載入時會擋，這裡只防執行期改出來的組合）
    const noFc = customRules((r) => { r.chassis.jt1.fireControl = null; });
    const s2 = range({ q: 10, r: 2 }, { rules: noFc });
    expect(shotCheck(s2, player(s2), unit(s2, 't')).reason).toBe('沒有火控');
  });

  it('正側面那一排在 180° 射界的邊界上，打得到', () => {
    const s = range({ q: 12, r: 4 });   // (2,−1) 相對 = 正東
    expect(shotCheck(s, player(s), unit(s, 't')).ok).toBe(true);
  });

  it('打得到的目標依命中率排序', () => {
    const rules = RULES;
    const map = flatMap(21, 21);
    map.units.push(
      { id: 'near', chassis: 'target', hex: { q: 10, r: 3 }, facing: 3, script: { kind: 'IDLE' } },
      { id: 'drone', chassis: 'drone', hex: { q: 11, r: 2 }, facing: 3, script: { kind: 'IDLE' } },
      { id: 'behind', chassis: 'target', hex: { q: 10, r: 8 }, facing: 3, script: { kind: 'IDLE' } },
    );
    let s = newGame(rules, map, { seed: 1, player: { chassis: 'jt1' } });
    s = patch(s, (n) => { n.units.find((u) => u.id === 'drone')!.speed = 2; });
    expect(targetsFor(s, player(s)).map((t) => t.unit.id)).toEqual(['near', 'drone']);
  });
});

describe('引擎：射擊與裝填', () => {
  const sure = customRules((r) => { r.combat.maxHit = 100; r.fireControls.std.aptitude.rifle = 100; });
  const never = customRules((r) => { r.combat.maxHit = 0; r.combat.minHit = 0; });
  const fire = { type: 'FIRE', targetId: 't' } as const;

  it('要先宣告加速；打了扣 AP、扣子彈、加熱，AP 用完推進回合', () => {
    const s = range({ q: 10, r: 2 }, { rules: sure });
    expect(checkLegal(s, fire).reason).toContain('先在左盤');
    const r = run(s, [COAST, fire]);
    expect(r.events).toContainEqual({
      type: 'FIRED', shooterId: 'player', targetId: 't', hit: true, chance: 100, damage: 10,
      from: { q: 10, r: 5 }, to: { q: 10, r: 2 },
    });
    expect(player(r.state)).toMatchObject({ ammo: 5, heat: 3 });   // +6 熱、世界階段 −3
    expect(r.state.round).toBe(2);
    expect(unit(r.state, 't').hp).toBe(10);
    expect(r.state.stats).toEqual({ shots: 1, hits: 1, kills: 0, enemyShots: 0, enemyHits: 0 });
  });

  it('打爆：hp 歸零、DESTROYED、不再擋路也不再行動；靶不算敵人，打光也不會結束', () => {
    let s = range({ q: 10, r: 2 }, { rules: sure });
    s = run(s, [COAST, fire, COAST]).state;
    const r = run(s, [fire]);
    expect(r.events).toContainEqual({ type: 'DESTROYED', unitId: 't', by: 'player' });
    expect(unit(r.state, 't').alive).toBe(false);
    expect(r.state.stats.kills).toBe(1);
    expect(r.state.over).toBeNull();
    expect(judge(r.state)).toBeNull();
    expect(checkLegal(run(r.state, [COAST]).state, fire).reason).toContain('已經擊毀');
  });

  it('沒打中：沒有傷害，照樣花子彈', () => {
    const r = run(range({ q: 10, r: 2 }, { rules: never }), [COAST, fire]);
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'FIRED', hit: false, damage: 0 }));
    expect(unit(r.state, 't').hp).toBe(20);
    expect(r.state.stats).toEqual({ shots: 1, hits: 0, kills: 0, enemyShots: 0, enemyHits: 0 });
  });

  it('命中擲骰走種子亂數：同一個種子、同一串指令 → 同一個結果', () => {
    const a = run(range({ q: 10, r: 2 }), [COAST, fire]).events;
    const b = run(range({ q: 10, r: 2 }), [COAST, fire]).events;
    expect(a).toEqual(b);
  });

  it('非法的射擊帶著成本與理由；沒有這個目標', () => {
    const s = run(range({ q: 10, r: 2 }), [COAST]).state;
    expect(checkLegal(s, { type: 'FIRE', targetId: 'ghost' })).toMatchObject({ ok: false, ap: 1, heat: 6 });
    const back = patch(s, (n) => { n.units[0].facing = 3; });
    expect(checkLegal(back, fire)).toMatchObject({ ok: false, ap: 1, heat: 6 });
    expect(checkLegal(back, fire).reason).toContain('射界');
  });

  it('裝填：彈匣滿的不能裝；裝填 2 AP 在配額 1 時透支，結算後推進回合', () => {
    let s = run(range({ q: 10, r: 2 }), [COAST]).state;
    expect(checkLegal(s, { type: 'RELOAD' })).toMatchObject({ ok: false, ap: 2, heat: 2 });
    s = patch(s, (n) => { n.units[0].ammo = 1; });
    const r = run(s, [{ type: 'RELOAD' }]);
    expect(r.events).toContainEqual({ type: 'RELOADED', unitId: 'player', ammo: 6 });
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'PHASE_END', reason: 'OVERDRAFT' }));
    expect(player(r.state)).toMatchObject({ ammo: 6, ap: 0, debt: 0 });   // 下一回合開頭已經還掉
  });

  it('沒有武器的機體不能射擊也不能裝填', () => {
    const unarmed = customRules((r) => { r.chassis.wk1.weapon = null; });
    const s = newGame(unarmed, flatMap(21, 21, [], unarmed), { seed: 1, player: { chassis: 'wk1' } });
    expect(player(s).ammo).toBe(0);
    const acted = run(s, [COAST]).state;
    expect(checkLegal(acted, { type: 'RELOAD' }).reason).toBe('沒有武器');
    expect(checkLegal(acted, { type: 'FIRE', targetId: 'x' }).reason).toBe('沒有武器');
  });
});

describe('自動單位（靶）', () => {
  it('固定靶：引擎自己走完它的階段，玩家待機之後直接回到玩家', () => {
    const s = range({ q: 10, r: 2 });
    const r = run(s, [COAST, WAIT]);
    expect(r.state.round).toBe(2);
    expect(r.state.steps[r.state.cursor]).toEqual({ kind: 'DECLARE', unitId: 'player' });
    expect(unit(r.state, 't')).toMatchObject({ pos: { q: 10, r: 2 }, speed: 0 });
  });

  it('巡邏靶機：往巡邏點開、到了換下一個、繞圈；機首轉向目標', () => {
    const map = flatMap(21, 21);
    const a = { q: 4, r: 8 };
    const b = { q: 14, r: 3 };
    map.units.push({ id: 'd', chassis: 'drone', hex: a, facing: 0, script: { kind: 'PATROL', points: [a, b], next: 0 } });
    let s = newGame(RULES, map, { seed: 1, player: { chassis: 'jt1', hex: { q: 18, r: 10 } } });
    const seen: number[] = [];
    for (let i = 0; i < 30; i++) {
      s = run(s, [COAST, WAIT]).state;
      const d = unit(s, 'd');
      if (d.script?.kind === 'PATROL') seen.push(d.script.next);
    }
    // 兩個巡邏點都輪過，而且不只一次
    expect(new Set(seen)).toEqual(new Set([0, 1]));
    expect(seen.filter((n, i) => i > 0 && n !== seen[i - 1]).length).toBeGreaterThanOrEqual(2);
  });

  it('沒有巡邏點的 PATROL 與 IDLE 一樣原地不動', () => {
    const map = flatMap(21, 21);
    map.units.push({ id: 'd', chassis: 'drone', hex: { q: 4, r: 8 }, facing: 0, script: { kind: 'PATROL', points: [], next: 0 } });
    const s = run(newGame(RULES, map, { seed: 1, player: { chassis: 'jt1' } }), [COAST, WAIT]).state;
    expect(unit(s, 'd')).toMatchObject({ pos: { q: 4, r: 8 }, speed: 0, facing: 0 });
  });
});

describe('SPAWN 鉤子與地圖上的靶', () => {
  function withSpawn(): RawMap {
    const raw = flatRaw(9, 12);
    raw.spawns.player = { col: 4, row: 10, facing: 0 };
    raw.units = [{ chassis: 'target', col: 1, row: 1 }, { chassis: 'target', col: 7, row: 1 }];
    raw.course = {
      checkpoints: [
        { type: 'PASS', col: 4, row: 9, radius: 0, hooks: [{ when: 'ACTIVATE', type: 'SPAWN', id: 'early', chassis: 'target', col: 2, row: 5 }] },
        { type: 'STOP', col: 4, row: 3, hooks: [
          { when: 'ACTIVATE', type: 'SPAWN', id: 'drone', chassis: 'drone', col: 6, row: 6, facing: 4, patrol: [[6, 6], [1, 6]] },
          { when: 'ACTIVATE', type: 'MESSAGE', text: '靶機來了' },
        ] },
      ],
    };
    return raw;
  }

  it('開局：地圖上的靶與第一個檢查點 ACTIVATE 的 SPAWN 都已經在場；id 重複自動加編號', () => {
    const s = newGame(RULES, loadMap(RULES, withSpawn()), { seed: 1, player: { chassis: 'jt1' } });
    expect(s.units.map((u) => [u.id, u.control])).toEqual([
      ['player', 'INPUT'], ['target', 'SCRIPT'], ['target2', 'SCRIPT'], ['early', 'SCRIPT'],
    ]);
  });

  it('跑到檢查點時生出新的靶：COURSE_HOOK 之後接著 SPAWNED；靶機帶著巡邏腳本', () => {
    const s = newGame(RULES, loadMap(RULES, withSpawn()), { seed: 1, player: { chassis: 'jt1' } });
    const r = applyCommand(s, { type: 'ACCEL', order: { rel: 0, taps: 1 } });
    const types = r.events.map((e: GameEvent) => e.type);
    expect(types).toContain('SPAWNED');
    expect(types.indexOf('SPAWNED')).toBeGreaterThan(types.indexOf('CHECKPOINT'));
    const d = unit(r.state, 'drone');
    expect(d).toMatchObject({ chassis: 'drone', control: 'SCRIPT', facing: 4 });
    expect(d.script).toMatchObject({ kind: 'PATROL', next: 0 });
    // MESSAGE 不是 core 的事：只轉發
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'COURSE_HOOK', hook: expect.objectContaining({ type: 'MESSAGE' }) }));
  });

  it('地圖上的靶與 SPAWN 鉤子的資料錯誤', () => {
    const raw = withSpawn();
    raw.units = [{ chassis: 'ufo', col: 1, row: 1 }, { chassis: 'target', col: 30, row: 1 }, { chassis: 'drone', col: 1, row: 2, patrol: [[1, 2], [40, 2]] }];
    expect(() => loadMap(RULES, raw)).toThrow(/units\[0\] 的機體 "ufo" 不存在/);
    raw.units = [{ chassis: 'target', col: 30, row: 1 }, { chassis: 'drone', col: 1, row: 2, patrol: [[1, 2], [40, 2]] }];
    expect(() => loadMap(RULES, raw)).toThrow(/units\[0\] 的位置在地圖外[\s\S]*units\[1\] 的巡邏點在地圖外/);
  });
});
