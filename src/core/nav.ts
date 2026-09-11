/**
 * 導航：替一個單位挑加速宣告，讓它往目標格去。
 *
 * bot 的自動駕駛現在就用它；第 6 步敵人的「朝可改善位置的方向加速」（§7）也會用。
 * 敵人與玩家共用同一套移動規則，所以這裡只能透過 movement.ts 的 resolveMotion() 推演，
 * 不得自己算位移 —— 規劃器看到的未來必須就是實際會發生的未來。
 */
import type { Hex } from './hex';
import { DIRS, SUB, hexDist, hexLen, neighbor, subToHex, turnSteps } from './hex';
import type { GameMap } from './map';
import { cellAt, hexToOffset } from './map';
import type { MotionWorld } from './movement';
import { ALL_CHOICES, accelLegality, resolveMotion, worldOf } from './movement';
import type { AccelChoice, GameState, Unit } from './state';
import { unitById } from './state';

/** 到目標要走幾步。地圖外與不可進入的格子回傳 Infinity。 */
export type DistanceFn = (h: Hex) => number;

export interface NavOptions {
  /** 往前推演幾回合。8 種宣告的 depth 次方個分支。 */
  depth?: number;
  /**
   * 「離目標多遠」怎麼量。預設是直線的 cube 距離；給 distanceField() 的結果就會繞過稜線。
   * 兩者量的都是六角步數 —— 同一把尺，只是一個穿牆、一個不穿。
   */
  dist?: DistanceFn;
}

/**
 * 從目標往外做廣度優先搜尋：每一格到目標最少要走幾步（只走可進入的格子）。
 * 貪婪的推演只看三回合，會卡在稜線背面；拿走路距離當評分就不會。
 * 一個目標算一次（40×40 是 1600 格），之後每回合查表。
 */
export function distanceField(map: GameMap, goal: Hex): DistanceFn {
  const field = new Float64Array(map.width * map.height).fill(Infinity);
  const index = (h: Hex): number => {
    const { col, row } = hexToOffset(h);
    return row * map.width + col;
  };
  if (cellAt(map, goal)?.passable) {
    const queue: Hex[] = [goal];
    field[index(goal)] = 0;
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      const d = field[index(cur)] + 1;
      for (const dir of DIRS) {
        const n = neighbor(cur, dir);
        const c = cellAt(map, n);
        if (!c || !c.passable || field[index(n)] <= d) continue;
        field[index(n)] = d;
        queue.push(n);
      }
    }
  }
  return (h) => (cellAt(map, h) ? field[index(h)] : Infinity);
}

/** 撞擊的代價，以「多離目標幾格」計。 */
const COLLISION_COST = 12;
/** 同分時偏好產熱少的選項（巡航優先於推進）。 */
const HEAT_COST = 0.01;

/**
 * 挑出這一回合的加速宣告。
 *
 * 評分是每一層推演後離目標的距離總和 —— 總和同時獎勵「快點靠近」與懲罰「衝過頭」
 * （衝過頭之後距離會再變大）。最後一層若已經很近，再按剩餘速度加分，讓它學會煞車。
 *
 * 地面驅動只能往前方三面加速，而轉向要到行動階段才做；推演第 k 層時放寬為「前方 1+k 面」，
 * 近似於「每回合轉一面」。
 */
export function planAccel(s: GameState, unitId: string, goal: Hex, opts: NavOptions = {}): AccelChoice {
  const u = unitById(s, unitId)!;
  const w = worldOf(s, unitId);
  const depth = Math.max(1, opts.depth ?? 3);
  const dist = opts.dist ?? ((h: Hex) => hexDist(h, goal));
  let best: AccelChoice = { kind: 'CRUISE' };
  let bestCost = Infinity;
  for (const c of ALL_CHOICES) {
    if (!accelLegality(s.rules, u, c).ok) continue;
    const cost = search(w, u, u, c, 0, depth, dist);
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best;
}

function reachable(w: MotionWorld, origin: Unit, c: AccelChoice, ply: number): boolean {
  if (c.kind !== 'DIR' || w.rules.drives[origin.drive].sideAccel) return true;
  return turnSteps(origin.facing, c.dir) <= 1 + ply;
}

function search(w: MotionWorld, origin: Unit, u: Unit, c: AccelChoice, ply: number, depth: number, dist: DistanceFn): number {
  const r = resolveMotion(w, u, c);
  const d = dist(subToHex(r.posSub));
  const here = d + (r.collision ? COLLISION_COST : 0) + r.heat * HEAT_COST;
  if (ply + 1 >= depth) return here + (d <= 2 ? hexLen(r.velSub) / SUB : 0);
  const next: Unit = { ...u, posSub: r.posSub, velSub: r.velSub };
  let best = Infinity;
  for (const c2 of ALL_CHOICES) {
    if (!reachable(w, origin, c2, ply + 1)) continue;
    best = Math.min(best, search(w, origin, next, c2, ply + 1, depth, dist));
  }
  return here + best;
}

/** 到了沒：這個單位的佔格離目標不超過 radius 格。 */
export function arrived(s: GameState, unitId: string, goal: Hex, radius = 1): boolean {
  return hexDist(subToHex(unitById(s, unitId)!.posSub), goal) <= radius;
}
