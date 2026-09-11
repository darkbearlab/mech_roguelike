/**
 * Canvas 2D 繪製。只讀 GameState，不改動任何東西。
 *
 * 圖層由下而上：地形 → 軌跡 → 巡航預測 → 這回合的預測路徑與落點 → 左盤方向提示 → 單位 → 點選的格子。
 * 機體永遠畫在格子中心（只有位移動畫的途中會在兩格之間）。
 */
import type { Dir, Hex } from '../core/hex';
import { DIR_VEC, add, rotate, scale } from '../core/hex';
import type { GameMap } from '../core/map';
import { allHexes, cellAt } from '../core/map';
import type { GameState, Unit } from '../core/state';
import type { Camera } from './camera';
import { worldToScreen } from './camera';
import type { Pt } from './geometry';
import { axialToWorld, dirAngle, hexCorners } from './geometry';
import type { AxialPt, Motion } from './motion';

/** 這回合左盤目前的選擇會發生什麼（預測）。 */
export interface Preview {
  path: Hex[];
  pos: Hex;
  heading: Dir;
  speed: number;
  collision: Hex | null;
  /** 選了方向（亮）還是只是「不點會怎樣」（暗）。 */
  selected: boolean;
}

/** 左盤方向提示：機體周圍六格，標出相對機首的每個方向最多能點幾下。 */
export interface RelHint {
  facing: Dir;
  taps: number[];
  /** 目前選的相對方向與點數。 */
  sel: { rel: number; taps: number } | null;
}

export interface Scene {
  state: GameState;
  cam: Camera;
  viewW: number;
  viewH: number;
  now: number;
  motion: Motion;
  preview: Preview | null;
  hint: RelHint | null;
  /** 從預測落點起算，之後不加速再滑幾回合的落點。 */
  drift: Hex[];
  trail: Hex[];
  picked: Hex | null;
}

const C = {
  bg: '#0b0e12',
  grid: 'rgba(255,255,255,0.05)',
  open: '#141a20',
  rubble: '#1d1a16',
  rubbleDot: '#3b342a',
  highland: '#1b2530',
  highlandRim: '#2f4050',
  ridge: '#333c48',
  ridgeTop: '#4d5967',
  ridgeShade: '#232a33',
  player: '#4fd6ff',
  enemy: '#ff6b5a',
  // 顏色的約定：青色 = 機體與機首；琥珀色 = 運動（速度、預測、滑行）
  vel: 'rgba(255,209,102,0.9)',
  ghost: '#ffd166',
  ghostDim: 'rgba(255,209,102,0.4)',
  path: 'rgba(255,209,102,0.18)',
  pathDim: 'rgba(255,209,102,0.07)',
  hit: '#ff5a5a',
  arc: 'rgba(79,214,255,0.06)',
  hint: 'rgba(79,214,255,0.55)',
  trail: 'rgba(79,214,255,0.3)',
  drift: 'rgba(255,209,102,0.45)',
  picked: 'rgba(255,255,255,0.7)',
} as const;

