/**
 * 呈現層與介面的旋鈕。
 *
 * **這些值刻意不放在 core/ 讀的檔案裡。**規則層對「動畫要幾毫秒」沒有意見，也不能有意見 ——
 * 把任何一個值設為 0，最終狀態必須完全相同。
 */
import uiJson from '../data/ui.json';

/** 右盤（功能盤）的按鍵代號。 */
export type PadKey =
  | 'turnL' | 'turnR' | 'lock' | 'fire' | 'reload' | 'swap' | 'cool' | 'switchDrive' | 'wait';

/**
 * 座艙的資訊層：機型差異落在「能知道什麼」，不是「按鈕在哪」。
 * v0.1 全開；欄位清單本身是待決問題。
 */
export interface Readouts {
  /** NUMERIC = 熱量條與數值；LIGHT = 只有警告燈。 */
  heat: 'NUMERIC' | 'LIGHT';
  /** NUMERIC = 格/回合；BANDS = 靜止/慢/中/快。 */
  speed: 'NUMERIC' | 'BANDS';
  /** 第 3 步：距離的顯示精度。 */
  range: 'EXACT' | 'BANDS';
  /** 第 3 步：後方視野。 */
  rearCamera: boolean;
}

export interface Cockpit {
  name: string;
  pad: PadKey[][];
  readouts: Readouts;
}

export interface UiConfig {
  animation: { msPerHex: number; maxMoveMs: number; turnMs: number };
  camera: {
    hexesAcross: number;
    minHexPx: number;
    maxHexPx: number;
    recenterAfterMove: boolean;
    followActingUnit: 'OFF' | 'SNAP' | 'PAN';
  };
  preview: { driftTurns: number; trailLength: number };
  /** 左盤佈局：相對機首的方向編號字串、'OK'（確認鍵）、''（空格）。 */
  movePad: string[][];
  cockpits: Record<string, Cockpit>;
}

export const UI: UiConfig = uiJson as unknown as UiConfig;
