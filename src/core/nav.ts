/**
 * 導航：替一個單位挑加速宣告，讓它往目標格去。
 *
 * bot 的自動駕駛現在就用它；之後敵人的「朝可改善位置的方向加速」也會用。
 * 敵人與玩家共用同一套移動規則，所以這裡只能透過 movement.ts 的 resolveMotion() 推演，
 * 不得自己算位移 —— 規劃器看到的未來必須就是實際會發生的未來。
 *
 * 地形目前不擋路（先無視地形限制），所以「離目標多遠」直接用 cube 距離。
 * 等地形限制回來，要在這裡換成繞路的走路距離（先前的版本有一個 BFS 距離場，可從 git 歷史撈回來）。
 */
import type { Hex } from './hex';
import { hexDist } from './hex';
import type { MotionWorld } from './movement';
import { allOrders, resolveMotion, worldOf } from './movement';
import type { AccelOrder, GameState, Unit } from './state';
import { unitById } from './state';

export interface NavOptions {
  /** 往前推演幾回合。每層的分支數 = 這台機體所有合法的宣告（不加速＋每個方向 1..上限 下）。 */
  depth?: number;
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
  const u = unitById(s, unitId)!;
  const w = worldOf(s, unitId);
  const depth = Math.max(1, opts.depth ?? 3);
  let best: AccelOrder = null;
  let bestCost = Infinity;
  for (const o of allOrders(s.rules, u)) {
    const cost = search(w, u, o, 0, depth, goal);
    if (cost < bestCost) {
      bestCost = cost;
      best = o;
    }
  }
  return best;
}

function search(w: MotionWorld, u: Unit, o: AccelOrder, ply: number, depth: number, goal: Hex): number {
  const r = resolveMotion(w, u, o);
  const d = hexDist(r.pos, goal);
  const here = d + (r.collision ? COLLISION_COST : 0) + r.heat * HEAT_COST;
  if (ply + 1 >= depth) return here + (d <= 2 ? r.speed : 0);
  const next: Unit = { ...u, pos: r.pos, heading: r.heading, speed: r.speed };
  let best = Infinity;
  for (const o2 of allOrders(w.rules, next)) best = Math.min(best, search(w, next, o2, ply + 1, depth, goal));
  return here + best;
}

/** 到了沒：這個單位離目標不超過 radius 格。 */
export function arrived(s: GameState, unitId: string, goal: Hex, radius = 1): boolean {
  return hexDist(unitById(s, unitId)!.pos, goal) <= radius;
}
