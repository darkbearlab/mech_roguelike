/**
 * 移動（docs/design.md「移動」）：整數格、機體永遠站在格子中心。
 *
 * 機體的運動狀態 = 速度方向（六個方向之一）＋ 速率（整數格/回合），朝向另外存。
 * 每回合左盤宣告一次加速：往相對機首的某個方向點幾下。
 *
 *   能點幾下 —— 看加速方向相對**機首**的扇區（前／左右前／左右後／後），依驅動。
 *   點下去的效果 —— 看加速方向相對**目前速度方向**的夾角：
 *     同向       速度 + 點數（最多到極速）
 *     偏 60°     速度 − 折損60 + 點數，速度方向改成加速方向
 *     偏 120°    速度 − 折損120 + 點數，速度方向改成加速方向
 *     反向       速度 − 點數（煞車），扣到 0 就靜止
 *     靜止中     直接往那邊，速度 = 點數
 *     沒點       速度 − 衰減
 *   結果夾在 0..極速。
 *
 * 然後沿速度方向筆直走「速率」格，逐格判定碰撞。
 * **地形目前不影響移動**（設計者 2026-09-11：先無視地形限制，之後再討論）——
 * 擋路的只有地圖邊緣與其他機體。
 *
 * 這裡全是純函式。engine.ts 拿它來真的移動；介面拿它畫預測；bot 與日後的敵人 AI 拿它推演 ——
 * 走的是同一段程式碼，所以預測永遠等於實際。
 */
import type { Dir, Hex } from './hex';
import { DIR_VEC, add, rotate, turnSteps } from './hex';
import type { GameMap } from './map';
import { cellAt } from './map';
import type { DriveDef, Rules, Sector } from './rules';
import type { AccelOrder, Blocker, Collision, GameState, RelDir, Unit } from './state';
import { unitAt } from './state';

// ---------------------------------------------------------------- 左盤的點數

/** 相對機首的方向落在哪個扇區。 */
export function sectorOf(rel: RelDir): Sector {
  switch (rel) {
    case 0: return 'front';
    case 1: case 5: return 'frontSide';
    case 2: case 4: return 'rearSide';
    default: return 'rear';
  }
}

/** 這個驅動往相對機首 rel 的方向最多能點幾下。 */
export function maxTaps(drive: DriveDef, rel: RelDir): number {
  return drive.taps[sectorOf(rel)];
}

export function driveOf(rules: Rules, u: Unit): DriveDef {
  return rules.drives[u.drive];
}

export interface Legality {
  ok: boolean;
  reason?: string;
}

const REL_NAME = ['前', '右前', '右後', '後', '左後', '左前'] as const;

/** 這個加速宣告合不合法（不看輪到誰，只看單位本身）。 */
export function accelLegality(rules: Rules, u: Unit, order: AccelOrder): Legality {
  if (!order) return { ok: true };
  if (u.shutdown > 0) return { ok: false, reason: '停機中：不能加速，只能滑行' };
  if (!Number.isInteger(order.taps) || order.taps < 1) return { ok: false, reason: '點數必須是 ≥ 1 的整數' };
  const max = maxTaps(driveOf(rules, u), order.rel);
  if (max === 0) return { ok: false, reason: `${driveOf(rules, u).name}往${REL_NAME[order.rel]}方推不動` };
  if (order.taps > max) return { ok: false, reason: `${REL_NAME[order.rel]}方最多點 ${max} 下` };
  return { ok: true };
}

// ---------------------------------------------------------------- 速度結算

/** 這一次速度結算屬於哪一種情況（介面拿來寫說明）。 */
export type AccelKind = 'COAST' | 'START' | 'PUSH' | 'VEER60' | 'VEER120' | 'BRAKE';

export interface SpeedResult {
  kind: AccelKind;
  heading: Dir;
  speed: number;
  /** 改變速度方向的折損（偏 60° / 120° 時才有）。 */
  loss: number;
}

/** 速度結算：加速 → 夾在 0..極速。不碰位置。 */
export function resolveSpeed(
  drive: DriveDef,
  u: Pick<Unit, 'heading' | 'speed' | 'facing'>,
  order: AccelOrder,
): SpeedResult {
  let kind: AccelKind;
  let heading = u.heading;
  let v: number;
  let loss = 0;
  if (!order) {
    kind = 'COAST';
    v = u.speed - drive.decay;
  } else {
    const dir = rotate(u.facing, order.rel);
    if (u.speed === 0) {
      kind = 'START';
      heading = dir;
      v = order.taps;
    } else {
      switch (turnSteps(u.heading, dir)) {
        case 0:
          kind = 'PUSH';
          v = u.speed + order.taps;
          break;
        case 1:
          kind = 'VEER60';
          loss = drive.turnLoss.d60;
          v = Math.max(0, u.speed - loss) + order.taps;
          heading = dir;
          break;
        case 2:
          kind = 'VEER120';
          loss = drive.turnLoss.d120;
          v = Math.max(0, u.speed - loss) + order.taps;
          heading = dir;
          break;
        default:
          kind = 'BRAKE';
          v = u.speed - order.taps;
      }
    }
  }
  return { kind, heading, speed: Math.min(drive.maxSpeed, Math.max(0, v)), loss };
}

/** 左盤的產熱：每點一下 heatPerTap。 */
export function accelHeat(drive: DriveDef, order: AccelOrder): number {
  return order ? order.taps * drive.heatPerTap : 0;
}

// ---------------------------------------------------------------- 位移

