import { describe, expect, it } from 'vitest';
import { runCourse } from '../bot/course';
import { arcHexes, coverOf, hitChance, lineOfSight, shotCheck } from '../src/core/combat';
import { DUNGEON_ID, RAW_MAPS, rawMapById, rawMapFor } from '../src/core/content';
import { generateDungeon } from '../src/core/dungeon';
import { judge, newGame } from '../src/core/engine';
import { hexDist } from '../src/core/hex';
import { cellAt, loadMap, offsetToHex } from '../src/core/map';
import type { RawUnit } from '../src/core/map';
import { resolveMotion, worldOf } from '../src/core/movement';
import { planAccel, walkDistance } from '../src/core/nav';
import { RULES } from '../src/core/rules';
import type { GameState } from '../src/core/state';
import { unitById } from '../src/core/state';
import { COAST, WAIT, customRules, flatRaw, patch, player, run } from './helpers';

/** 21×21 空地，(col, row) 指定的格子換成牆（X）或殘骸（o）。玩家在 (10,10) = axial (10,5)，朝北。 */
function walled(paint: [number, number, string][], units: RawUnit[] = []): GameState {
  const raw = flatRaw(21, 21, paint);
  raw.units = units;
  return newGame(RULES, loadMap(RULES, raw), { seed: 1, player: { chassis: 'wk1' } });
}

/** 一整排牆：第 row 列從 c0 到 c1。 */
const wallRow = (row: number, c0: number, c1: number, g = 'X'): [number, number, string][] =>
  Array.from({ length: c1 - c0 + 1 }, (_, i) => [c0 + i, row, g] as [number, number, string]);

describe('牆與殘骸（地城起有了擋路的地形）', () => {
  it('開不進去：撞上牆就停在前一格、速度歸零', () => {
    const push = { rel: 0 as const, taps: 1 };   // 步行 1 速往北推 → 2 速
    const s = walled([[10, 8, 'X']]);   // 玩家正北 2 格
    const r = resolveMotion(worldOf(s, 'player'), { ...player(s), speed: 1, heading: 0 }, push);
    expect(r.collision).toMatchObject({ blocker: 'WALL' });
    expect(r.pos).toEqual({ q: 10, r: 4 });
    expect(r.speed).toBe(0);
    // 殘骸也開不進去；碎石照舊開得過去
    expect(resolveMotion(worldOf(walled([[10, 8, 'o']]), 'player'), { ...player(s), speed: 1, heading: 0 }, push).collision?.blocker).toBe('WALL');
    expect(resolveMotion(worldOf(walled([[10, 8, ',']]), 'player'), { ...player(s), speed: 1, heading: 0 }, push).collision).toBeNull();
  });

  it('視線：牆擋、稜線擋、殘骸不擋；兩個方向對稱；貼著的永遠看得到', () => {
    const far = { q: 10, r: 1 };   // 玩家正北 4 格；擋在中間的是正北 2 格那一格
    const see = (g: string) => {
      const s = walled([[10, 8, g]]);
      const a = lineOfSight(s.map, player(s).pos, far);
      expect(lineOfSight(s.map, far, player(s).pos)).toBe(a);
      return a;
    };
    expect(see('X')).toBe(false);
    expect(see('#')).toBe(false);
    expect(see('o')).toBe(true);
    const s = walled([[10, 8, 'X']]);
    expect(lineOfSight(s.map, player(s).pos, { q: 10, r: 4 })).toBe(true);
  });

  it('打不到牆後面的；半掩體（緊貼目標的殘骸）扣命中，明細裡寫著', () => {
    const behindWall = walled([[10, 7, 'X']], [{ id: 't', chassis: 'target', col: 10, row: 6 }]);
    expect(shotCheck(behindWall, player(behindWall), unitById(behindWall, 't')!).reason).toBe('視線被擋住了');
    const inCover = walled([[10, 7, 'o']], [{ id: 't', chassis: 'target', col: 10, row: 6 }]);
    const t = unitById(inCover, 't')!;
    expect(coverOf(inCover.map, player(inCover).pos, t.pos)).toBe(25);
    const chk = shotCheck(inCover, player(inCover), t);
    expect(chk).toMatchObject({ ok: true, chance: 85 - 25 });
    expect(chk.terms.find((x) => x.key === 'COVER')).toMatchObject({ value: -25, label: '目標在半掩體後' });
    // 殘骸不緊貼目標（離目標 2 格）就不算
    const far = walled([[10, 8, 'o']], [{ id: 't', chassis: 'target', col: 10, row: 6 }]);
    expect(coverOf(far.map, player(far).pos, unitById(far, 't')!.pos)).toBe(0);
    expect(hitChance(RULES, RULES.fireControls.std, RULES.weapons.rifle, player(far), unitById(far, 't')!).terms.find((x) => x.key === 'COVER')!.value).toBe(0);
  });

  it('介面的射界扇形：給了地圖就只亮看得到、站得了人的格子', () => {
    const s = walled([...wallRow(8, 7, 13)]);
    const me = player(s);
    const all = arcHexes(RULES.weapons.rifle, me.pos, me.facing);
    const lit = arcHexes(RULES.weapons.rifle, me.pos, me.facing, s.map);
    expect(lit.length).toBeLessThan(all.length);
    for (const h of lit) expect(cellAt(s.map, h)?.passable && lineOfSight(s.map, me.pos, h)).toBe(true);
  });
});

