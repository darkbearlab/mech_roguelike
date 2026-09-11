/**
 * Canvas 2D 繪製。只讀 GameState，不改動任何東西。
 *
 * 圖層由下而上：地形 → 跑道 → 射界 → 軌跡 → 巡航預測 → 這回合的預測路徑與落點 → 殘骸 → 單位
 * → 目標標籤 → 左盤方向提示 → 畫面外箭頭 → 點選的格子 → 曳光與飄字。
 * 機體永遠畫在格子中心（只有位移動畫的途中會在兩格之間）。
 */
import type { Checkpoint } from '../core/course';
import { checkpointHexes } from '../core/course';
import type { Dir, Hex } from '../core/hex';
import { DIR_VEC, add, hexDist, rotate, scale } from '../core/hex';
import type { GameMap } from '../core/map';
import { allHexes, cellAt } from '../core/map';
import type { GameState, Unit } from '../core/state';
import type { Camera, SafeArea } from './camera';
import { worldToScreen } from './camera';
import type { Effects } from './effects';
import type { Pt } from './geometry';
import { axialToWorld, dirAngle, hexCorners } from './geometry';
import type { AxialPt, Motion } from './motion';

/** 這回合左盤目前的選擇會發生什麼（預測）。 */
export interface Preview {
  path: Hex[];
  pos: Hex;
  heading: Dir;
  speed: number;
  /** 轉完之後的機首（左盤選的轉向）。 */
  facing: Dir;
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

/** 跑道：檢查點、下一個要過的是第幾個、起點（畫路線用）。 */
export interface CourseView {
  checkpoints: Checkpoint[];
  next: number;
  start: Hex;
}

/** 射界 × 射程涵蓋的格子；optimal = 落在有利射程內（畫亮一點）。 */
export interface ArcCell {
  hex: Hex;
  optimal: boolean;
}

/** 目標：誰被選中、每個打得到的目標頭上寫多少命中率；以及對手打你的命中率（威脅）。 */
export interface TargetView {
  selected: string | null;
  /** unitId → 命中率；不在表裡 = 現在打不到。 */
  chance: Map<string, number>;
  /** 對手現在打你的最高命中率；null = 沒有人打得到你。 */
  threat: number | null;
  /** 威脅標在哪一格（加速階段是預測的落點）。 */
  threatAt: Hex;
}

export interface Scene {
  state: GameState;
  cam: Camera;
  viewW: number;
  viewH: number;
  /** 沒被儀表與觸控盤蓋住的那一段（畫面外指示箭頭要貼著它的邊）。 */
  safe: SafeArea;
  now: number;
  motion: Motion;
  preview: Preview | null;
  hint: RelHint | null;
  /** 從預測落點起算，之後不加速再滑幾回合的落點。 */
  drift: Hex[];
  trail: Hex[];
  picked: Hex | null;
  course: CourseView | null;
  /** 行動階段才有：這把武器現在打得到哪些格子。 */
  arc: ArcCell[] | null;
  targets: TargetView | null;
  fx: Effects;
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
  track: '#1d252d',
  trackEdge: 'rgba(255,255,255,0.09)',
  // 檢查點：綠色（青色是機體、琥珀色是運動，綠色是目標）
  cp: '#7dff9a',
  cpFill: 'rgba(125,255,154,0.16)',
  cpDim: 'rgba(125,255,154,0.35)',
  cpDone: 'rgba(255,255,255,0.12)',
  cpLine: 'rgba(125,255,154,0.22)',
  // 射擊：射界是機體的屬性（青色）；準星與命中率用白色，最醒目
  arcCell: 'rgba(79,214,255,0.07)',
  arcOptimal: 'rgba(79,214,255,0.15)',
  reticle: '#ffffff',
  reticleDim: 'rgba(255,255,255,0.45)',
  hpBack: 'rgba(0,0,0,0.6)',
  hp: '#7dff9a',
  hpLow: '#ff5a5a',
  wreck: 'rgba(255,107,90,0.35)',
  tracerHit: '#ffe08a',
  tracerMiss: 'rgba(255,255,255,0.55)',
  threat: '#ff7b6b',
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
      case 'track':
        ctx.fillStyle = C.track;
        ctx.fill();
        ctx.strokeStyle = C.trackEdge;
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
    // 落點的機首（轉完之後）：圈外一個小三角
    const f = dirAngle(p.facing);
    const r = s * 0.42;
    ctx.beginPath();
    ctx.moveTo(c.x + Math.cos(f) * r * 1.5, c.y + Math.sin(f) * r * 1.5);
    ctx.lineTo(c.x + Math.cos(f + 0.35) * r * 1.08, c.y + Math.sin(f + 0.35) * r * 1.08);
    ctx.lineTo(c.x + Math.cos(f - 0.35) * r * 1.08, c.y + Math.sin(f - 0.35) * r * 1.08);
    ctx.closePath();
    ctx.fill();
  }
}

