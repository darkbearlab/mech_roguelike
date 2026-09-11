/**
 * 自動單位的腳本：引擎在它們的階段直接照這裡走完，不等輸入。
 *
 * 靶（固定靶、巡邏的靶機）在這裡；敵機（DUEL）的腦袋在 ai.ts。
 * 規劃移動用的都是 nav.ts 的 planAccel，跟玩家、bot 共用同一套移動規則，不走捷徑。
 */
import { duelDeclare } from './ai';
import type { Declaration } from './ai';
import { planTurn } from './engine';
import { dirToward, hexDist, turnDelta } from './hex';
import { planAccel } from './nav';
import type { GameState, Unit } from './state';

/** 巡邏的目前目標；到了（1 格內）就換下一個。會就地更新腳本的 next。 */
function patrolGoal(u: Unit): Unit['pos'] | null {
  const sc = u.script;
  if (!sc || sc.kind !== 'PATROL' || sc.points.length === 0) return null;
  if (hexDist(u.pos, sc.points[sc.next]) <= 1) sc.next = (sc.next + 1) % sc.points.length;
  return sc.points[sc.next];
}

/** 這個自動單位現在是不是在打仗：敵機，或已經醒了的守衛。 */
export function hunting(u: Unit): boolean {
  return u.script?.kind === 'DUEL' || (u.script?.kind === 'GUARD' && u.script.awake);
}

/** 機動宣告：敵機照 AI；巡邏的先把機首轉向目標（靶機轉向免費），再往目標開；其餘（含還沒醒的守衛）不動。 */
export function scriptDeclare(s: GameState, u: Unit): Declaration {
  if (hunting(u)) return duelDeclare(s, u);
  const goal = patrolGoal(u);
  if (!goal || u.shutdown > 0) return { turn: 0, order: null };
  const want = turnDelta(u.facing, dirToward(u.pos, goal, u.facing));
  const plan = planTurn(s.rules, u, want);
  // 付不起就不轉（plan.unit 是原本的自己）
  return { turn: plan.ok ? want : 0, order: planAccel(s, u.id, goal, { depth: 2, stop: false, unit: plan.unit }) };
}
