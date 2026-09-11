/**
 * 規則資料（§10）：把 data/*.json 讀成有型別的表。
 *
 * **所有平衡數值都從這裡來**（§1）。core/ 其他檔案一律透過 GameState.rules 取值，
 * 不直接 import JSON —— 這樣 bot 可以拿兩份不同的 Rules 做 A/B，
 * 介面的調參面板也只是「換一份 Rules」而已。
 *
 * JSON 裡以 `_` 開頭的鍵是給人看的註解，讀取時略過。
 */
import drivesJson from '../data/drives.json';
import chassisJson from '../data/chassis.json';
import actionsJson from '../data/actions.json';
import terrainJson from '../data/terrain.json';
import combatJson from '../data/combat.json';
import { SUB } from './hex';

export interface TurnRule {
  /** 每回合免費轉幾面。'ANY' = 不限。 */
  freeFacesPerTurn: number | 'ANY';
}

export interface DriveDef {
  id: string;
  name: string;
  thrust: number;
  drag: number;
  maxSpeed: number;
  turnRule: TurnRule;
  /** 能否往前方三面以外加速（§3.2）。 */
  sideAccel: boolean;
  /** 每 10 sub 的實際加速量產生多少熱。 */
  heatPerAccel: number;
}

export interface ChassisDef {
  id: string;
  name: string;
  mass: number;
  /** 第一個是出擊時的驅動模式。 */
  drives: string[];
  apQuota: number;
  heatCap: number;
  heatPassive: number;
  sensorRange: number;
  /** ui.json 的座艙 id。core/ 不解讀。 */
  cockpit: string;
}

export type ActionId =
  | 'wait' | 'lock' | 'fireLight' | 'fireHeavy' | 'reload' | 'swap'
  | 'cool' | 'switchDrive' | 'turn';

export const ACTION_IDS: readonly ActionId[] = [
  'wait', 'lock', 'fireLight', 'fireHeavy', 'reload', 'swap', 'cool', 'switchDrive', 'turn',
];

/** 前置條件代號。WEAPON = 需要武器（第 5 步）；MULTI_DRIVE = 機體有兩種以上驅動。 */
export type Requirement = 'WEAPON' | 'MULTI_DRIVE';

export interface ActionDef {
  id: ActionId;
  name: string;
  ap: number;
  heat: number;
  requires: Requirement[];
}

export interface EconomyDef {
  apDebtCap: number;
  overheatShutdownPhases: number;
}

export interface TerrainDef {
  id: string;
  name: string;
  glyph: string;
  passable: boolean;
  blocksLos: boolean;
  elevation: number;
  dragModifier: number;
  sensorBonus: number;
}

export interface CombatDef {
  baseHit: number;
  k1: number;
  k2: number;
  stableBonus: number;
  heatPenalty: number;
  heatPenaltyAbove: number;
  debtPenalty: number;
  rangeFalloff: unknown;
}

export interface Rules {
  drives: Record<string, DriveDef>;
  chassis: Record<string, ChassisDef>;
  actions: Record<ActionId, ActionDef>;
  economy: EconomyDef;
  terrain: Record<string, TerrainDef>;
  combat: CombatDef;
}

/** 讀檔用的原始形狀：各表都是 { id: {...} }，外加 `_` 註解鍵。 */
export interface RawRules {
  drives: Record<string, unknown>;
  chassis: Record<string, unknown>;
  actions: { economy: unknown; actions: Record<string, unknown> };
  terrain: Record<string, unknown>;
  combat: Record<string, unknown>;
}

export const RAW_RULES: RawRules = {
  drives: drivesJson,
  chassis: chassisJson,
  actions: actionsJson,
  terrain: terrainJson,
  combat: combatJson,
};

/** 去掉 `_` 註解鍵。 */
function entries(o: Record<string, unknown>): [string, Record<string, unknown>][] {
  return Object.entries(o)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => [k, v as Record<string, unknown>]);
}

function strip<T>(o: Record<string, unknown>, id: string): T {
  const out: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) out[k] = v;
  return out as T;
}

/**
 * 把原始 JSON 轉成 Rules，並驗證。資料有問題就丟出一個列出**所有**問題的例外 ——
 * 調參時一次看到全部錯誤，而不是改一個、重新整理、再看下一個。
 */
