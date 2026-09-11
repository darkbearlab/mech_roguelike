/**
 * GameState 型別與唯讀選取器。
 *
 * 狀態只能經由 engine.ts 的 applyCommand() 改變。rules 與 map 是不可變的參照：
 * 複製狀態時不會跟著深複製，任何人都不得就地修改它們。
 */
import type { Dir, Hex } from './hex';
import { sameHex } from './hex';
import type { GameMap } from './map';
import type { RngState } from './rng';
import type { Rules } from './rules';

export type Side = 'PLAYER' | 'ENEMY';

export interface Unit {
  id: string;
  name: string;
  side: Side;
  chassis: string;
  /** 目前的驅動模式（chassis.drives 其中之一）。 */
  drive: string;
  /** 位置：永遠是一個格子。 */
  pos: Hex;
  /**
   * 速度方向。速度為 0 時沒有意義，只是保留上一次的值；
   * 靜止時往哪邊加速，速度方向就變成哪邊。
   */
  heading: Dir;
  /** 速率，整數格/回合。 */
  speed: number;
  /** 朝向（機首），與速度方向完全獨立。左盤永遠不改它，只有右盤的轉向會改。 */
  facing: Dir;
  /** 這個階段還能用的 AP。階段結束時歸零 —— 配額不累積。 */
  ap: number;
  /** AP 債務：透支的部分，下一個階段開始時從配額扣。 */
  debt: number;
  heat: number;
  /** 還要停機幾個自己的階段。 */
  shutdown: number;
  /** 這個階段已經轉了幾面（算免費額度用）。 */
  facesTurned: number;
  /** 已宣告、尚未解算的加速（循序制下只會存在一瞬間）。 */
  pendingAccel: AccelOrder | null;
  alive: boolean;
}

/**
 * 相對機首的方向（= 從面向順時針轉幾面）：0 前、1 右前、2 右後、3 後、4 左後、5 左前。
 * 左盤的按鍵跟著機首排，所以按鍵本身就是這個編號。
 */
export type RelDir = Dir;

/**
 * 加速宣告：往相對機首的哪個方向點了幾下。null = 沒點，直接確認（這回合不加速）。
 */
export type AccelOrder = { rel: RelDir; taps: number } | null;

/**
 * 一回合拆成的步驟。順序由 order.ts 的解算順序模組決定。
 *
 * - DECLARE：等這個單位宣告加速（左盤）
 * - MOVE：解算列出單位的位移（自動）
 * - ACT：等這個單位做行動（右盤），直到 AP 用完、透支結算或它主動結束
 * - WORLD：被動散熱、狀態計時、勝敗判定（自動）
 */
export type Step =
  | { kind: 'DECLARE'; unitId: string }
  | { kind: 'MOVE'; unitIds: string[] }
  | { kind: 'ACT'; unitId: string }
  | { kind: 'WORLD' };

export interface GameState {
  rules: Rules;
  map: GameMap;
  units: Unit[];
  round: number;
  /** 解算順序模組的 id（order.ts）。 */
  order: string;
  /** 這一回合的步驟表與目前走到哪一步。 */
  steps: Step[];
  cursor: number;
  rng: RngState;
  /** 勝敗判定（第 5 步起才會有值）。 */
  over: null | { winner: Side | 'DRAW' };
}

export type Command =
  | { type: 'ACCEL'; order: AccelOrder }
  | { type: 'TURN'; delta: 1 | -1 }
  | { type: 'COOL' }
  | { type: 'SWITCH_DRIVE' }
  | { type: 'WAIT' };

/** 擋路的東西。地形目前不擋路（先無視地形限制），所以只有地圖邊緣與其他機體。 */
export type Blocker = 'EDGE' | 'UNIT';

export interface Collision {
  /** 撞上的那一格（沒進去）。 */
  at: Hex;
  blocker: Blocker;
  unitId?: string;
  /** 撞擊前的速度。撞擊傷害的掛勾。 */
  speed: number;
}

export type GameEvent =
  | { type: 'ROUND'; round: number }
  | { type: 'PHASE'; unitId: string }
  | {
      type: 'MOVED';
      unitId: string;
      order: AccelOrder;
      from: Hex;
      to: Hex;
      heading: Dir;
      speed: number;
      /** 走過的格子（含起點）。動畫一格一格走這條。 */
      path: Hex[];
    }
  | { type: 'COLLIDED'; unitId: string; collision: Collision }
  | { type: 'TURNED'; unitId: string; from: Dir; to: Dir; speed: number }
  | { type: 'COOLED'; unitId: string; heat: number }
  | { type: 'DRIVE'; unitId: string; drive: string }
  | { type: 'OVERHEAT'; unitId: string }
  | { type: 'REBOOT'; unitId: string }
  | { type: 'WAITED'; unitId: string }
  /** 階段結束的原因：主動待機、AP 用完、透支結算、停機。 */
  | { type: 'PHASE_END'; unitId: string; reason: 'WAIT' | 'AP_SPENT' | 'OVERDRAFT' | 'SHUTDOWN' };

// ---------------------------------------------------------------- 選取器

export function unitById(s: GameState, id: string): Unit | undefined {
  return s.units.find((u) => u.id === id);
}

export function currentStep(s: GameState): Step | null {
  return s.steps[s.cursor] ?? null;
}

/** 目前在等誰輸入（DECLARE 或 ACT 的那個單位）。自動步驟回傳 null。 */
export function activeUnit(s: GameState): Unit | null {
  const step = currentStep(s);
  if (!step || (step.kind !== 'DECLARE' && step.kind !== 'ACT')) return null;
  return unitById(s, step.unitId) ?? null;
}

/** 這一格上的其他存活單位。 */
export function unitAt(s: GameState, h: Hex, exceptId?: string): Unit | undefined {
  return s.units.find((u) => u.alive && u.id !== exceptId && sameHex(u.pos, h));
}

export function playerUnit(s: GameState): Unit | undefined {
  return s.units.find((u) => u.side === 'PLAYER');
}
