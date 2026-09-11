/**
 * 行動點與熱量（§4）。
 *
 * 行動點是節拍器，熱量才是貨幣。這裡只放兩者的帳務規則；
 * 「什麼時候付、付給誰」由 engine.ts 決定。
 *
 * 這些函式會就地修改傳入的 Unit —— 只能用在 applyCommand() 複製過的狀態上。
 */
import type { Rules } from './rules';
import type { Unit } from './state';

export interface ApCheck {
  ok: boolean;
  reason?: string;
  /** 這個行動會新增多少債務。 */
  overdraft: number;
}

/**
 * 階段開始時的配額（§4.1）：配額**先扣抵債務**，剩下的才是這個階段能用的 AP。
 * 在自己的階段開始時付、而不是回合開始時付 —— 這樣透支之後，
 * 整個敵人階段與世界階段都還背著債（不能散熱、命中率 −10%），脆弱視窗才看得見。
 */
export function payQuota(u: Unit, quota: number): void {
  const pay = Math.min(u.debt, quota);
  u.debt -= pay;
  u.ap = quota - pay;
}

/**
 * 能不能付這筆 AP（§4.1）。
 *
 * - 成本 0 的事（免費轉向、待機）永遠可以做，就算還背著債
 * - 債務 > 0 時不能做任何要花 AP 的行動 —— 「還清前不能做新的行動」
 * - 成本超過手上的 AP 時允許透支，但新增的債務不得超過 apDebtCap
 */
export function checkAp(rules: Rules, u: Unit, cost: number): ApCheck {
  if (cost <= 0) return { ok: true, overdraft: 0 };
  if (u.debt > 0) return { ok: false, reason: '償還債務中：還清前不能行動', overdraft: 0 };
  const overdraft = Math.max(0, cost - u.ap);
  if (overdraft > rules.economy.apDebtCap) {
    return { ok: false, reason: `透支 ${overdraft} 超過上限 ${rules.economy.apDebtCap}`, overdraft };
  }
  return { ok: true, overdraft };
}

/** 付 AP：先用手上的，不夠的部分記成債務。呼叫前先 checkAp()。 */
export function spendAp(u: Unit, cost: number): void {
  const fromPool = Math.min(u.ap, cost);
  u.ap -= fromPool;
  u.debt += cost - fromPool;
}

/**
 * 加熱（或散熱，delta < 0），夾在 [0, heatCap]。
 *
 * @returns true = 這一下讓機體過熱（加熱且到達上限，而且原本沒有在停機）。
 *   已經在停機的機體再加熱不會重新觸發 —— 否則停機期間被打一下就永遠開不了機。
 */
export function addHeat(rules: Rules, u: Unit, delta: number): boolean {
  const cap = rules.chassis[u.chassis].heatCap;
  u.heat = Math.min(cap, Math.max(0, u.heat + delta));
  return delta > 0 && u.heat >= cap && u.shutdown === 0;
}

/** 世界階段的被動散熱（§4.2）。債務 > 0 時不散熱（§4.1）。 */
export function passiveCool(rules: Rules, u: Unit): void {
  if (u.debt > 0) return;
  u.heat = Math.max(0, u.heat - rules.chassis[u.chassis].heatPassive);
}

/** 熱量是否已進入命中懲罰區（§4.2：> 70%）。第 5 步的命中公式與介面的熱量條共用。 */
export function isHot(rules: Rules, u: Unit): boolean {
  return u.heat > rules.combat.heatPenaltyAbove * rules.chassis[u.chassis].heatCap;
}
