/**
 * 情境測試：讓自動駕駛跑一條跑道，量每台機體要幾回合、每個檢查點在第幾回合過。
 *
 * 跑道是固定的，所以同一份規則永遠跑出同一個結果 —— 改數值之後重跑，差多少一目了然。
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
}

export function runCourse(rules: Rules, map: GameMap, chassis: string, maxTurns = 120): CourseResult {
  const course = map.course;
  if (!course) throw new Error(`地圖 ${map.id} 沒有跑道`);
  let s = newGame(rules, map, { seed: 1, player: { chassis } });
  const r: CourseResult = { chassis, finished: false, turns: maxTurns, splits: [], heatPeak: 0, collisions: 0 };
  const goal = (st: GameState) => {
    const cp = course.checkpoints[Math.min(st.course!.next, course.checkpoints.length - 1)];
    return { at: cp.at, stop: cp.type === 'STOP' };
  };
  for (let t = 1; t <= maxTurns && !s.over; t++) {
    const turn = pilotTurn(s, 'player', goal, (st) => st.over !== null);
    s = turn.state;
    r.heatPeak = Math.max(r.heatPeak, turn.heatPeak);
    r.collisions += turn.events.filter((e) => e.type === 'COLLIDED').length;
  }
  r.splits = [...s.course!.reached];
  if (s.course!.done !== null) {
    r.finished = true;
    r.turns = s.course!.done;
  }
  return r;
}