/** 跑道：路線虛線、每個檢查點的區域與編號。已過的淡掉、下一個最亮。 */
function drawCourse(ctx: CanvasRenderingContext2D, cam: Camera, cv: CourseView): void {
  const s = cam.size;
  // 路線：起點 → 各檢查點中心
  const pts = [cv.start, ...cv.checkpoints.map((c) => c.at)].map((h) => toScreen(cam, h));
  ctx.strokeStyle = C.cpLine;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();
  ctx.setLineDash([]);

  cv.checkpoints.forEach((cp, i) => {
    const state = i < cv.next ? 'done' : i === cv.next ? 'next' : 'later';
    for (const h of checkpointHexes(cp)) {
      const c = toScreen(cam, h);
      tracePoly(ctx, hexCorners(c.x, c.y, s * 0.9));
      if (state === 'next') {
        ctx.fillStyle = C.cpFill;
        ctx.fill();
      }
      ctx.strokeStyle = state === 'done' ? C.cpDone : state === 'next' ? C.cp : C.cpDim;
      ctx.lineWidth = state === 'next' ? 2 : 1;
      ctx.stroke();
    }
    const c = toScreen(cam, cp.at);
    ctx.fillStyle = state === 'done' ? C.cpDone : state === 'next' ? C.cp : C.cpDim;
    ctx.font = `bold ${Math.round(s * (state === 'next' ? 0.55 : 0.42))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(state === 'done' ? '✓' : cp.type === 'STOP' ? `${i + 1}停` : String(i + 1), c.x, c.y);
  });
}

/** 下一個檢查點在畫面外時，在可視區邊緣畫一個指向它的箭頭，標上編號與距離。 */
function drawOffscreen(ctx: CanvasRenderingContext2D, sc: Scene, cv: CourseView, me: Unit): void {
  const cp = cv.checkpoints[cv.next];
  if (!cp) return;
  const p = toScreen(sc.cam, cp.at);
  const m = 22;
  const top = sc.safe.top + m;
  const bottom = sc.safe.bottom - m;
  if (p.x >= m && p.x <= sc.viewW - m && p.y >= top && p.y <= bottom) return;
  // 從可視區中心往目標拉一條線，和可視區邊框的交點就是箭頭位置
  const cx = sc.viewW / 2;
  const cy = (top + bottom) / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const k = Math.min(
    dx !== 0 ? (sc.viewW / 2 - m) / Math.abs(dx) : Infinity,
    dy !== 0 ? (bottom - top) / 2 / Math.abs(dy) : Infinity,
  );
  const ax = cx + dx * k;
  const ay = cy + dy * k;
  const ang = Math.atan2(dy, dx);
  ctx.fillStyle = C.cp;
  ctx.beginPath();
  ctx.moveTo(ax + Math.cos(ang) * 12, ay + Math.sin(ang) * 12);
  ctx.lineTo(ax + Math.cos(ang + 2.5) * 10, ay + Math.sin(ang + 2.5) * 10);
  ctx.lineTo(ax + Math.cos(ang - 2.5) * 10, ay + Math.sin(ang - 2.5) * 10);
  ctx.closePath();
  ctx.fill();
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${cv.next + 1} · ${hexDist(me.pos, cp.at)}格`, ax - Math.cos(ang) * 22, ay - Math.sin(ang) * 16);
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

  // 有武器的機體：機首前方畫一小片扇形，一眼看得出槍口朝哪（完整射界在行動階段另外畫）
  if (sc.state.rules.chassis[u.chassis].weapon) {
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.arc(c.x, c.y, s * 1.6, face - Math.PI / 2, face + Math.PI / 2);
    ctx.closePath();
    ctx.fillStyle = C.arc;
    ctx.fill();
  }

  const r = s * 0.42;
  if (sc.state.rules.chassis[u.chassis].role === 'TARGET') {
    drawTargetBody(ctx, c, r, color, sc.state.rules.drives[u.drive].maxSpeed > 0);
  } else {
    // 機身
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
  }

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

  // 耐久：靶一直顯示；自己受損了才顯示
  const maxHp = sc.state.rules.chassis[u.chassis].hp;
  if (u.side !== 'PLAYER' || u.hp < maxHp) {
    const w = s * 0.9;
    const y = c.y + r * 1.35;
    ctx.fillStyle = C.hpBack;
    ctx.fillRect(c.x - w / 2, y, w, 4);
    const k = u.hp / maxHp;
    ctx.fillStyle = k > 0.34 ? C.hp : C.hpLow;
    ctx.fillRect(c.x - w / 2, y, w * k, 4);
  }
}

/** 靶沒有機首：固定靶是靶心；會動的靶機是菱形（速度箭頭照樣畫，看得出往哪飛）。 */
function drawTargetBody(ctx: CanvasRenderingContext2D, c: Pt, r: number, color: string, mobile: boolean): void {
  ctx.strokeStyle = color;
  ctx.fillStyle = '#0b0e12';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  if (mobile) {
    ctx.moveTo(c.x, c.y - r * 1.15);
    ctx.lineTo(c.x + r * 1.15, c.y);
    ctx.lineTo(c.x, c.y + r * 1.15);
    ctx.lineTo(c.x - r * 1.15, c.y);
    ctx.closePath();
  } else {
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r * 0.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r * 0.16, 0, Math.PI * 2);
  ctx.fill();
}

/** 打爆的機體留一個殘骸記號：看得出靶原本在哪、打掉了幾個。 */
function drawWreck(ctx: CanvasRenderingContext2D, cam: Camera, u: Unit): void {
  const c = toScreen(cam, u.pos);
  const k = cam.size * 0.28;
  ctx.strokeStyle = C.wreck;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(c.x - k, c.y - k);
  ctx.lineTo(c.x + k, c.y + k);
  ctx.moveTo(c.x + k, c.y - k);
  ctx.lineTo(c.x - k, c.y + k);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(c.x, c.y, cam.size * 0.42, 0, Math.PI * 2);
  ctx.stroke();
}

/** 射界 × 射程：與 core 的 shotCheck 同一條規則，亮的格子就是打得到的格子。 */
function drawArc(ctx: CanvasRenderingContext2D, map: GameMap, cam: Camera, cells: ArcCell[]): void {
  const s = cam.size;
  for (const a of cells) {
    if (!cellAt(map, a.hex)) continue;
    const c = toScreen(cam, a.hex);
    tracePoly(ctx, hexCorners(c.x, c.y, s * 0.96));
    ctx.fillStyle = a.optimal ? C.arcOptimal : C.arcCell;
    ctx.fill();
  }
}

/** 準星（選中的目標）與每個打得到的目標頭上的命中率。 */
function drawTargets(ctx: CanvasRenderingContext2D, sc: Scene, tv: TargetView): void {
  const { cam, now, motion } = sc;
  const s = cam.size;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const u of sc.state.units) {
    if (!u.alive || u.side === 'PLAYER') continue;
    const c = toScreen(cam, motion.posOf(u.id, u.pos, now));
    const chance = tv.chance.get(u.id);
    const sel = tv.selected === u.id;
    if (sel) {
      // 四個角的括號
      const k = s * 0.62;
      const L = s * 0.24;
      ctx.strokeStyle = chance !== undefined ? C.reticle : C.reticleDim;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.moveTo(c.x + sx * k, c.y + sy * (k - L));
        ctx.lineTo(c.x + sx * k, c.y + sy * k);
        ctx.lineTo(c.x + sx * (k - L), c.y + sy * k);
      }
      ctx.stroke();
    }
    if (chance !== undefined) {
      ctx.font = `bold ${Math.round(s * (sel ? 0.46 : 0.38))}px system-ui, sans-serif`;
      ctx.fillStyle = sel ? C.reticle : C.reticleDim;
      ctx.fillText(`${chance}%`, c.x, c.y - s * 0.62);
    }
  }
  // 威脅：紅字標在自己（或預測落點）上方 —— 開快比較難被打中，這個數字會跟著變
  if (tv.threat !== null) {
    const c = toScreen(cam, tv.threatAt);
    ctx.font = `bold ${Math.round(s * 0.4)}px system-ui, sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(`⚠${tv.threat}%`, c.x, c.y - s * 0.62);
    ctx.fillStyle = C.threat;
    ctx.fillText(`⚠${tv.threat}%`, c.x, c.y - s * 0.62);
  }
}

/** 曳光（打中直接落在目標上，沒打中擦過去）與飄字。 */
function drawEffects(ctx: CanvasRenderingContext2D, cam: Camera, fx: Effects, now: number): void {
  const s = cam.size;
  for (const t of fx.tracers) {
    const k = (now - t.start) / t.dur;
    if (k < 0 || k >= 1) continue;
    const a = toScreen(cam, t.from);
    let b = toScreen(cam, t.to);
    if (!t.hit) {
      // 沒打中：往旁邊偏一點、再多飛一段
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      b = { x: b.x + (dx / len) * s * 1.2 - (dy / len) * s * 0.45, y: b.y + (dy / len) * s * 1.2 + (dx / len) * s * 0.45 };
    }
    const p = Math.min(1, k / 0.35);
    const alpha = k < 0.35 ? 1 : 1 - (k - 0.35) / 0.65;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = t.hit ? C.tracerHit : C.tracerMiss;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(a.x + (b.x - a.x) * p, a.y + (b.y - a.y) * p);
    ctx.stroke();
    if (t.hit && p === 1) {
      ctx.fillStyle = C.tracerHit;
      ctx.beginPath();
      ctx.arc(b.x, b.y, s * 0.3 * (1 - k * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const f of fx.floaters) {
    const k = (now - f.start) / f.dur;
    if (k < 0 || k >= 1) continue;
    const c = toScreen(cam, f.at);
    ctx.globalAlpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
    ctx.font = `bold ${Math.round(s * 0.5)}px system-ui, sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    // 從命中率標籤上方開始往上飄，不跟標籤疊在一起
    const y = c.y - s * (1.35 + k * 0.6);
    ctx.strokeText(f.text, c.x, y);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, c.x, y);
    ctx.globalAlpha = 1;
  }
}

