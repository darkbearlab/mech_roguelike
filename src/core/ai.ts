/**
 * 敵機 AI（決鬥用）。
 *
 * 跟玩家、bot 用**同一套規則**：移動只挑合法的加速宣告、用 resolveMotion 推演（nav.ts 也是），
 * 行動送的是和玩家一樣的指令，由引擎照同一段 checkLegal / 效果程式碼結算 —— 敵人沒有捷徑。
 *
 * 移動：
 *   - 還遠：用 nav.planAccel 往對手身邊的有利射程開
 *   - 近了：每個合法的加速宣告推演一回合，挑分數最低的 ——
 *     移動完對手還在射界內（轉向要花 AP，花掉就沒得打）＞ 距離落在有利射程 ＞ 自己打得準、對方打不準
 *     （對方的命中率用它現在的速度估：它在我之後才動）。「開快比較難被打中」就是從這一項來的。
 * 行動：打得中（≥ 門檻）就打；對手不在射界內、轉向免費就轉；打光了裝填；太熱散熱；
 *       這回合反正打不到了才花 AP 轉向；其餘待機。
 *
 * bot 的決鬥也用這一顆腦袋開玩家那台，所以兩邊是對稱的：勝率反映的是機體與先後手，不是 AI 的差距。
 */
import { shotCheck, weaponOf } from './combat';
import { isHot } from './economy';
import { checkLegal, turnPrice } from './engine';
import type { Dir, Hex } from './hex';
import { DIR_VEC, add, dirToward, hexDist, rotate, scale, turnSteps } from './hex';
import { cellAt } from './map';
import { allOrders, resolveMotion, worldOf } from './movement';
import { planAccel } from './nav';
import type { AccelOrder, Command, GameState, Unit } from './state';

/** 命中率至少這麼高才開槍（點數）。 */
export const AI_FIRE_THRESHOLD = 25;

/** 近戰評分的權重（以「差幾格」為單位）。 */
const COST = {
  /** 移動完對手不在射界內（或打不到）。 */
  noShot: 3,
  /** 自己的命中率每少 25 點 / 對方的命中率每多 25 點。 */
  per25: 1,
  collision: 12,
  heat: 0.01,
} as const;

/** 離有利射程還差這麼多格以上，就先用導航靠近。 */
const APPROACH_MARGIN = 3;

/** 最近的對手：另一邊、還活著、不是靶。 */
export function foeOf(s: GameState, u: Unit): Unit | null {
  let best: Unit | null = null;
  for (const o of s.units) {
    if (!o.alive || o.side === u.side || s.rules.chassis[o.chassis].role === 'TARGET') continue;
    if (!best || hexDist(u.pos, o.pos) < hexDist(u.pos, best.pos)) best = o;
  }
  return best;
}

/** 想站的距離：武器有利射程的中間；沒有武器就貼上去。 */
function preferredRange(s: GameState, u: Unit): number {
  const w = weaponOf(s.rules, u);
  return w ? Math.round((w.optimal.min + w.optimal.max) / 2) : 1;
}

/**
 * 這回合往哪開。從對手看過來的方向 = bearing：
 * 還遠 → 對手身邊、bearing 方向的有利射程格（沿直線靠近）；
 * 到了 → 同樣的距離、順時針偏 60°（繞圈）。在地圖外就換別的方向。
 */
export function duelGoal(s: GameState, u: Unit, foe: Unit): Hex {
  const want = preferredRange(s, u);
  const bearing = dirToward(foe.pos, u.pos, u.heading);
  const far = hexDist(u.pos, foe.pos) > want + 1;
  const order: number[] = far ? [0, 1, -1, 2, -2, 3] : [1, -1, 2, -2, 0, 3];
  for (const k of order) {
    const g = add(foe.pos, scale(DIR_VEC[rotate(bearing, k)], want));
    if (cellAt(s.map, g)) return g;
  }
  return foe.pos;
}

/** 加速宣告。沒有對手就不加速（照樣衰減）。 */
export function duelAccel(s: GameState, u: Unit): AccelOrder {
  const foe = foeOf(s, u);
  if (!foe) return null;
  if (hexDist(u.pos, foe.pos) > preferredRange(s, u) + APPROACH_MARGIN) {
    return planAccel(s, u.id, duelGoal(s, u, foe), { depth: 2, stop: false });
  }
  return tacticalAccel(s, u, foe);
}

/** 這樣加速之後的局面分數（越低越好）。 */
export function tacticalCost(s: GameState, u: Unit, foe: Unit, order: AccelOrder): number {
  const r = resolveMotion(worldOf(s, u.id), u, order);
  const me: Unit = { ...u, pos: r.pos, heading: r.heading, speed: r.speed };
  let cost = Math.abs(hexDist(r.pos, foe.pos) - preferredRange(s, u));
  if (r.collision) cost += COST.collision;
  cost += r.heat * COST.heat;
  const mine = shotCheck(s, me, foe);
  cost += mine.ok ? ((100 - mine.chance) / 25) * COST.per25 : COST.noShot;
  const theirs = shotCheck(s, foe, me);
  if (theirs.ok) cost += (theirs.chance / 25) * COST.per25;
  return cost;
}

function tacticalAccel(s: GameState, u: Unit, foe: Unit): AccelOrder {
  let best: AccelOrder = null;
  let bestCost = Infinity;
  for (const o of allOrders(s.rules, u)) {
    const c = tacticalCost(s, u, foe, o);
    if (c < bestCost) {
      bestCost = c;
      best = o;
    }
  }
  return best;
}

/** 往 want 轉一面的方向：+1 右轉、−1 左轉（走近的那邊）。 */
function turnToward(facing: Dir, want: Dir): 1 | -1 {
  return turnSteps(rotate(facing, 1), want) < turnSteps(facing, want) ? 1 : -1;
}

/**
 * 行動階段的下一個指令（一次一個；引擎一直問到它待機或階段結束）。
 * 只做不透支的事 —— 裝填除外：配額 1 的機體裝填一定透支，不允許就永遠裝不了。
 */
export function duelAction(s: GameState, u: Unit): Command {
  const WAIT: Command = { type: 'WAIT' };
  const foe = foeOf(s, u);
  const free = (cmd: Command): boolean => {
    const l = checkLegal(s, cmd);
    return l.ok && l.overdraft === 0;
  };
  let paidTurn: Command | null = null;
  if (foe) {
    const chk = shotCheck(s, u, foe);
    const fire: Command = { type: 'FIRE', targetId: foe.id };
    if (chk.ok && chk.chance >= AI_FIRE_THRESHOLD && free(fire)) return fire;
    // 不在射界內：免費的轉向馬上轉（轉完也許就打得到）；要花 AP 的留到最後 —— 這回合反正打不到了才轉
    if (!chk.ok && chk.reason?.startsWith('不在射界內')) {
      const turn: Command = { type: 'TURN', delta: turnToward(u.facing, dirToward(u.pos, foe.pos, u.facing)) };
      if (free(turn)) {
        if (turnPrice(s.rules, u).ap === 0) return turn;
        paidTurn = turn;
      }
    }
    if (u.ammo === 0 && checkLegal(s, { type: 'RELOAD' }).ok) return { type: 'RELOAD' };
  }
  if (isHot(s.rules, u) && free({ type: 'COOL' })) return { type: 'COOL' };
  return paidTurn ?? WAIT;
}
