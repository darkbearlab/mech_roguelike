/**
 * 射擊的演出：曳光與飄字。**純呈現** —— 時長設 0 就什麼都不播，最終狀態完全一樣。
 *
 * 每一筆都有自己的開始時間：同一批事件裡「先開槍、目標再移動」時，
 * 介面把目標的位移排在曳光之後，畫面才看得出先後。
 */
import type { Hex } from '../core/hex';

export interface Tracer {
  from: Hex;
  to: Hex;
  hit: boolean;
  start: number;
  dur: number;
}

export interface Floater {
  at: Hex;
  text: string;
  color: string;
  start: number;
  dur: number;
}

export class Effects {
  tracers: Tracer[] = [];
  floaters: Floater[] = [];

  shot(from: Hex, to: Hex, hit: boolean, start: number, dur: number): void {
    if (dur > 0) this.tracers.push({ from, to, hit, start, dur });
  }

  float(at: Hex, text: string, color: string, start: number, dur: number): void {
    if (dur > 0) this.floaters.push({ at, text, color, start, dur });
  }

  /** 還有東西要播（含還沒開始的）。順便丟掉播完的。 */
  active(now: number): boolean {
    this.tracers = this.tracers.filter((t) => now - t.start < t.dur);
    this.floaters = this.floaters.filter((f) => now - f.start < f.dur);
    return this.tracers.length > 0 || this.floaters.length > 0;
  }

  clear(): void {
    this.tracers = [];
    this.floaters = [];
  }
}
