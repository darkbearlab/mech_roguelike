/**
 * 攝影機（§9）：機體置中於「點得到」的那塊區域，接近地圖邊緣時停止捲動。
 *
 * 沿用 PMC 的結論：夾制的是**可觸區域**而不是整個視窗。HUD 與兩個觸控盤是浮在地圖上的，
 * 照視窗夾制的話，機體走到地圖下緣時會被壓在觸控盤底下。所以垂直方向夾在
 * HUD 底部與觸控盤頂部之間；代價是地圖上下緣外會露出一條界外區，而那條剛好被 UI 蓋住。
 */
import type { GameMap } from '../core/map';
import { allHexes } from '../core/map';
import type { Pt } from './geometry';
import { SQRT3, axialToWorld } from './geometry';

export interface Camera {
  /** 六角半徑的 CSS 像素。 */
  size: number;
  /** 世界原點在畫面上的位置：screen = o + world × size。 */
  ox: number;
  oy: number;
}

/** 沒有被浮動 UI 蓋住的可視／可觸區域（畫面座標）。 */
export interface SafeArea {
  top: number;
  bottom: number;
}

export interface WorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function mapBounds(map: GameMap): WorldBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const h of allHexes(map)) {
    const w = axialToWorld(h.q, h.r);
    minX = Math.min(minX, w.x - 1);
    maxX = Math.max(maxX, w.x + 1);
    minY = Math.min(minY, w.y - SQRT3 / 2);
    maxY = Math.max(maxY, w.y + SQRT3 / 2);
  }
  return { minX, maxX, minY, maxY };
}

export function hexSizeFor(viewW: number, hexesAcross: number, min: number, max: number): number {
  // 一欄佔 1.5 個半徑寬，最後一欄多半個
  const raw = viewW / (1.5 * hexesAcross + 0.5);
  return Math.round(Math.min(max, Math.max(min, raw)));
}

/**
 * @param focus 要置中的世界座標（機體的動畫位置）
 * @param pan   暫時的手動平移（世界座標）。下一次加速宣告就歸零（§9：移動後自動回中）。
 */
export function computeCamera(
  b: WorldBounds, viewW: number, viewH: number, size: number, focus: Pt, pan: Pt, safe: SafeArea,
): Camera {
  const top = Math.max(0, Math.min(safe.top, viewH));
  const bottom = Math.max(top + size, Math.min(safe.bottom, viewH));
  const mapW = (b.maxX - b.minX) * size;
  const mapH = (b.maxY - b.minY) * size;

  let ox = viewW / 2 - (focus.x + pan.x) * size;
  let oy = (top + bottom) / 2 - (focus.y + pan.y) * size;

  ox = mapW <= viewW ? (viewW - mapW) / 2 - b.minX * size : clamp(ox, viewW - b.maxX * size, -b.minX * size);
  oy = mapH <= bottom - top
    ? top + (bottom - top - mapH) / 2 - b.minY * size
    : clamp(oy, bottom - b.maxY * size, top - b.minY * size);
  return { size, ox, oy };
}

/** 反推：這台攝影機實際看的中心，相對於 focus 的平移量。夾制之後拿它回寫 pan，拖過頭才不會累積。 */
export function effectivePan(cam: Camera, viewW: number, safe: SafeArea, focus: Pt): Pt {
  const cx = (viewW / 2 - cam.ox) / cam.size;
  const cy = ((safe.top + safe.bottom) / 2 - cam.oy) / cam.size;
  return { x: cx - focus.x, y: cy - focus.y };
}

export function worldToScreen(cam: Camera, w: Pt): Pt {
  return { x: cam.ox + w.x * cam.size, y: cam.oy + w.y * cam.size };
}

export function screenToWorld(cam: Camera, x: number, y: number): Pt {
  return { x: (x - cam.ox) / cam.size, y: (y - cam.oy) / cam.size };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
