import { describe, expect, it } from 'vitest';
import { pilotTurn } from '../bot/pilot';
import { runOne } from '../bot/match';
import { hexDist, subToHex } from '../src/core/hex';
import type { Hex } from '../src/core/hex';
import { loadMap, offsetToHex } from '../src/core/map';
import { accelLegality } from '../src/core/movement';
import { arrived, distanceField, planAccel } from '../src/core/nav';
import type { DistanceFn } from '../src/core/nav';
import { RULES } from '../src/core/rules';
import type { GameState } from '../src/core/state';
import { rawMapById } from '../src/core/content';
import { flatMap, game, player } from './helpers';

/** 用 bot 的自動駕駛開到目標。 */
function drive(s0: GameState, goal: Hex, dist?: DistanceFn, maxTurns = 40): { state: GameState; turns: number; ok: boolean } {
  let s = s0;
  const there = (st: GameState) => arrived(st, 'player', goal);
  for (let t = 1; t <= maxTurns; t++) {
    const before = player(s);
    const choice = planAccel(s, 'player', goal, { dist });
    expect(accelLegality(RULES, before, choice).ok).toBe(true);
    const r = pilotTurn(s, 'player', goal, there, dist);
    s = r.state;
    if (r.arrivedAfterMove || there(s)) return { state: s, turns: t, ok: true };
  }
  return { state: s, turns: maxTurns, ok: false };
}

describe('導航（bot 與日後的敵人 AI 共用）', () => {
  it.each(['tk1', 'wk1', 'jt1', 'hy1'])('%s 能在空地上抵達 12 格外的目標', (chassis) => {
    const map = flatMap(31, 31);
    const s = game(chassis, { map, facing: 3 });
    const start = subToHex(player(s).posSub);
    const goal = { q: start.q + 6, r: start.r - 12 };
    expect(hexDist(start, goal)).toBe(12);
    expect(drive(s, goal).ok).toBe(true);
  });

  it('噴射比步行快', () => {
    const map = flatMap(31, 31);
    const goal = (s: GameState) => {
      const h = subToHex(player(s).posSub);
      return { q: h.q, r: h.r - 12 };
    };
    const jet = game('jt1', { map });
    const walk = game('wk1', { map });
    expect(drive(jet, goal(jet)).turns).toBeLessThan(drive(walk, goal(walk)).turns);
  });

  it('不會一頭撞上正前方的稜線：有不撞的選項時選不撞的', () => {
    const map = flatMap(21, 21, [[10, 9, '#']]);
    const s = game('jt1', { map });
    const start = subToHex(player(s).posSub);
    const choice = planAccel(s, 'player', { q: start.q, r: start.r - 6 }, { depth: 1 });
    expect(choice).not.toEqual({ kind: 'DIR', dir: 0 });
  });

  it('深度至少 1；到了就想停', () => {
    const s = game('wk1');
    const here = subToHex(player(s).posSub);
    expect(planAccel(s, 'player', here, { depth: 0 })).toEqual({ kind: 'CRUISE' });
    expect(arrived(s, 'player', here)).toBe(true);
    expect(arrived(s, 'player', { q: here.q, r: here.r - 3 })).toBe(false);
    expect(arrived(s, 'player', { q: here.q, r: here.r - 3 }, 3)).toBe(true);
  });
});

describe('距離場：繞過稜線的走路距離', () => {
  // 一道橫牆（第 8 列的 3..17 欄）把出生點與北方隔開，只能從兩端繞
  const wall: [number, number, string][] = [];
  for (let col = 3; col <= 17; col++) wall.push([col, 8, '#'], [col, 7, '#']);

  it('空地上等於直線距離；牆後面比直線遠；牆本身與地圖外是 Infinity', () => {
    const open = flatMap(21, 21);
    const goal = offsetToHex(10, 2);
    const f = distanceField(open, goal);
    expect(f(offsetToHex(10, 10))).toBe(hexDist(offsetToHex(10, 10), goal));

    const walled = flatMap(21, 21, wall);
    const g = distanceField(walled, goal);
    expect(g(offsetToHex(10, 10))).toBeGreaterThan(hexDist(offsetToHex(10, 10), goal));
    expect(g(offsetToHex(10, 8))).toBe(Infinity);
    expect(g(offsetToHex(-1, 0))).toBe(Infinity);
    expect(g(goal)).toBe(0);
  });

  it('目標本身不可進入時整張圖都是 Infinity', () => {
    const map = flatMap(21, 21, [[10, 2, '#']]);
    expect(distanceField(map, offsetToHex(10, 2))(offsetToHex(10, 10))).toBe(Infinity);
  });

  it('有距離場時，步行機能繞過牆抵達牆後的目標', () => {
    const map = flatMap(21, 21, wall);
    const s = game('wk1', { map });
    const goal = offsetToHex(10, 2);
    expect(drive(s, goal, distanceField(map, goal), 60).ok).toBe(true);
  });
});

describe('bot（§1：可重現的自動對局）', () => {
  it('同一個種子兩次跑出同一場', () => {
    const map = loadMap(RULES, rawMapById('proving_ground')!);
    const a = runOne(RULES, map, 'wk1', 11, 40);
    const b = runOne(RULES, map, 'wk1', 11, 40);
    expect(a).toEqual(b);
    expect(a.distance).toBeGreaterThanOrEqual(12);
  });
});
