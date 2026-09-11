/**
 * 六角格的像素幾何（flat-top）。**只有 render/ 與 ui/ 可以用** ——
 * 這裡的歐氏座標純粹是畫圖用的，遊戲判定一律回 core/hex.ts 用 cube 距離。
 *
 * 「世界座標」以六角半徑 = 1 為單位；乘上 Camera.size 就是 CSS 像素。
 */
import type { Dir, SubVec } from '../core/hex';
import { DIR_VEC, SUB } from '../core/hex';

export const SQRT3 = Math.sqrt(3);

export interface Pt {
  x: number;
  y: number;
}

/** axial（可為小數）→ 世界座標。 */
export function axialToWorld(q: number, r: number): Pt {
  return { x: 1.5 * q, y: SQRT3 * (r + q / 2) };
}

/** 世界座標 → axial（小數；要格子就再 hexRound）。 */
export function worldToAxial(x: number, y: number): { q: number; r: number } {
  const q = x / 1.5;
  return { q, r: y / SQRT3 - q / 2 };
}

export function subToWorld(p: SubVec): Pt {
  return axialToWorld(p.q / SUB, p.r / SUB);
}

/** 方向 d 在畫面上的角度（弧度，0 = 向右、順時針為正；N = −90°）。 */
export function dirAngle(d: Dir): number {
  const w = axialToWorld(DIR_VEC[d].q, DIR_VEC[d].r);
  return Math.atan2(w.y, w.x);
}

/** 速度向量在畫面上的角度；零向量回傳 null。 */
export function vecAngle(v: SubVec): number | null {
  if (v.q === 0 && v.r === 0) return null;
  const w = subToWorld(v);
  return Math.atan2(w.y, w.x);
}

/** 平頂六角形的六個頂點（以 cx, cy 為中心、半徑 size）。 */
export function hexCorners(cx: number, cy: number, size: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    out.push({ x: cx + size * Math.cos(a), y: cy + size * Math.sin(a) });
  }
  return out;
}

/** 方向箭頭字元，依方向編號。 */
export const DIR_GLYPH = ['↑', '↗', '↘', '↓', '↙', '↖'] as const;
