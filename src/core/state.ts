/**
 * GameState 型別與唯讀選取器。
 *
 * 狀態只能經由 engine.ts 的 applyCommand() 改變。rules 與 map 是不可變的參照：
 * 複製狀態時不會跟著深複製，任何人都不得就地修改它們。
 */
import type { Dir, Hex, SubVec } from './hex';
import { sameHex, subToHex } from './hex';
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
  /** 位置，單位 1/SUB 格（§2）。 */
  posSub: SubVec;
  /** 速度，單位 1/SUB 格每回合（§2）。 */
  velSub: SubVec;
  /** 朝向，與速度完全獨立（§3.3）。 */
  facing: Dir;
  /** 這個階段還能用的 AP。階段結束時歸零 —— 配額不累積。 */
  ap: number;
  /** AP 債務（§4.1）。 */
  debt: number;
  heat: number;
  /** 還要停機幾個自己的階段（§4.2）。 */
  shutdown: number;
  /** 這個階段已經轉了幾面（算免費額度用）。 */
  facesTurned: number;
  /** 已宣告、尚未解算的加速（循序制下只會存在一瞬間）。 */
  pendingAccel: AccelChoice | null;
  alive: boolean;
}

/** 加速宣告（§3.1 第 1 步）。 */
export type AccelChoice =
  | { kind: 'DIR'; dir: Dir }
  | { kind: 'CRUISE' }
  | { kind: 'BRAKE' };

/**
 * 一回合拆成的步驟（§5）。順序由 order.ts 的解算順序模組決定。
 *
 * - DECLARE：等這個單位宣告加速
 * - MOVE：解算列出單位的位移（自動）
 * - ACT：等這個單位做行動，直到它待機
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
  | { type: 'ACCEL'; choice: AccelChoice }
  | { type: 'TURN'; delta: 1 | -1 }
  | { type: 'COOL' }
  | { type: 'SWITCH_DRIVE' }
  | { type: 'WAIT' };

export type Blocker = 'EDGE' | 'TERRAIN' | 'UNIT';

export interface Collision {
  /** 撞上的那一格（沒進去）。 */
  at: Hex;
  blocker: Blocker;
  unitId?: string;
  /** 撞擊前的速度（sub/回合）。§11.6 撞擊傷害的掛勾。 */
  speed: number;
}

export type GameEvent =
  | { type: 'ROUND'; round: number }
  | { type: 'PHASE'; unitId: string }
  | {
      type: 'MOVED';
      unitId: string;
      choice: AccelChoice;
      from: SubVec;
      to: SubVec;
      velSub: SubVec;
      /** 舊格 → 新格的六角直線（含起點）。動畫走這條。 */
      path: Hex[];
    }
  | { type: 'COLLIDED'; unitId: string; collision: Collision }
  | { type: 'TURNED'; unitId: string; from: Dir; to: Dir }
  | { type: 'COOLED'; unitId: string; heat: number }
  | { type: 'DRIVE'; unitId: string; drive: string }
  | { type: 'OVERHEAT'; unitId: string }
  | { type: 'REBOOT'; unitId: string }
  | { type: 'WAITED'; unitId: string };

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

export function unitHex(u: Unit): Hex {
  return subToHex(u.posSub);
}

/** 這一格上的其他存活單位。 */
export function unitAt(s: GameState, h: Hex, exceptId?: string): Unit | undefined {
  return s.units.find((u) => u.alive && u.id !== exceptId && sameHex(unitHex(u), h));
}

export function playerUnit(s: GameState): Unit | undefined {
  return s.units.find((u) => u.side === 'PLAYER');
}
