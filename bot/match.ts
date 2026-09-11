/**
 * 一場自動對局。與 CLI（run.ts）分開，測試才能直接呼叫而不會觸發整批執行。
 *
 * 第 2 步還沒有敵人與武器，所以「一場」= 從隨機起點開到隨機目標點，抵達或逾時。
 */
import { newGame } from '../src/core/engine';
import type { Dir, Hex } from '../src/core/hex';
import { hexDist, hexLen } from '../src/core/hex';
import { allHexes, cellAt } from '../src/core/map';
import type { GameMap } from '../src/core/map';
import { arrived, distanceField } from '../src/core/nav';
import { createRng, nextInt } from '../src/core/rng';
import type { RngState } from '../src/core/rng';
import type { Rules } from '../src/core/rules';
import type { GameState } from '../src/core/state';
import { pilotTurn } from './pilot';

export interface RunResult {
  seed: number;
  chassis: string;
  arrived: boolean;
  /** 抵達用了幾回合；沒抵達 = 上限。 */
  turns: number;
  /** 起點到目標的直線距離（格）。 */
  distance: number;
  heatPeak: number;
  collisions: number;
  /** 最高速（sub/回合）。 */
  topSpeed: number;
  shutdowns: number;
}

export const MIN_DIST = 12;
export const MAX_DIST = 24;

function pickOpen(map: GameMap, rng: RngState, cells: Hex[]): Hex {
  for (;;) {
    const h = cells[nextInt(rng, cells.length)];
    if (cellAt(map, h)?.passable) return h;
  }
}

/** 同一個種子永遠是同一場（§1：bot 對局可重現）。 */
export function runOne(rules: Rules, map: GameMap, chassis: string, seed: number, maxTurns: number): RunResult {
  const rng = createRng(seed);
  const cells = allHexes(map);
  const start = pickOpen(map, rng, cells);
  let goal = pickOpen(map, rng, cells);
  let dist = distanceField(map, goal);
  while (hexDist(start, goal) < MIN_DIST || hexDist(start, goal) > MAX_DIST || dist(start) === Infinity) {
    goal = pickOpen(map, rng, cells);
    dist = distanceField(map, goal);
  }
  const facing = nextInt(rng, 6) as Dir;

  let s = newGame(rules, map, { seed, player: { chassis, hex: start, facing } });
  const r: RunResult = {
    seed, chassis, arrived: false, turns: maxTurns, distance: hexDist(start, goal),
    heatPeak: 0, collisions: 0, topSpeed: 0, shutdowns: 0,
  };
  const there = (st: GameState): boolean => arrived(st, 'player', goal);
  for (let t = 1; t <= maxTurns; t++) {
    const turn = pilotTurn(s, 'player', goal, there, dist);
    s = turn.state;
    r.heatPeak = Math.max(r.heatPeak, turn.heatPeak);
    r.topSpeed = Math.max(r.topSpeed, hexLen(s.units[0].velSub));
    for (const e of turn.events) {
      if (e.type === 'COLLIDED') r.collisions++;
      if (e.type === 'OVERHEAT') r.shutdowns++;
    }
    if (turn.arrivedAfterMove || there(s)) {
      r.arrived = true;
      r.turns = t;
      break;
    }
  }
  return r;
}
