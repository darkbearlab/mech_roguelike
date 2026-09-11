/**
 * 自動單位的腳本：引擎在它們的階段直接照這裡走完，不等輸入。
 *
 * 靶（固定靶、巡邏的靶機）在這裡；敵機（DUEL）的腦袋在 ai.ts。
 * 規劃移動用的都是 nav.ts 的 planAccel，跟玩家、bot 共用同一套移動規則，不走捷徑。
 */
import { duelAccel } from './ai';
import { dirToward, hexDist } from './hex';
import type { Dir } from './hex';
import { planAccel } from './nav';
import type { AccelOrder, GameState, Unit } from './state';

/** 巡邏的目前目標；到了（1 格內）就換下一個。會就地更新腳本的 next。 */
function patrolGoal(u: Unit): Unit['pos'] | null {
  const sc = u.script;
  if (!sc || sc.kind !== 'PATROL' || sc.points.length === 0) return null;
  if (hexDist(u.pos, sc.points[sc.next]) <= 1) sc.next = (sc.next + 1) % sc.points.length;
  return sc.points[sc.next];
}

/** 加速宣告。 */
export function scriptAccel(s: GameState, u: Unit): AccelOrder {
  if (u.script?.kind === 'DUEL') return duelAccel(s, u);
  const goal = patrolGoal(u);
  if (!goal || u.shutdown > 0) return null;
  return planAccel(s, u.id, goal, { depth: 2, stop: false });
}

/** 行動階段：巡邏的把機首轉向目標（靶機轉向免費）。回傳新的機首；不轉回傳 null。 */
export function scriptFacing(u: Unit): Dir | null {
  const goal = patrolGoal(u);
  if (!goal) return null;
  const want = dirToward(u.pos, goal, u.facing);
  return want === u.facing ? null : want;
}
