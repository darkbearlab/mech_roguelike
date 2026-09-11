/**
 * 規則資料：把 data/*.json 讀成有型別的表。
 *
 * **所有平衡數值都從這裡來**。core/ 其他檔案一律透過 GameState.rules 取值，
 * 不直接 import JSON —— 這樣 bot 可以拿兩份不同的 Rules 做 A/B，
 * 介面的調參面板也只是「換一份 Rules」而已。
 *
 * JSON 裡以 `_` 開頭的鍵是給人看的註解，讀取時略過。
 */
import drivesJson from '../data/drives.json';
import chassisJson from '../data/chassis.json';
import weaponsJson from '../data/weapons.json';
import fireControlsJson from '../data/fireControls.json';
import actionsJson from '../data/actions.json';
import terrainJson from '../data/terrain.json';
import combatJson from '../data/combat.json';

export interface TurnRule {
  /** 每回合免費轉幾面。'ANY' = 不限。 */
  freeFacesPerTurn: number | 'ANY';
}

/** 相對機首的四個扇區：前、左右前（偏 60°）、左右後（偏 120°）、正後。 */
export type Sector = 'front' | 'frontSide' | 'rearSide' | 'rear';

export const SECTORS: readonly Sector[] = ['front', 'frontSide', 'rearSide', 'rear'];

export interface DriveDef {
  id: string;
  name: string;
  /** 極速（格/回合）。 */
  maxSpeed: number;
  /** 左盤每個扇區最多能點幾下。 */
  taps: Record<Sector, number>;
  /** 速度方向改變 60° / 120° 時的折損。 */
  turnLoss: { d60: number; d120: number };
  /** 沒有加速的回合，速度自然減少多少。 */
  decay: number;
  /** 右盤每轉一面，當下速度扣多少。 */
  facingTurnSpeedLoss: number;
  turnRule: TurnRule;
  /** 左盤每點一下的產熱。 */
  heatPerTap: number;
}

export interface ChassisDef {
  id: string;
  name: string;
  /** PILOT = 玩家可以選來開的機體；TARGET = 靶；ENEMY = 只當敵人的機體（例如地城的輕戰車）。後兩種只會出現在地圖上。 */
  role: 'PILOT' | 'TARGET' | 'ENEMY';
  /** 第一個是出擊時的驅動模式。 */
  drives: string[];
  apQuota: number;
  heatCap: number;
  heatPassive: number;
  sensorRange: number;
  hp: number;
  /** weapons.json 的 id；null = 沒有武器。 */
  weapon: string | null;
  /** fireControls.json 的 id；有武器就一定要有。 */
  fireControl: string | null;
  /** ui.json 的座艙 id。core/ 不解讀。 */
  cockpit: string;
}

/** 一次行動的成本。 */
export interface Cost {
  ap: number;
  heat: number;
}

/**
 * 火控系統。命中率的基礎是「火控 × 武器類別」的適性，不是武器本身的命中
 * （設計者：聽起來荒謬，但比較好平衡 —— 只要看一張表）。
 */
export interface FireControlDef {
  id: string;
  name: string;
  /** 相對速度每 1 格/回合扣幾點（算提前量是火控的工作）。 */
  tracking: number;
  /** 以武器 category 為鍵的適性（點數，75 = 75%）。 */
  aptitude: Record<string, number>;
}

export interface WeaponDef {
  id: string;
  name: string;
  /** 武器類別：火控的適性以它為鍵。 */
  category: string;
  /** 射程（格）。 */
  range: number;
  /** 有利射程 [min, max]（含兩端）與在這個距離內的命中加成。 */
  optimal: { min: number; max: number; bonus: number };
  /** 射界總角度，以機首為中心。180 = 前方半平面。 */
  arcDegrees: number;
  /** 依偏離機首的角度扣的命中點數，每 30° 一格；超出表格的角度用最後一格。 */
  arcPenalty: number[];
  /** 重量：自己的速度每 1 格/回合扣幾點（越重的武器高速時越不準）。 */
  weight: number;
  damage: number;
  magazine: number;
  fire: Cost;
  reload: Cost;
}

