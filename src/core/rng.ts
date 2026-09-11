/**
 * 可播種亂數（xoshiro128**），沿用 PMC 的實作。
 *
 * 硬性規則（§1）：
 *  - 全專案禁止直接呼叫 Math.random()。所有亂數都必須經過這裡。
 *  - 產生器的完整內部狀態存在 GameState 裡，JSON 序列化 → 還原後可以接著抽出同一串。
 *
 * nextFloat() 會就地修改傳入的 RngState。這在 core 裡是安全的：
 * applyCommand() 一律先複製 GameState，再對複製品操作（見 engine.ts）。
 */

export interface RngState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
  /** 已抽取次數。純除錯／驗證用，不影響輸出。 */
  count: number;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** splitmix32：把單一 seed 擴展成 4 個狀態字。 */
export function createRng(seed: number): RngState {
  let x = seed >>> 0;
  const mix = (): number => {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
  return { s0: mix(), s1: mix(), s2: mix(), s3: mix(), count: 0 };
}

/** 抽出下一個 [0, 1) 的浮點數，並推進狀態。 */
export function nextFloat(r: RngState): number {
  const result = Math.imul(rotl(Math.imul(r.s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (r.s1 << 9) >>> 0;

  r.s2 = (r.s2 ^ r.s0) >>> 0;
  r.s3 = (r.s3 ^ r.s1) >>> 0;
  r.s1 = (r.s1 ^ r.s2) >>> 0;
  r.s0 = (r.s0 ^ r.s3) >>> 0;
  r.s2 = (r.s2 ^ t) >>> 0;
  r.s3 = rotl(r.s3, 11);
  r.count++;

  return result / 4294967296;
}

/** [0, n) 的整數。 */
export function nextInt(r: RngState, n: number): number {
  return Math.floor(nextFloat(r) * n);
}