function tracePoly(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

function toScreen(cam: Camera, p: AxialPt): Pt {
  return worldToScreen(cam, axialToWorld(p.q, p.r));
}

/** 格子的固定亂數（碎石的點點），跟著座標走，不用 RNG。 */
function cellHash(h: Hex, k: number): number {
  const x = Math.sin(h.q * 127.1 + h.r * 311.7 + k * 74.7) * 43758.5453;
  return x - Math.floor(x);
}

function drawTerrain(ctx: CanvasRenderingContext2D, map: GameMap, cam: Camera, viewW: number, viewH: number): void {
  const s = cam.size;
  for (const h of allHexes(map)) {
    const c = toScreen(cam, h);
    if (c.x < -s * 2 || c.x > viewW + s * 2 || c.y < -s * 2 || c.y > viewH + s * 2) continue;
    const cell = cellAt(map, h)!;
    const corners = hexCorners(c.x, c.y, s * 0.985);
    tracePoly(ctx, corners);
    switch (cell.terrain) {
      case 'rubble':
        ctx.fillStyle = C.rubble;
        ctx.fill();
        ctx.fillStyle = C.rubbleDot;
        for (let k = 0; k < 4; k++) {
          const a = cellHash(h, k) * Math.PI * 2;
          const d = cellHash(h, k + 9) * s * 0.55;
          ctx.fillRect(c.x + Math.cos(a) * d - 1.5, c.y + Math.sin(a) * d - 1.5, 3, 3);
        }
        break;
      case 'highland':
        ctx.fillStyle = C.highland;
        ctx.fill();
        tracePoly(ctx, hexCorners(c.x, c.y, s * 0.7));
        ctx.strokeStyle = C.highlandRim;
        ctx.lineWidth = 1;
        ctx.stroke();
        break;
      case 'ridge':
        ctx.fillStyle = C.ridgeShade;
        ctx.fill();
        tracePoly(ctx, hexCorners(c.x, c.y - s * 0.1, s * 0.8));
        ctx.fillStyle = C.ridge;
        ctx.fill();
        ctx.strokeStyle = C.ridgeTop;
        ctx.lineWidth = 1;
        ctx.stroke();
        break;
      default:
        ctx.fillStyle = C.open;
        ctx.fill();
    }
    tracePoly(ctx, corners);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawDots(ctx: CanvasRenderingContext2D, cam: Camera, pts: Hex[], color: string, r: number): void {
  ctx.fillStyle = color;
  for (const p of pts) {
    const c = toScreen(cam, p);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, color: string, width: number): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 2) return;
  const ux = dx / len;
  const uy = dy / len;
  const head = Math.min(10, len * 0.4);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x - ux * head * 0.6, to.y - uy * head * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - ux * head - uy * head * 0.5, to.y - uy * head + ux * head * 0.5);
  ctx.lineTo(to.x - ux * head + uy * head * 0.5, to.y - uy * head - ux * head * 0.5);
  ctx.closePath();
  ctx.fill();
}

function drawPreview(ctx: CanvasRenderingContext2D, cam: Camera, p: Preview): void {
  const s = cam.size;
  for (const h of p.path.slice(1)) {
    const c = toScreen(cam, h);
    tracePoly(ctx, hexCorners(c.x, c.y, s * 0.9));
    ctx.fillStyle = p.selected ? C.path : C.pathDim;
    ctx.fill();
  }
  if (p.collision) {
    const c = toScreen(cam, p.collision);
    const k = s * 0.35;
    ctx.strokeStyle = C.hit;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(c.x - k, c.y - k);
    ctx.lineTo(c.x + k, c.y + k);
    ctx.moveTo(c.x + k, c.y - k);
    ctx.lineTo(c.x - k, c.y + k);
    ctx.stroke();
  }
  // 落點：一個空心的機身輪廓 + 速度數字
  if (p.path.length > 1 || p.selected) {
    const c = toScreen(cam, p.pos);
    ctx.beginPath();
    ctx.arc(c.x, c.y, s * 0.42, 0, Math.PI * 2);
    ctx.strokeStyle = p.selected ? C.ghost : C.ghostDim;
    ctx.lineWidth = p.selected ? 2 : 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = p.selected ? C.ghost : C.ghostDim;
    ctx.font = `bold ${Math.round(s * 0.45)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.speed), c.x, c.y + 1);
  }
}

/** 機體周圍六格標出「往這個方向最多能點幾下」—— 左盤跟著機首排，這個讓人對得上地圖。 */
function drawHint(ctx: CanvasRenderingContext2D, cam: Camera, u: Unit, h: RelHint): void {
  const s = cam.size;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let rel = 0; rel < 6; rel++) {
    const n = h.taps[rel];
    const on = h.sel?.rel === rel;
    if (n === 0 && !on) continue;
    const d = rotate(h.facing, rel);
    const c = toScreen(cam, add(u.pos, DIR_VEC[d]));
    const label = on ? `${h.sel!.taps}/${n}` : String(n);
    ctx.font = `${on ? 'bold ' : ''}${Math.round(s * (on ? 0.42 : 0.34))}px system-ui, sans-serif`;
    ctx.fillStyle = on ? C.ghost : C.hint;
    ctx.fillText(label, c.x, c.y);
  }
}

function drawUnit(ctx: CanvasRenderingContext2D, sc: Scene, u: Unit): void {
  const { cam, now, motion } = sc;
  const s = cam.size;
  const moving = motion.active(now);
  const c = toScreen(cam, motion.posOf(u.id, u.pos, now));
  const color = u.side === 'PLAYER' ? C.player : C.enemy;
  const face = motion.angleOf(u.id, dirAngle(u.facing), now);

  if (!moving) {
    tracePoly(ctx, hexCorners(c.x, c.y, s * 0.93));
    ctx.strokeStyle = u.side === 'PLAYER' ? 'rgba(79,214,255,0.45)' : 'rgba(255,107,90,0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // 機首前方的半平面：日後的武器射界
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.arc(c.x, c.y, s * 1.6, face - Math.PI / 2, face + Math.PI / 2);
  ctx.closePath();
  ctx.fillStyle = C.arc;
  ctx.fill();

  // 機身
  const r = s * 0.42;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#0b0e12';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  // 機首
  ctx.beginPath();
  ctx.moveTo(c.x + Math.cos(face) * r * 1.35, c.y + Math.sin(face) * r * 1.35);
  ctx.lineTo(c.x + Math.cos(face + 2.4) * r * 0.75, c.y + Math.sin(face + 2.4) * r * 0.75);
  ctx.lineTo(c.x + Math.cos(face - 2.4) * r * 0.75, c.y + Math.sin(face - 2.4) * r * 0.75);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  if (u.shutdown > 0) {
    ctx.fillStyle = C.hit;
    ctx.font = `bold ${Math.round(s * 0.42)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('停機', c.x, c.y - r * 1.4);
  }

  // 速度：沿速度方向畫到「照目前速度走一回合」的那一格
  if (u.speed > 0 && !moving) {
    const tip = toScreen(cam, add(u.pos, scale(DIR_VEC[u.heading], u.speed)));
    drawArrow(ctx, c, tip, C.vel, 2);
  }
}

export function draw(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const { state, cam, viewW, viewH } = sc;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, viewW, viewH);
  drawTerrain(ctx, state.map, cam, viewW, viewH);
  drawDots(ctx, cam, sc.trail, C.trail, Math.max(2, cam.size * 0.08));
  const still = !sc.motion.active(sc.now);
  if (still) {
    drawDots(ctx, cam, sc.drift, C.drift, Math.max(2, cam.size * 0.1));
    if (sc.preview) drawPreview(ctx, cam, sc.preview);
  }
  for (const u of state.units) if (u.alive) drawUnit(ctx, sc, u);
  const me = state.units[0];
  if (still && sc.hint && me) drawHint(ctx, cam, me, sc.hint);
  if (sc.picked) {
    const c = toScreen(cam, sc.picked);
    tracePoly(ctx, hexCorners(c.x, c.y, cam.size * 0.95));
    ctx.strokeStyle = C.picked;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