export type ActionId = 'wait' | 'lock' | 'swap' | 'cool' | 'switchDrive' | 'turn';

export const ACTION_IDS: readonly ActionId[] = ['wait', 'lock', 'swap', 'cool', 'switchDrive', 'turn'];

/** 前置條件代號。WEAPON = 需要武器；MULTI_DRIVE = 機體有兩種以上驅動。 */
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
  /** 熱量警戒線（佔上限的比例）。目前只影響儀表顏色與 bot 的散熱判斷。 */
  heatWarnAbove: number;
}

/**
 * 地形。原本的地形（碎石、稜線、高地）照舊不影響移動；地城起有了開不進去的牆與殘骸。
 */
export interface TerrainDef {
  id: string;
  name: string;
  glyph: string;
  elevation: number;
  /** 擋視線（全掩體）。 */
  blocksLos: boolean;
  /** false = 開不進去（撞上就停）。預設 true。 */
  passable: boolean;
  /** 半掩體：視線上緊貼目標的那一格是這種地形時，命中扣幾點。預設 0。 */
  cover: number;
}

export interface CombatDef {
  /** 命中率的下限與上限（點數）。 */
  minHit: number;
  maxHit: number;
}

export interface Rules {
  drives: Record<string, DriveDef>;
  chassis: Record<string, ChassisDef>;
  weapons: Record<string, WeaponDef>;
  fireControls: Record<string, FireControlDef>;
  actions: Record<ActionId, ActionDef>;
  economy: EconomyDef;
  terrain: Record<string, TerrainDef>;
  combat: CombatDef;
}

/** 讀檔用的原始形狀：各表都是 { id: {...} }，外加 `_` 註解鍵。 */
export interface RawRules {
  drives: Record<string, unknown>;
  chassis: Record<string, unknown>;
  weapons: Record<string, unknown>;
  fireControls: Record<string, unknown>;
  actions: { economy: unknown; actions: Record<string, unknown> };
  terrain: Record<string, unknown>;
  combat: Record<string, unknown>;
}

export const RAW_RULES: RawRules = {
  drives: drivesJson,
  chassis: chassisJson,
  weapons: weaponsJson,
  fireControls: fireControlsJson,
  actions: actionsJson,
  terrain: terrainJson,
  combat: combatJson,
};

