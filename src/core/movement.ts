/**
 * 向量移動（§3）。
 *
 * 每回合的解算順序是規格 §3.1 的字面順序，不要調換：
 *   1 加速宣告 → 2 套用加速 → 3 套用阻力 → 4 速度上限 → 5 位移 → 6 沿直線逐格判定
 *
 * 這裡全是純函式：給一個單位與一個宣告，回傳解算結果，不改動任何輸入。
 * engine.ts 拿它來真的移動；介面拿它來畫預測落點；bot 與日後的敵人 AI 拿它來做搜尋 ——
 * 三者走的是同一段程式碼，所以預測永遠等於實際。
 */
import type { Dir, Hex, SubVec } from './hex';
import { DIR_VEC, SUB, add, hexLen, hexLine, hexRound, hexToSub, inFrontArc, scale, subToHex, vec } from './hex';
import type { GameMap } from './map';
import { cellAt } from './map';
import type { DriveDef, Rules } from './rules';
import { accelOf } from './rules';
import type { AccelChoice, Blocker, Collision, GameState, Unit } from './state';
import { unitAt } from './state';

// ---------------------------------------------------------------- 向量長度運算

/**
 * 把向量等比縮到指定長度（cube 長度，len 必須是整數）。原本就不超過就原樣回傳。
 *
 * 取最近的整數向量，方向最忠實，而且**保證不超過 len**：縮放後的點落在長度 len 的六角形邊上，
 * 絕對值最大的那個 cube 分量恰好是整數 len、取整誤差為 0，cube rounding 永遠不會去修正它；
 * 另外兩個分量與它異號、和為 ∓len，取整後也跑不出 [−len, len]。
 * tests/movement.test.ts 對所有可能出現的速度窮舉驗證這件事。
 */
export function scaleToLength(v: SubVec, len: number): SubVec {
  const cur = hexLen(v);
  if (cur <= len) return vec(v.q, v.r);
  if (len <= 0) return vec(0, 0);
  const k = len / cur;
  return hexRound(v.q * k, v.r * k);
}

/** 長度減少 amount，不越過零（§3.1 第 2 步的制動、第 3 步的阻力）。 */
export function shrink(v: SubVec, amount: number): SubVec {
  return scaleToLength(v, Math.max(0, hexLen(v) - amount));
}

// ---------------------------------------------------------------- 驅動

export function driveOf(rules: Rules, u: Unit): DriveDef {
  return rules.drives[u.drive];
}

export function unitAccel(rules: Rules, u: Unit): number {
  return accelOf(rules, u.chassis, u.drive);
}

export interface Legality {
  ok: boolean;
  reason?: string;
}

