/**
 * 六角座標。flat-top（平頂）、axial (q, r)。
 *
 * **位置永遠是整數格**：機體只會站在格子中心，不存在「兩格之間」。
 * （v0.1 初版規格的 1/10 格次格精度已作廢 —— 那會讓機體停在格子之間，見 docs/design.md。）
 *
 * **全專案只有這一把尺**：移動、射程、感測、視線一律用 hexDist。
 * 歐氏距離只准出現在 render/ 的像素換算。
 *
 * core/ 內不得 import 任何 DOM / Canvas / 瀏覽器 API。
 */

/** 整數格（也用來表示格與格之間的位移）。 */
export interface Hex {
  q: number;
  r: number;
}

/** 方向編號 0..5 = N, NE, SE, S, SW, NW。 */
export type Dir = 0 | 1 | 2 | 3 | 4 | 5;

export const DIRS: readonly Dir[] = [0, 1, 2, 3, 4, 5];

export const DIR_VEC: readonly Hex[] = [
  { q: 0, r: -1 },   // 0 N
  { q: 1, r: -1 },   // 1 NE
  { q: 1, r: 0 },    // 2 SE
  { q: 0, r: 1 },    // 3 S
  { q: -1, r: 1 },   // 4 SW
  { q: -1, r: 0 },   // 5 NW
];

export const DIR_NAME = ['N', 'NE', 'SE', 'S', 'SW', 'NW'] as const;

/** 把 -0 正規化成 0。JSON 與 === 都分不出來，但 Object.is 與快照測試分得出來。 */
export function vec(q: number, r: number): Hex {
  return { q: q + 0, r: r + 0 };
}

export function add(a: Hex, b: Hex): Hex {
  return vec(a.q + b.q, a.r + b.r);
}

export function sub(a: Hex, b: Hex): Hex {
  return vec(a.q - b.q, a.r - b.r);
}

export function scale(a: Hex, k: number): Hex {
  return vec(a.q * k, a.r * k);
}

export function sameHex(a: Hex, b: Hex): boolean {
  return a.q === b.q && a.r === b.r;
}

/** 位移的長度（cube 距離）：(|q| + |q+r| + |r|) / 2。 */
export function hexLen(v: Hex): number {
  return (Math.abs(v.q) + Math.abs(v.q + v.r) + Math.abs(v.r)) / 2;
}

export function hexDist(a: Hex, b: Hex): number {
  return hexLen(sub(a, b));
}

/** cube rounding：把小數 axial 座標歸到最近的整數格（直線取樣、點地圖選格用）。 */
export function hexRound(fq: number, fr: number): Hex {
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return vec(q, r);
}

/**
 * 六角直線（含兩端）。第 3 步的視線與日後的射線判定走這條。
 * （移動不需要它：速度方向永遠是六個正方向之一，路徑就是一直線的格子。）
 *
 * 兩端點加上同一個微小偏移，避免直線剛好擦過兩格交界時的平手 ——
 * 偏移方向固定，所以同一組端點永遠得到同一條線（bot 對局可重現）。
 */
export function hexLine(a: Hex, b: Hex): Hex[] {
  const n = hexDist(a, b);
  if (n === 0) return [vec(a.q, a.r)];
  const EQ = 1e-6;
  const ER = 2e-6;
  const out: Hex[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(hexRound(a.q + EQ + (b.q - a.q) * t, a.r + ER + (b.r - a.r) * t));
  }
  return out;
}

export function neighbor(h: Hex, d: Dir): Hex {
  return add(h, DIR_VEC[d]);
}

/** 方向旋轉 k 面（正 = 順時針）。 */
export function rotate(d: Dir, k: number): Dir {
  return ((((d + k) % 6) + 6) % 6) as Dir;
}

/** 從 a 轉到 b 最少要轉幾面（0..3）。 */
export function turnSteps(a: Dir, b: Dir): number {
  const cw = (((b - a) % 6) + 6) % 6;
  return Math.min(cw, 6 - cw);
}

/** b 相對於 a 順時針差幾面（0..5）。 */
export function relDir(a: Dir, b: Dir): Dir {
  return ((((b - a) % 6) + 6) % 6) as Dir;
}

/** 從 a 轉到 b 走近的那一邊：正 = 右轉幾面、負 = 左轉幾面（−2..3；正後方算右轉 3 面）。 */
export function turnDelta(a: Dir, b: Dir): number {
  const cw = relDir(a, b);
  return cw <= 3 ? cw : cw - 6;
}

/** 前方三面：朝向本身與左右各一面。 */
export function inFrontArc(facing: Dir, d: Dir): boolean {
  return turnSteps(facing, d) <= 1;
}

/**
 * 平面座標（flat-top，六角半徑 = 1）。**只拿來算角度**（射界），不拿來量距離 ——
 * 距離一律用 hexDist。render/ 的像素換算用的是同一條公式。
 */
export function cartesian(h: Hex): { x: number; y: number } {
  return { x: 1.5 * h.q, y: Math.sqrt(3) * (h.r + h.q / 2) };
}

/**
 * 從 from 看 to，偏離方向 facing 幾度（0..180）。射界判定與「角度影響命中」用。
 * from 與 to 同格回傳 0。
 */
export function offAxisDegrees(from: Hex, facing: Dir, to: Hex): number {
  const d = cartesian(sub(to, from));
  if (d.x === 0 && d.y === 0) return 0;
  const f = cartesian(DIR_VEC[facing]);
  const cos = (d.x * f.x + d.y * f.y) / (Math.hypot(d.x, d.y) * Math.hypot(f.x, f.y));
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/**
 * 從 from 看 to 最接近哪一個方向。以「往那個方向走一步後離 to 最近」判定 ——
 * 同一把尺，不另外算角度。平手時偏好 prefer，再來依方向編號。from 與 to 同格時回傳 prefer。
 */
export function dirToward(from: Hex, to: Hex, prefer: Dir = 0): Dir {
  if (sameHex(from, to)) return prefer;
  let best: Dir = prefer;
  let bestDist = hexDist(neighbor(from, prefer), to);
  for (const d of DIRS) {
    const dist = hexDist(neighbor(from, d), to);
    if (dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}