export function draw(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const { state, cam, viewW, viewH } = sc;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, viewW, viewH);
  drawTerrain(ctx, state.map, cam, viewW, viewH);
  if (sc.course) drawCourse(ctx, cam, sc.course);
  const still = !sc.motion.active(sc.now);
  if (still && sc.arc) drawArc(ctx, state.map, cam, sc.arc);
  drawDots(ctx, cam, sc.trail, C.trail, Math.max(2, cam.size * 0.08));
  if (still) {
    drawDots(ctx, cam, sc.drift, C.drift, Math.max(2, cam.size * 0.1));
    if (sc.preview) drawPreview(ctx, cam, sc.preview);
  }
  for (const u of state.units) if (!u.alive) drawWreck(ctx, cam, u);
  for (const u of state.units) if (u.alive) drawUnit(ctx, sc, u);
  if (sc.targets) drawTargets(ctx, sc, sc.targets);
  const me = state.units[0];
  if (still && sc.hint && me) drawHint(ctx, cam, me, sc.hint);
  if (sc.course && me) drawOffscreen(ctx, sc, sc.course, me);
  if (sc.picked) {
    const c = toScreen(cam, sc.picked);
    tracePoly(ctx, hexCorners(c.x, c.y, cam.size * 0.95));
    ctx.strokeStyle = C.picked;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  drawEffects(ctx, cam, sc.fx, sc.now);
}