/** 去掉 `_` 註解鍵（只看第一層）。 */
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
  /** 速度、點數、折損都是「格」，一律整數。 */
  const int = (where: string, v: unknown, min = -Infinity): void => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
      errors.push(`${where} 必須是 ≥ ${min} 的整數（現在是 ${JSON.stringify(v)}）`);
    }
  };
  const num = (where: string, v: unknown, min = -Infinity): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
      errors.push(`${where} 必須是 ≥ ${min} 的數字（現在是 ${JSON.stringify(v)}）`);
    }
  };
  const bool = (where: string, v: unknown): void => {
    if (typeof v !== 'boolean') errors.push(`${where} 必須是 true/false`);
  };

  const drives: Record<string, DriveDef> = {};
  for (const [id, o] of entries(raw.drives)) {
    const d = strip<DriveDef>(o, id);
    int(`drives.${id}.maxSpeed`, d.maxSpeed, 0);
    for (const s of SECTORS) int(`drives.${id}.taps.${s}`, d.taps?.[s], 0);
    int(`drives.${id}.turnLoss.d60`, d.turnLoss?.d60, 0);
    int(`drives.${id}.turnLoss.d120`, d.turnLoss?.d120, 0);
    int(`drives.${id}.decay`, d.decay, 0);
    int(`drives.${id}.facingTurnSpeedLoss`, d.facingTurnSpeedLoss, 0);
    num(`drives.${id}.heatPerTap`, d.heatPerTap, 0);
    const free = d.turnRule?.freeFacesPerTurn;
    if (free !== 'ANY') int(`drives.${id}.turnRule.freeFacesPerTurn`, free, 0);
    drives[id] = d;
  }

  const weapons: Record<string, WeaponDef> = {};
  for (const [id, o] of entries(raw.weapons)) {
    const w = strip<WeaponDef>(o, id);
    int(`weapons.${id}.range`, w.range, 1);
    num(`weapons.${id}.arcDegrees`, w.arcDegrees, 0);
    if (typeof w.arcDegrees === 'number' && w.arcDegrees > 360) errors.push(`weapons.${id}.arcDegrees 不能超過 360`);
    if (!Array.isArray(w.arcPenalty) || w.arcPenalty.length === 0) errors.push(`weapons.${id}.arcPenalty 至少要有一格`);
    else w.arcPenalty.forEach((p, i) => num(`weapons.${id}.arcPenalty[${i}]`, p));
    if (typeof w.category !== 'string' || !w.category) errors.push(`weapons.${id}.category 必須是非空字串`);
    int(`weapons.${id}.optimal.min`, w.optimal?.min, 0);
    int(`weapons.${id}.optimal.max`, w.optimal?.max, 0);
    num(`weapons.${id}.optimal.bonus`, w.optimal?.bonus);
    if (w.optimal && (w.optimal.min > w.optimal.max || w.optimal.max > w.range)) {
      errors.push(`weapons.${id}.optimal 必須是 min ≤ max ≤ range（現在是 ${w.optimal.min}–${w.optimal.max}，射程 ${w.range}）`);
    }
    num(`weapons.${id}.weight`, w.weight, 0);
    num(`weapons.${id}.damage`, w.damage, 0);
    int(`weapons.${id}.magazine`, w.magazine, 1);
    for (const k of ['fire', 'reload'] as const) {
      int(`weapons.${id}.${k}.ap`, w[k]?.ap, 0);
      num(`weapons.${id}.${k}.heat`, w[k]?.heat);
    }
    weapons[id] = w;
  }

  const fireControls: Record<string, FireControlDef> = {};
  for (const [id, o] of entries(raw.fireControls)) {
    const f = strip<FireControlDef>(o, id);
    num(`fireControls.${id}.tracking`, f.tracking, 0);
    if (!isPlain(f.aptitude)) errors.push(`fireControls.${id}.aptitude 必須是 { 武器類別: 點數 }`);
    else for (const [cat, v] of Object.entries(f.aptitude)) num(`fireControls.${id}.aptitude.${cat}`, v);
    fireControls[id] = f;
  }

  const chassis: Record<string, ChassisDef> = {};
  for (const [id, o] of entries(raw.chassis)) {
    const c = strip<ChassisDef>(o, id);
    c.role = c.role ?? 'PILOT';
    if (c.role !== 'PILOT' && c.role !== 'TARGET' && c.role !== 'ENEMY') errors.push(`chassis.${id}.role 必須是 PILOT、TARGET 或 ENEMY`);
    int(`chassis.${id}.apQuota`, c.apQuota, 0);
    num(`chassis.${id}.heatCap`, c.heatCap, 1);
    num(`chassis.${id}.heatPassive`, c.heatPassive, 0);
    num(`chassis.${id}.sensorRange`, c.sensorRange, 0);
    num(`chassis.${id}.hp`, c.hp, 1);
    c.weapon = c.weapon ?? null;
    c.fireControl = c.fireControl ?? null;
    const w = c.weapon === null ? null : weapons[c.weapon];
    const fc = c.fireControl === null ? null : fireControls[c.fireControl];
    if (w === undefined) errors.push(`chassis.${id}.weapon 指向不存在的武器 "${c.weapon}"`);
    if (fc === undefined) errors.push(`chassis.${id}.fireControl 指向不存在的火控 "${c.fireControl}"`);
    if (w && fc === null) errors.push(`chassis.${id} 有武器就要有火控（fireControl）`);
    if (w && fc && isPlain(fc.aptitude) && typeof fc.aptitude[w.category] !== 'number') {
      errors.push(`chassis.${id}：火控 "${fc.id}" 沒有 ${w.name}（${w.category}）的適性`);
    }
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
    int(`actions.${id}.ap`, a.ap, 0);
    num(`actions.${id}.heat`, a.heat);
    actions[id] = a;
  }

  const economy = strip<EconomyDef>(raw.actions.economy as Record<string, unknown>, 'economy');
  int('economy.apDebtCap', economy.apDebtCap, 0);
  int('economy.overheatShutdownPhases', economy.overheatShutdownPhases, 1);
  num('economy.heatWarnAbove', economy.heatWarnAbove, 0);
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
    bool(`terrain.${id}.blocksLos`, t.blocksLos);
    int(`terrain.${id}.elevation`, t.elevation);
    t.passable = t.passable ?? true;
    bool(`terrain.${id}.passable`, t.passable);
    t.cover = t.cover ?? 0;
    num(`terrain.${id}.cover`, t.cover, 0);
    terrain[id] = t;
  }

  const combat = strip<CombatDef>(raw.combat, 'combat');
  num('combat.minHit', combat.minHit, 0);
  num('combat.maxHit', combat.maxHit, 0);
  delete (combat as unknown as Record<string, unknown>).id;

  if (errors.length) throw new Error('規則資料有誤：\n  ' + errors.join('\n  '));
  return { drives, chassis, weapons, fireControls, actions, economy, terrain, combat };
}

