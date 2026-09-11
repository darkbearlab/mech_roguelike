/**
 * 自動駕駛：替一台機體打完一整個回合（左盤加速 → 右盤行動 → 結束）。
 *
 * 只透過 core/ 的公開入口（planAccel / checkLegal / applyCommand）操作，
 * 所以它能做的事與玩家在觸控盤上能做的事完全相同 —— bot 的數字才能拿來跟人比。
 */
import { applyCommand, checkLegal } from '../src/core/engine';
import type { Hex } from '../src/core/hex';
import { dirToward, rotate, turnSteps } from '../src/core/hex';
import { isHot } from '../src/core/economy';
import { planAccel } from '../src/core/nav';
import type { Command, GameEvent, GameState } from '../src/core/state';
import { currentStep, unitById } from '../src/core/state';

export interface PilotTurn {
  state: GameState;
  events: GameEvent[];
  /** 位移之後就到了（不必再行動）。 */
  arrivedAfterMove: boolean;
  /** 這一回合中途的最高熱量（世界階段散熱之前）。 */
  heatPeak: number;
}

/**
 * @param isThere 位移之後判斷到了沒；到了就不再行動，直接回傳（呼叫端決定要不要結束回合）。
 */
export function pilotTurn(s0: GameState, unitId: string, goal: Hex, isThere: (s: GameState) => boolean): PilotTurn {
  const events: GameEvent[] = [];
  let heatPeak = unitById(s0, unitId)!.heat;
  const step = (st: GameState, cmd: Command): GameState => {
    const r = applyCommand(st, cmd);
    if (r.state === st) throw new Error('自動駕駛送出了非法指令：' + JSON.stringify(cmd));
    events.push(...r.events);
    // 結束階段會一路走過世界階段（被動散熱），所以只記加速與行動當下的熱量
    if (cmd.type !== 'WAIT') heatPeak = Math.max(heatPeak, unitById(r.state, unitId)!.heat);
    return r.state;
  };
  let s = step(s0, { type: 'ACCEL', order: planAccel(s0, unitId, goal) });
  if (isThere(s)) return { state: s, events, arrivedAfterMove: true, heatPeak };

  // 右盤：太熱就散熱；然後把機首轉向目標 —— 能點幾下是看機首的。
  // 只做不透支的事：透支的價值要到有敵人時才評估得出來。
  const acting = (): boolean => {
    const st = currentStep(s);
    return st?.kind === 'ACT' && st.unitId === unitId;
  };
  if (acting() && isHot(s.rules, unitById(s, unitId)!)) {
    const l = checkLegal(s, { type: 'COOL' });
    if (l.ok && l.overdraft === 0) s = step(s, { type: 'COOL' });
  }
  for (let guard = 0; guard < 3 && acting(); guard++) {
    const u = unitById(s, unitId)!;
    const want = dirToward(u.pos, goal, u.facing);
    if (want === u.facing) break;
    const delta: 1 | -1 = turnSteps(rotate(u.facing, 1), want) < turnSteps(u.facing, want) ? 1 : -1;
    const l = checkLegal(s, { type: 'TURN', delta });
    if (!l.ok || l.overdraft > 0) break;
    s = step(s, { type: 'TURN', delta });
  }
  if (acting()) s = step(s, { type: 'WAIT' });
  return { state: s, events, arrivedAfterMove: false, heatPeak };
}
