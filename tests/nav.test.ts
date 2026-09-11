import { describe, expect, it } from 'vitest';
import { pilotTurn } from '../bot/pilot';
import { runCourse } from '../bot/course';
import { runOne } from '../bot/match';
import { rawMapById } from '../src/core/content';
import { hexDist } from '../src/core/hex';
import type { Hex } from '../src/core/hex';
import { loadMap } from '../src/core/map';
import { accelLegality } from '../src/core/movement';
import { arrived, planAccel } from '../src/core/nav';
import { RULES } from '../src/core/rules';
import type { GameState } from '../src/core/state';
import { flatMap, game, player } from './helpers';

/** 用 bot 的自動駕駛開到目標。 */
function drive(s0: GameState, goal: Hex, maxTurns = 40): { state: GameState; turns: number; ok: boolean } {
  let s = s0;
  const there = (st: GameState) => arrived(st, 'player', goal);
  for (let t = 1; t <= maxTurns; t++) {
    expect(accelLegality(RULES, player(s), planAccel(s, 'player', goal)).ok).toBe(true);
    const r = pilotTurn(s, 'player', goal, there);
    s = r.state;
    if (r.arrivedAfterMove || there(s)) return { state: s, turns: t, ok: true };
  }
  return { state: s, turns: maxTurns, ok: false };
}

describe('導航（bot 與日後的敵人 AI 共用）', () => {
  it.each(['tk1', 'wk1', 'jt1', 'hy1'])('%s 能在空地上抵達 12 格外的目標（出發時背對目標）', (chassis) => {
    const map = flatMap(31, 31);
    const s = game(chassis, { map, facing: 3 });
    const start = player(s).pos;
    const goal = { q: start.q + 6, r: start.r - 12 };
    expect(hexDist(start, goal)).toBe(12);
    expect(drive(s, goal).ok).toBe(true);
  });

  it('噴射比步行快', () => {
    const map = flatMap(31, 31);
    const goal = (s: GameState) => ({ q: player(s).pos.q, r: player(s).pos.r - 12 });
    const jet = game('jt1', { map });
    const walk = game('wk1', { map });
    expect(drive(jet, goal(jet)).turns).toBeLessThan(drive(walk, goal(walk)).turns);
  });

  it('不會一頭撞上正前方的機體：有不撞的選項時選不撞的', () => {
    const s = game('jt1', { enemies: [{ chassis: 'tk1', hex: { q: 10, r: 4 }, facing: 3 }] });
    const choice = planAccel(s, 'player', { q: 10, r: -1 }, { depth: 1 });
    // 往前推 1 下以上都會撞上正前方那台
    expect(choice === null || choice.rel !== 0).toBe(true);
  });

  it('深度至少 1；已經在目標上就不動', () => {
    const s = game('wk1');
    const here = player(s).pos;
    expect(planAccel(s, 'player', here, { depth: 0 })).toBeNull();
    expect(arrived(s, 'player', here)).toBe(true);
    expect(arrived(s, 'player', { q: here.q, r: here.r - 3 })).toBe(false);
    expect(arrived(s, 'player', { q: here.q, r: here.r - 3 }, 3)).toBe(true);
  });
});

describe('bot（可重現的自動對局）', () => {
  it('同一個種子兩次跑出同一場', () => {
    const map = loadMap(RULES, rawMapById('proving_ground')!);
    const a = runOne(RULES, map, 'wk1', 11, 40);
    const b = runOne(RULES, map, 'wk1', 11, 40);
    expect(a).toEqual(b);
    expect(a.distance).toBeGreaterThanOrEqual(12);
  });

  it('情境：四台試驗機都跑得完基礎跑道，檢查點依序通過，而且結果可重現', () => {
    const map = loadMap(RULES, rawMapById('track_01')!);
    for (const id of Object.keys(RULES.chassis)) {
      const r = runCourse(RULES, map, id);
      expect(r.finished, id).toBe(true);
      expect(r.splits).toHaveLength(11);
      expect([...r.splits].sort((x, y) => x - y)).toEqual(r.splits);
      expect(runCourse(RULES, map, id)).toEqual(r);
    }
    expect(() => runCourse(RULES, loadMap(RULES, rawMapById('proving_ground')!), 'jt1')).toThrow('沒有跑道');
  });
});