export interface MotionResult extends SpeedResult {
  order: AccelOrder;
  heat: number;
  /** 解算後的位置。撞擊時停在撞上之前那一格。 */
  pos: Hex;
  /** 走過的格子（含起點）。 */
  path: Hex[];
  collision: Collision | null;
}

/** 一個單位移動時眼中的世界：地圖、其他單位佔的格子。 */
export interface MotionWorld {
  rules: Rules;
  map: GameMap;
  /** 這一格有沒有擋路的單位；沒有回傳 undefined。 */
  unitAt: (h: Hex) => { id: string } | undefined;
}

export function worldOf(s: GameState, selfId: string): MotionWorld {
  return { rules: s.rules, map: s.map, unitAt: (h) => unitAt(s, h, selfId) };
}

/** 擋路的只有地圖邊緣與其他機體；地形目前不擋（先無視地形限制）。 */
function blockerAt(w: MotionWorld, h: Hex): { blocker: Blocker; unitId?: string } | null {
  if (!cellAt(w.map, h)) return { blocker: 'EDGE' };
  const u = w.unitAt(h);
  if (u) return { blocker: 'UNIT', unitId: u.id };
  return null;
}

/**
 * 一次完整的移動解算。**不檢查合法性** —— 呼叫端先問 accelLegality()。
 *
 * 撞擊（待討論）的暫定處理：停在撞上之前那一格、速度歸零，
 * 事件裡帶著撞擊前的速度，日後要算撞擊傷害時從這裡接。
 */
export function resolveMotion(w: MotionWorld, u: Unit, order: AccelOrder): MotionResult {
  const drive = w.rules.drives[u.drive];
  const sr = resolveSpeed(drive, u, order);
  const step = DIR_VEC[sr.heading];
  const path: Hex[] = [u.pos];
  let collision: Collision | null = null;
  for (let i = 0; i < sr.speed; i++) {
    const next = add(path[path.length - 1], step);
    const hit = blockerAt(w, next);
    if (hit) {
      collision = { at: next, blocker: hit.blocker, speed: sr.speed };
      if (hit.unitId) collision.unitId = hit.unitId;
      break;
    }
    path.push(next);
  }
  return {
    ...sr,
    speed: collision ? 0 : sr.speed,
    order,
    heat: accelHeat(drive, order),
    pos: path[path.length - 1],
    path,
    collision,
  };
}

/** 這個單位這回合所有合法的加速宣告：不加速，加上每個方向 1..上限 下。規劃器用。 */
export function allOrders(rules: Rules, u: Unit): AccelOrder[] {
  const out: AccelOrder[] = [null];
  if (u.shutdown > 0) return out;
  const drive = driveOf(rules, u);
  for (let rel = 0 as RelDir; rel < 6; rel = (rel + 1) as RelDir) {
    for (let t = 1; t <= maxTaps(drive, rel); t++) out.push({ rel, taps: t });
  }
  return out;
}

export function orderKey(o: AccelOrder): string {
  return o ? `${o.rel}x${o.taps}` : 'COAST';
}

// ---------------------------------------------------------------- 驅動輪廓

export interface DriveProfile {
  maxSpeed: number;
  /** 從靜止每回合往前點滿，幾回合到極速；到不了回傳 null。 */
  turnsToMax: number | null;
  /** 從極速開始不加速，幾回合停下；停不下來回傳 null。 */
  coastTurns: number | null;
  /** 機首對準速度方向、從極速開始每回合往後點滿，幾回合停下；後方推不動回傳 null。 */
  brakeTurns: number | null;
  /** 極速時往左右前點滿轉 60°，轉完剩多少速度；左右前推不動回傳 null。 */
  veer60AtMax: number | null;
  /** 往前點滿一次的產熱。 */
  heatFullPush: number;
}

/**
 * 在一片沒有邊界的空地上試跑一個驅動，量出手感的幾個數字。
 * 調參面板與 bot 報表都印這個 —— 「衰減從 1 改成 2」很難想像，「滑行從 5 回合變 3 回合」就很直觀。
 */
export function driveProfile(rules: Rules, driveId: string): DriveProfile {
  const d = rules.drives[driveId];
  const LIMIT = 50;
  const run = (start: number, order: AccelOrder, until: (v: number) => boolean): number | null => {
    let s = { heading: 0 as Dir, speed: start, facing: 0 as Dir };
    for (let t = 1; t <= LIMIT; t++) {
      s = { ...s, speed: resolveSpeed(d, s, order).speed };
      if (until(s.speed)) return t;
    }
    return null;
  };
  const full = (rel: RelDir): AccelOrder => (maxTaps(d, rel) > 0 ? { rel, taps: maxTaps(d, rel) } : null);
  return {
    maxSpeed: d.maxSpeed,
    turnsToMax: d.taps.front > 0 && d.maxSpeed > 0 ? run(0, full(0), (v) => v >= d.maxSpeed) : null,
    coastTurns: d.maxSpeed === 0 ? 0 : run(d.maxSpeed, null, (v) => v === 0),
    brakeTurns: d.maxSpeed === 0 ? 0 : d.taps.rear > 0 ? run(d.maxSpeed, full(3), (v) => v === 0) : null,
    veer60AtMax: d.taps.frontSide > 0
      ? resolveSpeed(d, { heading: 0, speed: d.maxSpeed, facing: 0 }, full(1)).speed
      : null,
    heatFullPush: d.taps.front * d.heatPerTap,
  };
}
