/**
 * 敵機 AI（決鬥用）。
 *
 * 跟玩家、bot 用**同一套規則**：機動宣告（轉向＋加速）只挑合法的、用 resolveMotion 推演（nav.ts 也是）；
 * 行動送的是和玩家一樣的指令，由引擎照同一段 checkLegal / 效果程式碼結算 —— 敵人沒有捷徑。
 *
 * 機動宣告（轉向在移動之前決定，右盤不再轉向）：
 *   - 還遠：機首轉向要去的地方（付得起的面數），用 nav.planAccel 往對手身邊的有利射程開
 *   - 近了：每個付得起的轉向 × 每個合法的加速都推演一回合，挑分數最低的 ——
 *     移動完對手在射界內（開火時機首已經定了）＞ 距離落在有利射程 ＞ 自己打得準、對方打不準
 *     （對方在我之後宣告，看得到我停在哪 —— 假設它會轉過來面向我；位置用它現在的估）
 * 行動：打得中（≥ 門檻）就打；打光了裝填；太熱散熱；其餘待機。
 *
 * bot 的決鬥也用這一顆腦袋開玩家那台，所以兩邊是對稱的：勝率反映的是機體與先後手，不是 AI 的差距。
 */
import { shotCheck, weaponOf } from './combat';
import { isHot } from './economy';
import { checkLegal, planTurn } from './engine';
import type { Hex } from './hex';
import { DIR_VEC, add, dirToward, hexDist, offAxisDegrees, rotate, scale, turnDelta } from './hex';
import { cellAt } from './map';
import { allOrders, resolveMotion, worldOf } from './movement';
import { planAccel } from './nav';
import type { AccelOrder, Command, GameState, Unit } from './state';

/** 命中率至少這麼高才開槍（點數）。 */
export const AI_FIRE_THRESHOLD = 25;

/** 近戰評分的權重（以「差幾格」為單位）。 */
const COST = {
  /** 移動完對手不在射界內（或打不到、或 AP 已經花在轉向上）。 */
  noShot: 3,
  /** 自己的命中率每少 25 點 / 對方的命中率每多 25 點。 */
  per25: 1,
  collision: 12,
  heat: 0.01,
  /** 每轉一面（同分時偏好少轉）。 */
  face: 0.05,
  /** 對手偏離機首 180° 時的扣分（按比例）：這回合反正打不到時，也先把機首擺向對手，下一回合才有得打。 */
  aim: 0.5,
} as const;

/** 離有利射程還差這麼多格以上，就先用導航靠近。 */
const APPROACH_MARGIN = 3;

/** 機動宣告：先轉 turn 面，再加速。 */
export interface Declaration {
  turn: number;
  order: AccelOrder;
}

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
    if (cellAt(s.map, g)?.passable) return g;
  }
  return foe.pos;
}

/** 往 want 那邊轉，付得起幾面就轉幾面（從想要的面數往下試）。 */
export function affordableTurn(s: GameState, u: Unit, want: number): number {
  for (let k = want; k !== 0; k -= Math.sign(k)) if (planTurn(s.rules, u, k).ok) return k;
  return 0;
}

/** 機動宣告。沒有對手就不動（照樣衰減）。 */
export function duelDeclare(s: GameState, u: Unit): Declaration {
  const foe = foeOf(s, u);
  if (!foe) return { turn: 0, order: null };
  if (hexDist(u.pos, foe.pos) > preferredRange(s, u) + APPROACH_MARGIN) {
    const goal = duelGoal(s, u, foe);
    const turn = affordableTurn(s, u, turnDelta(u.facing, dirToward(u.pos, goal, u.facing)));
    const t = planTurn(s.rules, u, turn).unit;
    return { turn, order: planAccel(s, u.id, goal, { depth: 2, stop: false, unit: t }) };
  }
  let best: Declaration = { turn: 0, order: null };
  let bestCost = Infinity;
  for (const turn of [0, 1, -1, 2, -2, 3]) {
    const plan = planTurn(s.rules, u, turn);
    if (!plan.ok) continue;
    for (const o of allOrders(s.rules, plan.unit)) {
      const c = tacticalCost(s, plan.unit, foe, o) + Math.abs(turn) * COST.face;
      if (c < bestCost) {
        bestCost = c;
        best = { turn, order: o };
      }
    }
  }
  return best;
}

/** 對手下一個階段開始時的樣子（AP 照配額補回來、還沒轉過向）。 */
function nextPhase(s: GameState, foe: Unit): Unit {
  const quota = s.rules.chassis[foe.chassis].apQuota;
  return { ...foe, ap: quota - Math.min(foe.debt, quota), facesTurned: 0 };
}

/**
 * 這樣加速之後的局面分數（越低越好）。u 是已經轉過向的自己（機首到開火為止都不會再變）。
 * 對手的反擊：它在我之後宣告，看得到我停在哪 —— 假設它把機首轉向我（付得起的面數）。
 */
export function tacticalCost(s: GameState, u: Unit, foe: Unit, order: AccelOrder): number {
  const r = resolveMotion(worldOf(s, u.id), u, order);
  const me: Unit = { ...u, pos: r.pos, heading: r.heading, speed: r.speed };
  let cost = Math.abs(hexDist(r.pos, foe.pos) - preferredRange(s, u));
  if (r.collision) cost += COST.collision;
  cost += r.heat * COST.heat;
  const w = weaponOf(s.rules, u);
  const mine = shotCheck(s, me, foe);
  const canPay = !!w && u.ap >= w.fire.ap;
  cost += mine.ok && canPay ? ((100 - mine.chance) / 25) * COST.per25 : COST.noShot;
  cost += (offAxisDegrees(me.pos, me.facing, foe.pos) / 180) * COST.aim;
  const f = nextPhase(s, foe);
  const aimed = planTurn(s.rules, f, affordableTurn(s, f, turnDelta(f.facing, dirToward(f.pos, me.pos, f.facing)))).unit;
  const theirs = shotCheck(s, aimed, me);
  if (theirs.ok) cost += (theirs.chance / 25) * COST.per25;
  return cost;
}

/**
 * 行動階段的下一個指令（一次一個；引擎一直問到它待機或階段結束）。轉向已經在機動宣告裡做了。
 * 只做不透支的事 —— 裝填除外：配額 1 的機體裝填一定透支，不允許就永遠裝不了。
 */
export function duelAction(s: GameState, u: Unit): Command {
  const foe = foeOf(s, u);
  const free = (cmd: Command): boolean => {
    const l = checkLegal(s, cmd);
    return l.ok && l.overdraft === 0;
  };
  if (foe) {
    const chk = shotCheck(s, u, foe);
    const fire: Command = { type: 'FIRE', targetId: foe.id };
    if (chk.ok && chk.chance >= AI_FIRE_THRESHOLD && free(fire)) return fire;
    if (u.ammo === 0 && checkLegal(s, { type: 'RELOAD' }).ok) return { type: 'RELOAD' };
  }
  if (isHot(s.rules, u) && free({ type: 'COOL' })) return { type: 'COOL' };
  return { type: 'WAIT' };
}
