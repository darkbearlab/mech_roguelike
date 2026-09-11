/**
 * 位移與轉向的演出。**純呈現**：規則層早就把位置算完了，這裡只是讓畫面慢一點追上去。
 * 任何一個時長設為 0，畫面立即等於最終狀態（ui.json 的原則）。
 * 開始時間可以在未來（排在別的演出之後）：輪到之前停在起點。
 *
 * 位移沿速度方向筆直走，起點到終點的直線剛好穿過沿途每一格的中心 ——
 * 所以動畫就是「一格一格走過去」。
 */

/** axial 座標；動畫中途可以是小數。 */
export interface AxialPt {
  q: number;
  r: number;
}

interface MoveTween {
  from: AxialPt;
  to: AxialPt;
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

/** 等速：一格一格走，每一格花的時間一樣（看得出速度是幾）。 */
const linear = (t: number): number => t;
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

export class Motion {
  private moves = new Map<string, MoveTween>();
  private turns = new Map<string, TurnTween>();

  move(id: string, from: AxialPt, to: AxialPt, now: number, dur: number, bump: boolean): void {
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

  /** 動畫中的位置（axial，可為小數）。 */
  posOf(id: string, fallback: AxialPt, now: number): AxialPt {
    const m = this.moves.get(id);
    if (!m) return fallback;
    // 還沒輪到它（排在曳光之後）：停在起點
    const t = Math.max(0, Math.min(1, (now - m.start) / m.dur));
    if (t >= 1) {
      this.moves.delete(id);
      return fallback;
    }
    const e = linear(t);
    let q = m.from.q + (m.to.q - m.from.q) * e;
    let r = m.from.r + (m.to.r - m.from.r) * e;
    if (m.bump && t > 0.85) {
      // 最後一段沿反方向彈一下，讓「撞上」看得出來
      const k = Math.sin(((t - 0.85) / 0.15) * Math.PI) * 0.15;
      const len = Math.max(1, Math.abs(m.to.q - m.from.q) + Math.abs(m.to.r - m.from.r));
      q -= ((m.to.q - m.from.q) / len) * k;
      r -= ((m.to.r - m.from.r) / len) * k;
    }
    return { q, r };
  }

  angleOf(id: string, fallback: number, now: number): number {
    const tw = this.turns.get(id);
    if (!tw) return fallback;
    const t = Math.max(0, Math.min(1, (now - tw.start) / tw.dur));
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
