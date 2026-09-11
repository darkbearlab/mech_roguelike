/**
 * 導航：替一個單位挑加速宣告，讓它往目標格去。
 *
 * bot 的自動駕駛現在就用它；之後敵人的「朝可改善位置的方向加速」也會用。
 * 敵人與玩家共用同一套移動規則，所以這裡只能透過 movement.ts 的 resolveMotion() 推演，
 * 不得自己算位移 —— 規劃器看到的未來必須就是實際會發生的未來。
 *
 * 「離目標多遠」用**走路距離**：繞過開不進去的格子（地城的牆、殘骸）的最短步數，BFS 算一次、快取起來。
 * 地圖上沒有牆時就是 cube 距離（同一把尺），不必 BFS。
 */
import type { Hex } from './hex';
import { DIR_VEC, add, hexDist } from './hex';
import type { GameMap } from './map';
import { hexToOffset } from './map';
import type { MotionWorld } from './movement';
import { allOrders, resolveMotion, worldOf } from './movement';
import type { AccelOrder, GameState, Unit } from './state';
import { unitById } from './state';

// ---------------------------------------------------------------- 走路距離

/** 地圖物件不可變，拿它當鍵快取：有沒有牆、每個目標的距離場。 */
const HAS_WALLS = new WeakMap<GameMap, boolean>();
const FIELDS = new WeakMap<GameMap, Map<string, Int32Array>>();
/** 每張地圖最多留幾個目標的距離場（AI 的目標每回合都在變）。 */
const FIELD_CACHE = 256;

function hasWalls(map: GameMap): boolean {
  let v = HAS_WALLS.get(map);
  if (v === undefined) {
    v = map.cells.some((c) => !c.passable);
    HAS_WALLS.set(map, v);
  }
  return v;
}

function indexOf(map: GameMap, h: Hex): number {
  const { col, row } = hexToOffset(h);
  return col < 0 || col >= map.width || row < 0 || row >= map.height ? -1 : row * map.width + col;
}

/** 從目標往外 BFS：每格離目標幾步（只走得進開得進去的格子）；走不到 = −1。 */
function distanceField(map: GameMap, goal: Hex): Int32Array {
  const field = new Int32Array(map.width * map.height).fill(-1);
  const g = indexOf(map, goal);
  if (g < 0) return field;
  field[g] = 0;
  const queue: Hex[] = [goal];
  for (let head = 0; head < queue.length; head++) {
    const h = queue[head];
    const d = field[indexOf(map, h)];
    for (const v of DIR_VEC) {
      const n = add(h, v);
      const i = indexOf(map, n);
      if (i < 0 || field[i] >= 0 || !map.cells[i].passable) continue;
      field[i] = d + 1;
      queue.push(n);
    }
  }
  return field;
}

/** 走路距離：繞過開不進去的格子的最短步數；走不到 = Infinity。沒有牆的地圖就是 cube 距離。 */
export function walkDistance(map: GameMap, goal: Hex): (h: Hex) => number {
  if (!hasWalls(map)) return (h) => hexDist(h, goal);
  let byGoal = FIELDS.get(map);
  if (!byGoal) {
    byGoal = new Map();
    FIELDS.set(map, byGoal);
  }
  const key = `${goal.q},${goal.r}`;
  let field = byGoal.get(key);
  if (!field) {
    if (byGoal.size >= FIELD_CACHE) byGoal.clear();
    field = distanceField(map, goal);
    byGoal.set(key, field);
  }
  const f = field;
  return (h) => {
    const i = indexOf(map, h);
    return i < 0 || f[i] < 0 ? Infinity : f[i];
  };
}

export interface NavOptions {
  /** 往前推演幾回合。每層的分支數 = 這台機體所有合法的宣告（不加速＋每個方向 1..上限 下）。 */
  depth?: number;
  /** 要不要在目標停下來（預設要）。跑道的通過點不必停，衝過去就好。 */
  stop?: boolean;
  /** 從這個狀態的單位開始推演（例如機動宣告裡已經轉過向的自己）；預設是 state 裡的那一個。 */
  unit?: Unit;
}

/** 撞擊的代價，以「多離目標幾格」計。 */
const COLLISION_COST = 12;
/** 同分時偏好產熱少的選項（不加速優先於推進）。 */
const HEAT_COST = 0.01;

/**
 * 挑出這一回合的加速宣告。
 *
 * 評分是每一層推演後離目標的距離總和 —— 總和同時獎勵「快點靠近」與懲罰「衝過頭」
 * （衝過頭之後距離會再變大）。最後一層若已經很近，再按剩餘速度加分，讓它學會煞車。
 *
 * 推演時假設機首不動（轉向是右盤的事、而且可能吃速度）；每回合重新規劃，所以誤差不會累積。
 */
export function planAccel(s: GameState, unitId: string, goal: Hex, opts: NavOptions = {}): AccelOrder {
  const u = opts.unit ?? unitById(s, unitId)!;
  const w = worldOf(s, unitId);
  const depth = Math.max(1, opts.depth ?? 3);
  const stop = opts.stop ?? true;
  const dist = walkDistance(s.map, goal);
  let best: AccelOrder = null;
  let bestCost = Infinity;
  for (const o of allOrders(s.rules, u)) {
    const cost = search(w, u, o, 0, depth, dist, stop);
    if (cost < bestCost) {
      bestCost = cost;
      best = o;
    }
  }
  return best;
}

function search(w: MotionWorld, u: Unit, o: AccelOrder, ply: number, depth: number, dist: (h: Hex) => number, stop: boolean): number {
  const r = resolveMotion(w, u, o);
  // 通過點：路徑上最接近目標的那一格才算數（衝過去也算碰到）；停車點：看停在哪
  const d = stop ? dist(r.pos) : Math.min(...r.path.map(dist));
  const here = d + (r.collision ? COLLISION_COST : 0) + r.heat * HEAT_COST;
  if (ply + 1 >= depth) return here + (stop && d <= 2 ? r.speed : 0);
  const next: Unit = { ...u, pos: r.pos, heading: r.heading, speed: r.speed };
  let best = Infinity;
  for (const o2 of allOrders(w.rules, next)) best = Math.min(best, search(w, next, o2, ply + 1, depth, dist, stop));
  return here + best;
}

/** 到了沒：這個單位離目標不超過 radius 格。 */
export function arrived(s: GameState, unitId: string, goal: Hex, radius = 1): boolean {
  return hexDist(unitById(s, unitId)!.pos, goal) <= radius;
}