/** data/*.json 讀進來的預設規則。 */
export const RULES: Rules = loadRules(RAW_RULES);

/** 玩家可以選來開的機體（靶不算）。 */
export function pilotChassis(rules: Rules): ChassisDef[] {
  return Object.values(rules.chassis).filter((c) => c.role === 'PILOT');
}

// ---------------------------------------------------------------- 覆寫

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** 深層部分覆寫：調參面板與 bot 的 A/B 用。 */
export type RulesPatch = {
  drives?: Record<string, DeepPartial<Omit<DriveDef, 'id'>>>;
  chassis?: Record<string, DeepPartial<Omit<ChassisDef, 'id'>>>;
  weapons?: Record<string, DeepPartial<Omit<WeaponDef, 'id'>>>;
  fireControls?: Record<string, DeepPartial<Omit<FireControlDef, 'id'>>>;
  terrain?: Record<string, DeepPartial<Omit<TerrainDef, 'id'>>>;
  economy?: Partial<EconomyDef>;
};

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 把 patch 逐層併進 target（就地）。陣列與純值整個取代。 */
function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (isPlain(v) && isPlain(target[k])) mergeInto(target[k] as Record<string, unknown>, v);
    else target[k] = v;
  }
}

/** 回傳一份套用過覆寫的新 Rules；不改動傳入的物件。指向不存在的 id 的覆寫會被忽略。 */
export function withPatch(base: Rules, patch: RulesPatch): Rules {
  const next: Rules = structuredClone(base);
  const merge = (table: Record<string, unknown>, p?: Record<string, unknown>): void => {
    if (!p) return;
    for (const [id, fields] of Object.entries(p)) {
      if (isPlain(table[id]) && isPlain(fields)) mergeInto(table[id] as Record<string, unknown>, fields);
    }
  };
  merge(next.drives, patch.drives);
  merge(next.chassis, patch.chassis);
  merge(next.weapons, patch.weapons);
  merge(next.fireControls, patch.fireControls);
  merge(next.terrain, patch.terrain);
  if (patch.economy) Object.assign(next.economy, patch.economy);
  return next;
}