describe('導航繞牆（走路距離）', () => {
  it('BFS 走路距離：繞過牆；走不到、地圖外 = Infinity；沒牆的地圖就是 cube 距離', () => {
    const s = walled(wallRow(8, 0, 19));   // 玩家北邊一整排牆，只留最右邊一格
    const goal = { q: 10, r: 1 };
    const d = walkDistance(s.map, goal);
    expect(d(player(s).pos)).toBeGreaterThan(hexDist(player(s).pos, goal));
    expect(d({ q: 99, r: 99 })).toBe(Infinity);
    const sealed = walled(wallRow(8, 0, 20));
    expect(walkDistance(sealed.map, goal)(player(sealed).pos)).toBe(Infinity);
    expect(walkDistance(sealed.map, { q: -50, r: 0 })(player(sealed).pos)).toBe(Infinity);
    const open = walled([]);
    expect(walkDistance(open.map, goal)(player(open).pos)).toBe(hexDist(player(open).pos, goal));
  });

  it('距離場有快取，目標太多時整批丟掉重算（結果不變）', () => {
    const s = walled(wallRow(8, 0, 19));
    const first = walkDistance(s.map, { q: 10, r: 1 })(player(s).pos);
    for (let i = 0; i < 300; i++) walkDistance(s.map, offsetToHex(i % 21, Math.floor(i / 21) % 21));
    expect(walkDistance(s.map, { q: 10, r: 1 })(player(s).pos)).toBe(first);
  });

  it('自動駕駛繞得過一整排牆，開到牆的另一邊', () => {
    const s0 = walled(wallRow(8, 0, 18));   // 右邊留兩格缺口
    const goal = offsetToHex(10, 3);
    let s = s0;
    for (let t = 0; t < 40 && hexDist(player(s).pos, goal) > 1; t++) {
      s = run(s, [{ type: 'ACCEL', order: planAccel(s, 'player', goal) }, WAIT]).state;
    }
    expect(hexDist(player(s).pos, goal)).toBeLessThanOrEqual(1);
  });
});