export function loadRules(raw: RawRules): Rules {
  const errors: string[] = [];
  const num = (where: string, v: unknown, min = -Infinity): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
      errors.push(`${where} 必須是 ≥ ${min} 的數字（現在是 ${JSON.stringify(v)}）`);
    }
  };
  const bool = (where: string, v: unknown): void => {
    if (typeof v !== 'boolean') errors.push(`${where} 必須是 true/false`);
  };
  /** 會拿去當「長度」用的值必須是整數 sub：scaleToLength 的不超長保證依賴這一點。 */
  const int = (where: string, v: unknown, min = -Infinity): void => {
    num(where, v, min);
    if (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) errors.push(`${where} 必須是整數`);
  };

  const drives: Record<string, DriveDef> = {};
  for (const [id, o] of entries(raw.drives)) {
    const d = strip<DriveDef>(o, id);
    num(`drives.${id}.thrust`, d.thrust, 0);
    int(`drives.${id}.drag`, d.drag, 0);
    int(`drives.${id}.maxSpeed`, d.maxSpeed, 0);
    num(`drives.${id}.heatPerAccel`, d.heatPerAccel, 0);
    bool(`drives.${id}.sideAccel`, d.sideAccel);
    const free = d.turnRule?.freeFacesPerTurn;
    if (free !== 'ANY') num(`drives.${id}.turnRule.freeFacesPerTurn`, free, 0);
    drives[id] = d;
  }

  const chassis: Record<string, ChassisDef> = {};
  for (const [id, o] of entries(raw.chassis)) {
    const c = strip<ChassisDef>(o, id);
    num(`chassis.${id}.mass`, c.mass, 1);
    num(`chassis.${id}.apQuota`, c.apQuota, 0);
    num(`chassis.${id}.heatCap`, c.heatCap, 1);
    num(`chassis.${id}.heatPassive`, c.heatPassive, 0);
    num(`chassis.${id}.sensorRange`, c.sensorRange, 0);
    if (!Array.isArray(c.drives) || c.drives.length === 0) {
      errors.push(`chassis.${id}.drives 至少要有一種驅動`);
    } else {
      for (const d of c.drives) {
        if (!drives[d]) errors.push(`chassis.${id}.drives 指向不存在的驅動 "${d}"`);
      }
    }
    chassis[id] = c;
  }

  const actions = {} as Record<ActionId, ActionDef>;
  const rawActions = raw.actions.actions;
  for (const id of ACTION_IDS) {
    const o = rawActions[id] as Record<string, unknown> | undefined;
    if (!o) {
      errors.push(`actions.${id} 缺少定義`);
      continue;
    }
    const a = strip<ActionDef>(o, id);
    a.requires = a.requires ?? [];
    num(`actions.${id}.ap`, a.ap, 0);
    num(`actions.${id}.heat`, a.heat);
    actions[id] = a;
  }

  const economy = strip<EconomyDef>(raw.actions.economy as Record<string, unknown>, 'economy');
  num('economy.apDebtCap', economy.apDebtCap, 0);
  num('economy.overheatShutdownPhases', economy.overheatShutdownPhases, 1);
  delete (economy as unknown as Record<string, unknown>).id;

  const terrain: Record<string, TerrainDef> = {};
  const glyphs = new Set<string>();
  for (const [id, o] of entries(raw.terrain)) {
    const t = strip<TerrainDef>(o, id);
    if (typeof t.glyph !== 'string' || t.glyph.length !== 1) {
      errors.push(`terrain.${id}.glyph 必須是單一字元`);
    } else if (glyphs.has(t.glyph)) {
      errors.push(`terrain.${id}.glyph "${t.glyph}" 與其他地形重複`);
    }
    glyphs.add(t.glyph);
    bool(`terrain.${id}.passable`, t.passable);
    bool(`terrain.${id}.blocksLos`, t.blocksLos);
    int(`terrain.${id}.elevation`, t.elevation);
    int(`terrain.${id}.dragModifier`, t.dragModifier);
    terrain[id] = t;
  }

  const combat = strip<CombatDef>(raw.combat, 'combat');
  delete (combat as unknown as Record<string, unknown>).id;

  if (errors.length) throw new Error('規則資料有誤：\n  ' + errors.join('\n  '));
  return { drives, chassis, actions, economy, terrain, combat };
}

/** data/*.json 讀進來的預設規則。 */
export const RULES: Rules = loadRules(RAW_RULES);

// ---------------------------------------------------------------- 覆寫

/** 深層部分覆寫：調參面板與 bot 的 A/B 用。 */
export type RulesPatch = {
  drives?: Record<string, Partial<Omit<DriveDef, 'id'>>>;
  chassis?: Record<string, Partial<Omit<ChassisDef, 'id'>>>;
  terrain?: Record<string, Partial<Omit<TerrainDef, 'id'>>>;
  economy?: Partial<EconomyDef>;
};

/** 回傳一份套用過覆寫的新 Rules；不改動傳入的物件。指向不存在的 id 的覆寫會被忽略。 */
export function withPatch(base: Rules, patch: RulesPatch): Rules {
  const next: Rules = structuredClone(base);
  const merge = <T extends object>(table: Record<string, T>, p?: Record<string, Partial<T>>): void => {
    if (!p) return;
    for (const [id, fields] of Object.entries(p)) {
      if (table[id]) Object.assign(table[id], fields);
    }
  };
  merge(next.drives, patch.drives);
  merge(next.chassis, patch.chassis);
  merge(next.terrain, patch.terrain);
  if (patch.economy) Object.assign(next.economy, patch.economy);
  return next;
}

// ---------------------------------------------------------------- 衍生值

/** §3.2：`accel = round(thrust / mass × SUB)`。 */
export function accelOf(rules: Rules, chassisId: string, driveId: string): number {
  return Math.round((rules.drives[driveId].thrust / rules.chassis[chassisId].mass) * SUB);
}
