/**
 * 位移與轉向的演出。**純呈現**：規則層早就把位置算完了，這裡只是讓畫面慢一點追上去。
 * 任何一個時長設為 0，畫面立即等於最終狀態（ui.json 的原則）。
 *
 * 位移動畫走的是起點到終點的直線 —— 那正是 §3.1 第 6 步逐格判定的那條六角直線的連續版本。
 */
import type { SubVec } from '../core/hex';

interface MoveTween {
  from: SubVec;
  to: SubVec;
  start: number;
  dur: number;
  /** 撞擊：到達時抖一下。 */
  bump: boolean;
}

interface TurnTween {
  from: number;
  to: number;
  start: number;
  dur: number;
}

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

export class Motion {
  private moves = new Map<string, MoveTween>();
  private turns = new Map<string, TurnTween>();

  move(id: string, from: SubVec, to: SubVec, now: number, dur: number, bump: boolean): void {
    if (dur <= 0) {
      this.moves.delete(id);
      return;
    }
    this.moves.set(id, { from, to, start: now, dur, bump });
  }

  /** 轉向動畫。角度用弧度；自動走最短的那一邊。 */
  turn(id: string, fromAngle: number, toAngle: number, now: number, dur: number): void {
    if (dur <= 0) {
      this.turns.delete(id);
      return;
    }
    let d = toAngle - fromAngle;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    this.turns.set(id, { from: fromAngle, to: fromAngle + d, start: now, dur });
  }

  /** 動畫中的位置（次格座標，可為小數）。 */
  posOf(id: string, fallback: SubVec, now: number): SubVec {
    const m = this.moves.get(id);
    if (!m) return fallback;
    const t = Math.min(1, (now - m.start) / m.dur);
    if (t >= 1) {
      this.moves.delete(id);
      return fallback;
    }
    const e = easeOut(t);
    let q = m.from.q + (m.to.q - m.from.q) * e;
    let r = m.from.r + (m.to.r - m.from.r) * e;
    if (m.bump && t > 0.8) {
      // 最後 20% 沿反方向彈一下，讓「撞上」看得出來
      const k = Math.sin(((t - 0.8) / 0.2) * Math.PI) * 0.08;
      q -= (m.to.q - m.from.q) * k;
      r -= (m.to.r - m.from.r) * k;
    }
    return { q, r };
  }

  angleOf(id: string, fallback: number, now: number): number {
    const tw = this.turns.get(id);
    if (!tw) return fallback;
    const t = Math.min(1, (now - tw.start) / tw.dur);
    if (t >= 1) {
      this.turns.delete(id);
      return fallback;
    }
    return tw.from + (tw.to - tw.from) * easeOut(t);
  }

  active(now: number): boolean {
    for (const m of this.moves.values()) if (now - m.start < m.dur) return true;
    for (const t of this.turns.values()) if (now - t.start < t.dur) return true;
    return false;
  }

  /** 立刻跳到終點（新指令進來時，不讓畫面落後兩步）。 */
  finish(): void {
    this.moves.clear();
    this.turns.clear();
  }
}
