/**
 * 決鬥：自動駕駛開玩家那台，用的是跟敵機**同一顆腦袋**（core/ai.ts），但一律透過 applyCommand 送指令 ——
 * 能做的事跟玩家在觸控盤上能做的完全相同。兩邊對稱，勝率反映的是機體相剋與先後手，不是 AI 的差距。
 *
 * 順便數玩家「按了幾下」：左盤轉幾面 + 點幾下 + 確認 1 下 + 右盤每個行動 1 下（待機也算）——
 * 操作繁瑣的程度要有數字，之後設計儀式感時才有東西可以對。
 */
import { duelAction, duelDeclare } from '../src/core/ai';
import { applyCommand, newGame } from '../src/core/engine';
import type { GameMap } from '../src/core/map';
import { duelists, withUnitChassis } from '../src/core/map';
import type { Rules } from '../src/core/rules';
import type { Command, GameState } from '../src/core/state';
import { currentStep, unitById } from '../src/core/state';

export interface DuelResult {
  chassis: string;
  rival: string;
  winner: 'PLAYER' | 'ENEMY' | 'DRAW';
  /** 分出勝負的回合；到上限還沒分出來 = 上限（DRAW）。 */
  turns: number;
  shots: number;
  hits: number;
  enemyShots: number;
  enemyHits: number;
  hpLeft: number;
  rivalHpLeft: number;
  /** 玩家總共按了幾下。 */
  inputs: number;
}

export function runDuel(rules: Rules, map: GameMap, chassis: string, rival: string, seed = 1, maxTurns = 60): DuelResult {
  const id = duelists(map)[0];
  if (!id) throw new Error(`地圖 ${map.id} 沒有敵機`);
  let s: GameState = newGame(rules, withUnitChassis(rules, map, id, rival), { seed, player: { chassis } });
  let inputs = 0;
  const send = (cmd: Command): void => {
    const r = applyCommand(s, cmd);
    if (r.state === s) throw new Error('自動駕駛送出了非法指令：' + JSON.stringify(cmd));
    s = r.state;
  };
  while (!s.over && s.round <= maxTurns) {
    const me = unitById(s, 'player')!;
    if (currentStep(s)!.kind === 'DECLARE') {
      // 左盤：轉幾面就按幾下、點幾下、再確認
      const d = duelDeclare(s, me);
      inputs += Math.abs(d.turn) + (d.order?.taps ?? 0) + 1;
      send({ type: 'ACCEL', order: d.order, turn: d.turn });
    } else {
      inputs++;
      send(duelAction(s, me));
    }
  }
  const winner = s.over?.winner === 'PLAYER' ? 'PLAYER' : s.over?.winner === 'ENEMY' ? 'ENEMY' : 'DRAW';
  return {
    chassis,
    rival,
    winner,
    turns: winner === 'DRAW' ? maxTurns : s.round,
    shots: s.stats.shots,
    hits: s.stats.hits,
    enemyShots: s.stats.enemyShots,
    enemyHits: s.stats.enemyHits,
    hpLeft: unitById(s, 'player')!.hp,
    rivalHpLeft: unitById(s, id)!.hp,
    inputs,
  };
}
