/**
 * 六角座標（§2）。flat-top（平頂）、axial (q, r)。
 *
 * **全專案只有這一把尺**：移動、射程、感測、視線一律用 hexLen / hexDist。
 * 不要在任何地方另外算歐氏距離做遊戲判定 —— 歐氏距離只准出現在 render/ 的像素換算。
 *
 * core/ 內不得 import 任何 DOM / Canvas / 瀏覽器 API。
 */

/** 整數格。 */
export interface Hex {
  q: number;
  r: number;
}

/** 以 1/SUB 格為單位的整數向量：位置（posSub）或速度（velSub）。 */
export interface SubVec {
  q: number;
  r: number;
}

/** 次格精度（§2）：位置與速度一律存成 1/10 格的整數，避免浮點誤差。 */
export const SUB = 10;

/** 方向編號 0..5 = N, NE, SE, S, SW, NW（§2）。 */
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
export function vec(q: number, r: number): SubVec {
  return { q: q + 0, r: r + 0 };
}

export function add(a: SubVec, b: SubVec): SubVec {
  return vec(a.q + b.q, a.r + b.r);
}

export function sub(a: SubVec, b: SubVec): SubVec {
  return vec(a.q - b.q, a.r - b.r);
}

export function scale(a: SubVec, k: number): SubVec {
  return vec(a.q * k, a.r * k);
}

export function sameHex(a: Hex, b: Hex): boolean {
  return a.q === b.q && a.r === b.r;
}

/**
 * 向量長度（cube 距離，§2）：(|q| + |q+r| + |r|) / 2。
 * 對整數向量結果必為整數（cube 座標三軸絕對值和恆為偶數）。
 * 格與 sub 都用它 —— 速度的「長度」、阻力的「減少 drag」、上限的「夾在 maxSpeed」
 * 全部是這把尺量的。
 */
export function hexLen(v: SubVec): number {
  return (Math.abs(v.q) + Math.abs(v.q + v.r) + Math.abs(v.r)) / 2;
}

export function hexDist(a: Hex, b: Hex): number {
  return hexLen(sub(a, b));
}

/** cube rounding：把小數 axial 座標歸到最近的整數格。 */
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

/** 佔格（§2）：`round(posSub / SUB)`。所有遊戲判定都用這一格。 */
export function subToHex(p: SubVec): Hex {
  return hexRound(p.q / SUB, p.r / SUB);
}

/** 格中心的次格座標。 */
export function hexToSub(h: Hex): SubVec {
  return vec(h.q * SUB, h.r * SUB);
}

/**
 * 六角直線（含兩端）。§3.1 第 6 步的逐格判定、動畫路徑、以及第 3 步的視線都走這條。
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

/**
 * 前方三面（§3.3）：朝向本身與左右各一面。
 * 決定地面驅動能往哪加速（§3.2 側向加速），第 3 步起也決定武器射界。
 */
export function inFrontArc(facing: Dir, d: Dir): boolean {
  return turnSteps(facing, d) <= 1;
}

/**
 * 從 from 看 to 最接近哪一個方向。以「往那個方向走一步後離 to 最近」判定 ——
 * 同一把尺，不另外算角度。平手時偏好 prefer（通常是目前朝向，避免 AI 無謂地轉來轉去），
 * 再來依方向編號。from 與 to 同格時回傳 prefer。
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
