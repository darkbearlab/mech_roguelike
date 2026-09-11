/** 測試用的小工具：造地圖、開局、連打指令。 */
import { applyCommand, newGame } from '../src/core/engine';
import type { Setup } from '../src/core/engine';
import type { Dir, Hex } from '../src/core/hex';
import { loadMap } from '../src/core/map';
import type { GameMap, RawMap } from '../src/core/map';
import { RULES } from '../src/core/rules';
import type { Rules } from '../src/core/rules';
import type { Command, GameEvent, GameState, RelDir, Unit } from '../src/core/state';

/**
 * 一張全開闊的小地圖。`paint` 用位移座標把某些格子換成別的地形字元。
 * 出生點預設在正中央、朝北。
 */
export function flatRaw(width = 21, height = 21, paint: [number, number, string][] = []): RawMap {
  const rows = Array.from({ length: height }, () => '.'.repeat(width).split(''));
  for (const [col, row, g] of paint) rows[row][col] = g;
  return {
    id: 'test',
    name: '測試場',
    width,
    height,
    rows: rows.map((r) => r.join('')),
    spawns: { player: { col: Math.floor(width / 2), row: Math.floor(height / 2), facing: 0 } },
  };
}

export function flatMap(width = 21, height = 21, paint: [number, number, string][] = [], rules: Rules = RULES): GameMap {
  return loadMap(rules, flatRaw(width, height, paint));
}

export interface GameOpts {
  rules?: Rules;
  map?: GameMap;
  hex?: Hex;
  facing?: Dir;
  enemies?: Setup['enemies'];
  seed?: number;
}

export function game(chassis: string, o: GameOpts = {}): GameState {
  const rules = o.rules ?? RULES;
  return newGame(rules, o.map ?? flatMap(21, 21, [], rules), {
    seed: o.seed ?? 1,
    player: { chassis, hex: o.hex, facing: o.facing },
    enemies: o.enemies,
  });
}

export function player(s: GameState): Unit {
  return s.units[0];
}

/** 連打一串指令；任何一個被拒就丟例外（測試裡的非法指令應該是刻意的，不該悄悄吞掉）。 */
export function run(s: GameState, cmds: Command[]): { state: GameState; events: GameEvent[] } {
  let cur = s;
  const events: GameEvent[] = [];
  for (const c of cmds) {
    const r = applyCommand(cur, c);
    if (r.state === cur) throw new Error('指令被拒：' + JSON.stringify(c));
    cur = r.state;
    events.push(...r.events);
  }
  return { state: cur, events };
}

/** 左盤：往相對機首 rel 的方向點 taps 下，然後確認。 */
export const accel = (rel: RelDir, taps: number): Command => ({ type: 'ACCEL', order: { rel, taps } });
/** 左盤：什麼都不點，直接確認。 */
export const COAST: Command = { type: 'ACCEL', order: null };
export const WAIT: Command = { type: 'WAIT' };
export const TURN_R: Command = { type: 'TURN', delta: 1 };
export const TURN_L: Command = { type: 'TURN', delta: -1 };

/** 直接改複製品上的欄位（模擬第 5 步以後才會有的傷害、外部加熱等）。 */
export function patch(s: GameState, f: (s: GameState) => void): GameState {
  const n = structuredClone({ ...s, rules: null, map: null }) as unknown as GameState;
  n.rules = s.rules;
  n.map = s.map;
  f(n);
  return n;
}

/** 把一份 Rules 複製出來改（改 actions 之類 withPatch 不開放的欄位）。 */
export function customRules(f: (r: Rules) => void): Rules {
  const r = structuredClone(RULES);
  f(r);
  return r;
}
