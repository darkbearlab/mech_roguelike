/**
 * 情境測試：讓自動駕駛跑一條跑道，量每台機體要幾回合、每個檢查點在第幾回合過；
 * 有靶的跑道另外量射了幾發、中了幾發、打爆幾個。
 *
 * 跑道是固定的，擲骰用固定種子，所以同一份規則永遠跑出同一個結果 —— 改數值之後重跑，差多少一目了然。
 */
import { newGame } from '../src/core/engine';
import type { GameMap } from '../src/core/map';
import type { Rules } from '../src/core/rules';
import type { GameState } from '../src/core/state';
import { pilotTurn } from './pilot';

export interface CourseResult {
  chassis: string;
  finished: boolean;
  /** 完賽回合；沒跑完 = 上限。 */
  turns: number;
  /** 每個檢查點在第幾回合通過。 */
  splits: number[];
  heatPeak: number;
  collisions: number;
  shots: number;
  hits: number;
  kills: number;
  /** 這一局總共出現過幾個靶。 */
  targets: number;
  /** 玩家總共按了幾下（左盤轉向面數 + 點數 + 確認 + 右盤每個行動）。 */
  inputs: number;
  /** 被打爆了（地城之類有敵人的跑道）。 */
  died: boolean;
  hpLeft: number;
  /** 這一局有幾台敵人（role ENEMY，例如地城的輕戰車）。 */
  enemies: number;
}

export function runCourse(rules: Rules, map: GameMap, chassis: string, maxTurns = 120, seed = 1): CourseResult {
  const course = map.course;
  if (!course) throw new Error(`地圖 ${map.id} 沒有跑道`);
  let s = newGame(rules, map, { seed, player: { chassis } });
  const r: CourseResult = {
    chassis, finished: false, turns: maxTurns, splits: [], heatPeak: 0, collisions: 0,
    shots: 0, hits: 0, kills: 0, targets: 0, inputs: 0, died: false, hpLeft: 0, enemies: 0,
  };
  const goal = (st: GameState) => {
    const cp = course.checkpoints[Math.min(st.course!.next, course.checkpoints.length - 1)];
    return { at: cp.at, stop: cp.type === 'STOP' };
  };
  for (let t = 1; t <= maxTurns && !s.over; t++) {
    const turn = pilotTurn(s, 'player', goal, (st) => st.over !== null);
    s = turn.state;
    r.heatPeak = Math.max(r.heatPeak, turn.heatPeak);
    r.collisions += turn.events.filter((e) => e.type === 'COLLIDED').length;
    r.inputs += turn.inputs;
  }
  r.splits = [...s.course!.reached];
  if (s.course!.done !== null) {
    r.finished = true;
    r.turns = s.course!.done;
  }
  r.shots = s.stats.shots;
  r.hits = s.stats.hits;
  r.kills = s.stats.kills;
  r.targets = s.units.filter((u) => rules.chassis[u.chassis].role === 'TARGET').length;
  r.enemies = s.units.filter((u) => rules.chassis[u.chassis].role === 'ENEMY').length;
  r.died = s.over?.winner === 'ENEMY';
  r.hpLeft = s.units.find((u) => u.id === 'player')!.hp;
  return r;
}
