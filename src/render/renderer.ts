/**
 * Canvas 2D 繪製。只讀 GameState，不改動任何東西。
 *
 * 圖層由下而上：地形 → 軌跡 → 巡航預測 → 幽靈標記與路徑 → 單位（射界、機身、速度箭頭）→ 點選的格子。
 */
import type { Hex, SubVec } from '../core/hex';
import { SUB, hexLen, subToHex } from '../core/hex';
import type { GameMap } from '../core/map';
import { allHexes, cellAt } from '../core/map';
import type { GameState, Unit } from '../core/state';
import type { Camera } from './camera';
import { worldToScreen } from './camera';
import type { Pt } from './geometry';
import { axialToWorld, dirAngle, hexCorners, subToWorld } from './geometry';
import type { Motion } from './motion';

export interface Ghost {
  key: string;
  /** 標在落點上的字元（↑↗…○■）。 */
  glyph: string;
  pos: SubVec;
  vel: SubVec;
  path: Hex[];
  collision: Hex | null;
  legal: boolean;
}

export interface Scene {
  state: GameState;
  cam: Camera;
  viewW: number;
  viewH: number;
  now: number;
  motion: Motion;
  /** 加速宣告時八個選項的預測落點（§9 幽靈標記）。 */
  ghosts: Ghost[];
  /** 按住的那一鍵：畫出整條路徑。 */
  focus: Ghost | null;
  /** 從 focus（或目前狀態）起算，照速度再巡航幾回合的落點。 */
  drift: SubVec[];
  trail: SubVec[];
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
  ridge: '#3a4451',
  ridgeTop: '#5a6776',
  ridgeShade: '#262d36',
  player: '#4fd6ff',
  enemy: '#ff6b5a',
  // 顏色的約定：青色 = 機體與朝向；琥珀色 = 運動（速度、預測落點、巡航預測）
  vel: 'rgba(255,209,102,0.9)',
  ghost: '#ffd166',
  ghostDim: 'rgba(255,209,102,0.45)',
  path: 'rgba(255,209,102,0.16)',
  hit: '#ff5a5a',
  arc: 'rgba(79,214,255,0.07)',
  trail: 'rgba(79,214,255,0.3)',
  drift: 'rgba(255,209,102,0.5)',
  picked: 'rgba(255,255,255,0.7)',
} as const;