describe('守衛（地城的輕戰車）', () => {
  const tank = (col: number, row: number): RawUnit => ({ id: 'tank', chassis: 'tank', col, row, facing: 3, ai: 'GUARD' });

  it('還沒發現你之前原地不動、不開火', () => {
    const s = walled([], [tank(10, 0)]);   // 距離 10，超過感測 8
    const r = run(s, [COAST, WAIT]);
    expect(unitById(r.state, 'tank')).toMatchObject({ pos: unitById(s, 'tank')!.pos, script: { kind: 'GUARD', awake: false } });
    expect(r.events.some((e) => e.type === 'FIRED' || e.type === 'ALERTED')).toBe(false);
  });

  it('感測距離內看得到你就醒：ALERTED（SPOTTED），同一回合就開始行動', () => {
    const s = walled([], [tank(10, 4)]);   // 距離 6
    const r = run(s, [COAST, WAIT]);
    expect(r.events).toContainEqual({ type: 'ALERTED', unitId: 'tank', why: 'SPOTTED' });
    expect(unitById(r.state, 'tank')!.script).toEqual({ kind: 'GUARD', awake: true });
    expect(r.events.some((e) => e.type === 'FIRED' && e.shooterId === 'tank')).toBe(true);
  });

  it('隔著牆看不到就不醒', () => {
    const s = walled(wallRow(8, 6, 14), [tank(10, 4)]);
    const r = run(s, [COAST, WAIT]);
    expect(unitById(r.state, 'tank')!.script).toEqual({ kind: 'GUARD', awake: false });
  });

  it('被開槍打（打中打不中都算）就醒：ALERTED（SHOT）', () => {
    // 感測距離調成 0：看不到你，只能被打醒。戰車在玩家正北 4 格（射程內）
    const blind = customRules((r) => { r.chassis.tank.sensorRange = 0; });
    const raw = flatRaw(21, 21);
    raw.units = [tank(10, 6)];
    const s = newGame(blind, loadMap(blind, raw), { seed: 1, player: { chassis: 'wk1' } });
    const r = run(s, [COAST, { type: 'FIRE', targetId: 'tank' }]);
    expect(r.events).toContainEqual({ type: 'ALERTED', unitId: 'tank', why: 'SHOT' });
  });

  it('有跑道的地圖只有終點算數：把敵人打光也不會提早結束', () => {
    const raw = flatRaw(21, 21);
    raw.units = [tank(10, 4)];
    raw.course = { checkpoints: [{ type: 'PASS', col: 10, row: 1 }] };
    const s = patch(newGame(RULES, loadMap(RULES, raw), { seed: 1, player: { chassis: 'wk1' } }), (n) => { n.units[1].alive = false; });
    expect(judge(s)).toBeNull();
  });
});

describe('地城產生器', () => {
  it('同一個種子同一張圖；不同種子不同圖；讀得進來（跟手畫的地圖走同一條驗證）', () => {
    expect(generateDungeon(7)).toEqual(generateDungeon(7));
    expect(generateDungeon(7).rows).not.toEqual(generateDungeon(8).rows);
    for (let seed = 1; seed <= 12; seed++) {
      const raw = generateDungeon(seed);
      const m = loadMap(RULES, raw);
      expect(m.course!.checkpoints).toHaveLength(1);
      expect(m.units.every((u) => u.chassis === 'tank' && u.script.kind === 'GUARD')).toBe(true);
    }
  });

  it('起點走得到出口；出口房間有戰車；戰車站在地板上', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const m = loadMap(RULES, generateDungeon(seed));
      const exit = m.course!.checkpoints[0].at;
      expect(walkDistance(m, exit)(m.playerSpawn.hex), `seed ${seed}`).toBeLessThan(Infinity);
      expect(m.units.some((u) => hexDist(u.hex, exit) <= 6)).toBe(true);
      for (const u of m.units) expect(cellAt(m, u.hex)?.passable).toBe(true);
    }
  });

  it('參數：地圖大小、房間數、戰車數（房間塞不下就少放）', () => {
    const small = generateDungeon(3, { width: 30, height: 24, rooms: 4, tanks: 2, enemy: 'wk1', chassis: 'jt1' });
    expect(small).toMatchObject({ width: 30, height: 24, course: { chassis: 'jt1' } });
    expect(small.units!.every((u) => u.chassis === 'wk1')).toBe(true);
    expect(small.units!.length).toBeLessThanOrEqual(2);
    const crowded = generateDungeon(3, { tanks: 500 });
    expect(crowded.units!.length).toBeLessThan(500);
    loadMap(RULES, crowded);
  });

  it('內容清單：地城照種子產生；其他地圖照 id', () => {
    expect(rawMapFor(DUNGEON_ID, 5)).toEqual(generateDungeon(5));
    expect(rawMapFor('track_01', 5)).toBe(rawMapById('track_01'));
    expect(RAW_MAPS.map((m) => m.id)).toContain(DUNGEON_ID);
  });

  it('自動駕駛走得到出口（笨方法：往出口開、打得中就打）', () => {
    let cleared = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const r = runCourse(RULES, loadMap(RULES, generateDungeon(seed)), 'wk1', 150, seed);
      if (r.finished) cleared++;
      expect(r.enemies).toBeGreaterThan(0);
      if (r.died) expect(r.hpLeft).toBe(0);
    }
    expect(cleared).toBeGreaterThanOrEqual(3);
  });
});
