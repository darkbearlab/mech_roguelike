/**
 * 解算順序（§5、§11.1）：一回合要怎麼拆成步驟。
 *
 * v0.1 只有循序制。同時移動（全員先宣告、再一起解算）是待決問題，
 * 所以把「步驟表長什麼樣」抽成這個介面 —— 換解算順序就是換一個 ResolutionOrder，
 * engine.ts 不需要知道現在是哪一種。
 *
 * 同時制大致會長這樣：全部 DECLARE → 一個 MOVE 列出所有單位 → 全部 ACT → WORLD。
 * 屆時要補的是「多個單位同一步位移時怎麼互撞」，那是 movement.ts 的事，不是這裡的事。
 */
import type { Step, Unit } from './state';

export interface ResolutionOrder {
  id: string;
  name: string;
  /** 這一回合的步驟表。units 的順序就是行動順序（玩家永遠在第一個）。 */
  schedule(units: readonly Unit[]): Step[];
}

/**
 * 循序制（§5）：每個單位在自己的階段內立即解算位移，不延到回合末 ——
 * 玩家要能看見自己這一步跑到哪裡，再決定開不開火。
 */
export const SEQUENTIAL: ResolutionOrder = {
  id: 'SEQUENTIAL',
  name: '循序',
  schedule(units) {
    const steps: Step[] = [];
    for (const u of units) {
      if (!u.alive) continue;
      steps.push({ kind: 'DECLARE', unitId: u.id });
      steps.push({ kind: 'MOVE', unitIds: [u.id] });
      steps.push({ kind: 'ACT', unitId: u.id });
    }
    steps.push({ kind: 'WORLD' });
    return steps;
  },
};

export const ORDERS: Record<string, ResolutionOrder> = { SEQUENTIAL };