function tracePoly(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

function hexScreen(cam: Camera, h: Hex): Pt {
  return worldToScreen(cam, axialToWorld(h.q, h.r));
}

function subScreen(cam: Camera, p: SubVec): Pt {
  return worldToScreen(cam, subToWorld(p));
}

/** 格子的固定亂數（碎石的點點），跟著座標走，不用 RNG。 */
function cellHash(h: Hex, k: number): number {
  const x = Math.sin(h.q * 127.1 + h.r * 311.7 + k * 74.7) * 43758.5453;
  return x - Math.floor(x);
}

function drawTerrain(ctx: CanvasRenderingContext2D, map: GameMap, cam: Camera, viewW: number, viewH: number): void {
  const s = cam.size;
  for (const h of allHexes(map)) {
    const c = hexScreen(cam, h);
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
      case 'ridge': {
        ctx.fillStyle = C.ridgeShade;
        ctx.fill();
        // 上半邊亮、下半邊暗：看起來像突起的岩脊
        tracePoly(ctx, hexCorners(c.x, c.y - s * 0.12, s * 0.8));
        ctx.fillStyle = C.ridge;
        ctx.fill();
        ctx.strokeStyle = C.ridgeTop;
        ctx.lineWidth = 1;
        ctx.stroke();
        break;
      }
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

function drawDots(ctx: CanvasRenderingContext2D, cam: Camera, pts: SubVec[], color: string, r: number): void {
  ctx.fillStyle = color;
  for (const p of pts) {
    const c = subScreen(cam, p);
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

function drawGhosts(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const { cam } = sc;
  const s = cam.size;
  if (sc.focus) {
    for (const h of sc.focus.path.slice(1)) {
      tracePoly(ctx, hexCorners(hexScreen(cam, h).x, hexScreen(cam, h).y, s * 0.9));
      ctx.fillStyle = C.path;
      ctx.fill();
    }
    if (sc.focus.collision) {
      const c = hexScreen(cam, sc.focus.collision);
      ctx.strokeStyle = C.hit;
      ctx.lineWidth = 3;
      const k = s * 0.35;
      ctx.beginPath();
      ctx.moveTo(c.x - k, c.y - k);
      ctx.lineTo(c.x + k, c.y + k);
      ctx.moveTo(c.x + k, c.y - k);
      ctx.lineTo(c.x - k, c.y + k);
      ctx.stroke();
    }
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const g of sc.ghosts) {
    if (!g.legal) continue;
    const on = sc.focus?.key === g.key;
    if (sc.focus && !on) continue;
    const c = subScreen(cam, g.pos);
    const r = Math.max(7, s * (on ? 0.34 : 0.24));
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fillStyle = on ? 'rgba(255,209,102,0.28)' : 'rgba(11,14,18,0.72)';
    ctx.fill();
    ctx.strokeStyle = on ? C.ghost : C.ghostDim;
    ctx.lineWidth = on ? 2 : 1;
    ctx.stroke();
    ctx.fillStyle = on ? C.ghost : C.ghostDim;
    ctx.font = `${Math.round(r * 1.15)}px system-ui, sans-serif`;
    ctx.fillText(g.glyph, c.x, c.y + 0.5);
    if (g.collision) {
      ctx.fillStyle = C.hit;
      ctx.beginPath();
      ctx.arc(c.x + r * 0.8, c.y - r * 0.8, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawUnit(ctx: CanvasRenderingContext2D, sc: Scene, u: Unit): void {
  const { cam, now, motion } = sc;
  const s = cam.size;
  const pos = motion.posOf(u.id, u.posSub, now);
  const c = subScreen(cam, pos);
  const color = u.side === 'PLAYER' ? C.player : C.enemy;
  const face = motion.angleOf(u.id, dirAngle(u.facing), now);

  // 佔格外框：遊戲判定用的是這一格，不是機體畫在哪
  const occ = hexScreen(cam, subToHex(u.posSub));
  if (!motion.active(now)) {
    tracePoly(ctx, hexCorners(occ.x, occ.y, s * 0.93));
    ctx.strokeStyle = u.side === 'PLAYER' ? 'rgba(79,214,255,0.45)' : 'rgba(255,107,90,0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // 前方三面 = 朝向前的半平面（§3.3）：地面驅動的可加速方向、之後的武器射界
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
  // 機首（朝向）
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

  // 速度箭頭：從機體指向「照這個速度巡航一回合」的位置（不含阻力，純向量）
  if (hexLen(u.velSub) > 0 && !motion.active(now)) {
    const tip = subScreen(cam, { q: u.posSub.q + u.velSub.q, r: u.posSub.r + u.velSub.r });
    drawArrow(ctx, c, tip, C.vel, 2);
  }
}

export function draw(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const { state, cam, viewW, viewH } = sc;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, viewW, viewH);
  drawTerrain(ctx, state.map, cam, viewW, viewH);
  drawDots(ctx, cam, sc.trail, C.trail, Math.max(2, cam.size * 0.08));
  if (!sc.motion.active(sc.now)) {
    drawDots(ctx, cam, sc.drift, C.drift, Math.max(2, cam.size * 0.1));
    drawGhosts(ctx, sc);
  }
  for (const u of state.units) if (u.alive) drawUnit(ctx, sc, u);
  if (sc.picked) {
    const c = hexScreen(cam, sc.picked);
    tracePoly(ctx, hexCorners(c.x, c.y, cam.size * 0.95));
    ctx.strokeStyle = C.picked;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/** 速度換算成「格/回合」字串，保留一位小數（§2）。 */
export function speedText(v: SubVec): string {
  return (hexLen(v) / SUB).toFixed(1);
}
