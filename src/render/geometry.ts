/**
 * 六角格的像素幾何（flat-top）。**只有 render/ 與 ui/ 可以用** ——
 * 這裡的歐氏座標純粹是畫圖用的，遊戲判定一律回 core/hex.ts 用 cube 距離。
 *
 * 「世界座標」以六角半徑 = 1 為單位；乘上 Camera.size 就是 CSS 像素。
 */
import type { Dir } from '../core/hex';
import { DIR_VEC } from '../core/hex';

export const SQRT3 = Math.sqrt(3);

export interface Pt {
  x: number;
  y: number;
}

/** axial → 世界座標。q、r 可以是小數（位移動畫的中途）。 */
export function axialToWorld(q: number, r: number): Pt {
  return { x: 1.5 * q, y: SQRT3 * (r + q / 2) };
}

/** 世界座標 → axial（小數；要格子就再 hexRound）。 */
export function worldToAxial(x: number, y: number): { q: number; r: number } {
  const q = x / 1.5;
  return { q, r: y / SQRT3 - q / 2 };
}

/** 方向 d 在畫面上的角度（弧度，0 = 向右、順時針為正；N = −90°）。 */
export function dirAngle(d: Dir): number {
  const w = axialToWorld(DIR_VEC[d].q, DIR_VEC[d].r);
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

/** 絕對方向的箭頭字元（地圖方位），依方向編號。 */
export const DIR_GLYPH = ['↑', '↗', '↘', '↓', '↙', '↖'] as const;

/** 相對機首的方向名稱（左盤跟著機首排），依相對編號 0..5。 */
export const REL_NAME = ['前', '右前', '右後', '後', '左後', '左前'] as const;