/** 這個加速宣告合不合法（不看輪到誰，只看單位本身）。 */
export function accelLegality(rules: Rules, u: Unit, choice: AccelChoice): Legality {
  if (u.shutdown > 0 && choice.kind !== 'CRUISE') return { ok: false, reason: '停機中：只能滑行' };
  if (choice.kind === 'DIR' && !driveOf(rules, u).sideAccel && !inFrontArc(u.facing, choice.dir)) {
    // §3.2：側向加速只有噴射做得到。按鍵置灰的就是這一條。
    return { ok: false, reason: '側向加速：' + driveOf(rules, u).name + '只能往前方三面推進' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 解算

export interface MotionResult {
  choice: AccelChoice;
  /** 實際施加的加速量（sub）。制動時是實際減掉的量。 */
  accelApplied: number;
  /** 加速產熱（§4.2）。 */
  heat: number;
  /** 解算後的速度。撞擊時歸零。 */
  velSub: SubVec;
  /** 解算後的位置。撞擊時停在撞上之前那一格的中心。 */
  posSub: SubVec;
  /** 舊格 → 停下的格（含起點）。 */
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

function blockerAt(w: MotionWorld, h: Hex): { blocker: Blocker; unitId?: string } | null {
  const c = cellAt(w.map, h);
  if (!c) return { blocker: 'EDGE' };
  if (!c.passable) return { blocker: 'TERRAIN' };
  const u = w.unitAt(h);
  if (u) return { blocker: 'UNIT', unitId: u.id };
  return null;
}

/**
 * §3.1 第 2～4 步：加速 → 阻力 → 上限。只算速度，不碰位置。
 * resolveMotion() 與 driveProfile() 共用這一段，所以面板上的「滑行幾回合」與實際一致。
 */
export function integrateVelocity(
  v0: SubVec,
  choice: AccelChoice,
  accel: number,
  drag: number,
  maxSpeed: number,
): { velSub: SubVec; accelApplied: number } {
  let v = vec(v0.q, v0.r);

  // 2. 套用加速（制動 = 朝反向縮減 accel，不越過零）
  let accelApplied = 0;
  if (choice.kind === 'DIR') {
    v = add(v, scale(DIR_VEC[choice.dir], accel));
    accelApplied = accel;
  } else if (choice.kind === 'BRAKE') {
    const before = hexLen(v);
    v = shrink(v, accel);
    accelApplied = before - hexLen(v);
  }

  // 3. 套用阻力
  v = shrink(v, drag);

  // 4. 速度上限
  return { velSub: scaleToLength(v, maxSpeed), accelApplied };
}

/** 加速產熱（§4.2）：heatPerAccel 是「每 1 格/回合（= SUB sub）的實際加速量」的熱。 */
export function accelHeat(accelApplied: number, heatPerAccel: number): number {
  return Math.round((accelApplied * heatPerAccel) / SUB);
}

/**
 * §3.1 的一次完整解算。**不檢查合法性** —— 呼叫端先問 accelLegality()。
 *
 * 阻力取的是出發格的地形修正：阻力在位移之前結算，那一刻機體踩的是出發格。
 *
 * 撞擊（§11.6 待決）的 v0.1 處理：停在撞上之前那一格的中心、速度歸零，
 * 事件裡帶著撞擊前的速度，日後要算撞擊傷害時從這裡接。
 */
export function resolveMotion(w: MotionWorld, u: Unit, choice: AccelChoice): MotionResult {
  const drive = w.rules.drives[u.drive];
  const fromHex = subToHex(u.posSub);
  const terrainDrag = cellAt(w.map, fromHex)?.dragModifier ?? 0;
  const { velSub: v, accelApplied } = integrateVelocity(
    u.velSub, choice, accelOf(w.rules, u.chassis, u.drive), drive.drag + terrainDrag, drive.maxSpeed,
  );

  // 5. 位移
  const target = add(u.posSub, v);

  // 6. 沿舊格到新格的六角直線逐格判定
  const line = hexLine(fromHex, subToHex(target));
  let last = 0;
  let collision: Collision | null = null;
  for (let i = 1; i < line.length; i++) {
    const hit = blockerAt(w, line[i]);
    if (hit) {
      collision = { at: line[i], blocker: hit.blocker, speed: hexLen(v) };
      if (hit.unitId) collision.unitId = hit.unitId;
      break;
    }
    last = i;
  }

  const heat = accelHeat(accelApplied, drive.heatPerAccel);
  if (collision) {
    return {
      choice, accelApplied, heat,
      velSub: vec(0, 0),
      posSub: hexToSub(line[last]),
      path: line.slice(0, last + 1),
      collision,
    };
  }
  return { choice, accelApplied, heat, velSub: v, posSub: target, path: line, collision: null };
}

/** 全部八個宣告，依左盤的閱讀順序（六向 → 巡航 → 制動）。 */
export const ALL_CHOICES: readonly AccelChoice[] = [
  { kind: 'DIR', dir: 0 }, { kind: 'DIR', dir: 1 }, { kind: 'DIR', dir: 2 },
  { kind: 'DIR', dir: 3 }, { kind: 'DIR', dir: 4 }, { kind: 'DIR', dir: 5 },
  { kind: 'CRUISE' }, { kind: 'BRAKE' },
];

export function choiceKey(c: AccelChoice): string {
  return c.kind === 'DIR' ? String(c.dir) : c.kind;
}

export function choiceFromKey(key: string): AccelChoice {
  if (key === 'CRUISE' || key === 'BRAKE') return { kind: key };
  return { kind: 'DIR', dir: Number(key) as Dir };
}

// ---------------------------------------------------------------- 驅動輪廓

export interface DriveProfile {
  accel: number;
  drag: number;
  maxSpeed: number;
  /** 空地上從靜止推一回合得到的速度（= 淨推進）。0 代表這個驅動根本動不了。 */
  netPush: number;
  /** 從靜止持續推進到極速要幾回合；到不了回傳 null。 */
  turnsToMax: number | null;
  /** 從極速開始巡航到停下要幾回合；停不下來回傳 null。 */
  coastTurns: number | null;
  /** 從極速開始制動到停下要幾回合；停不下來回傳 null。 */
  brakeTurns: number | null;
  /** 每推一次的產熱。 */
  heatPerPush: number;
}

/**
 * 在一片沒有地形修正、沒有邊界的空地上試跑一個驅動，量出手感的幾個數字。
 * 調參面板與 bot 報表都印這個 —— 「drag 從 9 改成 7」很難想像，
 * 「滑行從 2 回合變成 3 回合」就很直觀。
 */
export function driveProfile(rules: Rules, chassisId: string, driveId: string): DriveProfile {
  const drive = rules.drives[driveId];
  const accel = accelOf(rules, chassisId, driveId);
  const LIMIT = 100;
  const step = (v: SubVec, choice: AccelChoice): SubVec =>
    integrateVelocity(v, choice, accel, drive.drag, drive.maxSpeed).velSub;
  const push: AccelChoice = { kind: 'DIR', dir: 0 };

  let v = vec(0, 0);
  let turnsToMax: number | null = null;
  for (let t = 1; t <= LIMIT && drive.maxSpeed > 0; t++) {
    v = step(v, push);
    if (hexLen(v) >= drive.maxSpeed) {
      turnsToMax = t;
      break;
    }
  }
  const stopTurns = (choice: AccelChoice): number | null => {
    let w = scale(DIR_VEC[0], drive.maxSpeed);
    for (let t = 1; t <= LIMIT; t++) {
      w = step(w, choice);
      if (hexLen(w) === 0) return t;
    }
    return null;
  };
  return {
    accel,
    drag: drive.drag,
    maxSpeed: drive.maxSpeed,
    netPush: hexLen(step(vec(0, 0), push)),
    turnsToMax,
    coastTurns: drive.maxSpeed > 0 ? stopTurns({ kind: 'CRUISE' }) : 0,
    brakeTurns: drive.maxSpeed > 0 ? stopTurns({ kind: 'BRAKE' }) : 0,
    heatPerPush: accelHeat(accel, drive.heatPerAccel),
  };
}
