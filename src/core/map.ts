/**
 * 地圖。
 *
 * 檔案格式是「odd-q 位移座標」的逐列字串：第 row 列第 col 個字元就是那一格的地形字元，
 * 奇數欄往下錯半格 —— 這樣在文字編輯器裡改圖時，看到的形狀大致就是遊戲裡的形狀。
 * 讀進來之後一律轉成 axial (q, r)，core/ 其他地方不再碰位移座標。
 */
import type { Course, CourseHook, HookWhen } from './course';
import type { Dir, Hex } from './hex';
import { vec } from './hex';
import type { Rules } from './rules';
import type { Script } from './state';

/** 一格：地形、能不能走、擋不擋視線、半掩體扣幾點（照 terrain.json）。 */
export interface Cell {
  terrain: string;
  elevation: number;
  blocksLos: boolean;
  passable: boolean;
  cover: number;
}

export interface Spawn {
  col: number;
  row: number;
  facing: Dir;
}

/** 地圖檔裡的檢查點：位移座標的中心格 + 半徑，外加提示與事件鉤子。 */
export interface RawCheckpoint {
  id?: string;
  type: string;
  col: number;
  row: number;
  radius?: number;
  hint?: string;
  /** 事件鉤子：{ when?: 'REACH' | 'ACTIVATE', type: string, ...其他欄位 }。 */
  hooks?: Record<string, unknown>[];
}

/**
 * 地圖檔裡的自動單位：開局就在場的寫在 units；跑到某個檢查點才出現的，
 * 用檢查點的 SPAWN 鉤子帶同樣的欄位。
 * - patrol：巡邏點（位移座標）
 * - ai: 'DUEL'：敵機，跟玩家用同一套規則移動、射擊（ai.ts）
 * - ai: 'GUARD'：守衛，發現你（或被打）之前原地不動，醒了就照 DUEL 打
 * 都沒有就是原地不動。
 */
export interface RawUnit {
  id?: string;
  chassis: string;
  col: number;
  row: number;
  facing?: Dir;
  patrol?: [number, number][];
  ai?: string;
}

/** 讀進來、轉成 axial 的自動單位。 */
export interface UnitSpawn {
  id?: string;
  chassis: string;
  hex: Hex;
  facing: Dir;
  script: Script;
}

export interface RawMap {
  id: string;
  name: string;
  width: number;
  height: number;
  rows: string[];
  spawns: { player: Spawn; enemies?: Spawn[] };
  /** 開局就在場的自動單位（靶）。 */
  units?: RawUnit[];
  /** 有的話這張圖就是一條跑道（見 course.ts）。 */
  course?: { name?: string; chassis?: string; checkpoints: RawCheckpoint[] };
  /** 沒有跑道的地圖（決鬥場之類）在畫面上方那一行顯示的說明。 */
  brief?: string;
}

export interface GameMap {
  id: string;
  name: string;
  width: number;
  height: number;
  /** 以位移座標 row * width + col 索引。 */
  cells: Cell[];
  playerSpawn: { hex: Hex; facing: Dir };
  enemySpawns: { hex: Hex; facing: Dir }[];
  units: UnitSpawn[];
  course: Course | null;
  /** 跑道建議用的機體（新手教學會指定）；介面在沒有其他指定時採用。 */
  chassis: string | null;
  brief: string | null;
}

/** odd-q 位移座標 → axial。 */
export function offsetToHex(col: number, row: number): Hex {
  return vec(col, row - (col - (col & 1)) / 2);
}

/** axial → odd-q 位移座標。 */
export function hexToOffset(h: Hex): { col: number; row: number } {
  return { col: h.q, row: h.r + (h.q - (h.q & 1)) / 2 };
}

/** 讀圖並驗證：尺寸、未知字元、出生點必須在地圖內。 */
export function loadMap(rules: Rules, raw: RawMap): GameMap {
  const errors: string[] = [];
  const byGlyph = new Map<string, string>();
  for (const t of Object.values(rules.terrain)) byGlyph.set(t.glyph, t.id);

  if (raw.rows.length !== raw.height) {
    errors.push(`地圖 ${raw.id}：height=${raw.height} 但有 ${raw.rows.length} 列`);
  }
  const cells: Cell[] = [];
  raw.rows.forEach((line, row) => {
    if (line.length !== raw.width) {
      errors.push(`地圖 ${raw.id}：第 ${row} 列長度 ${line.length}，應為 ${raw.width}`);
    }
    for (let col = 0; col < raw.width; col++) {
      const g = line[col] ?? '';
      const id = byGlyph.get(g);
      if (!id) {
        errors.push(`地圖 ${raw.id}：(${col},${row}) 是未知的地形字元 "${g}"`);
        cells.push({ terrain: 'open', elevation: 0, blocksLos: false, passable: true, cover: 0 });
        continue;
      }
      const t = rules.terrain[id];
      cells.push({ terrain: id, elevation: t.elevation, blocksLos: t.blocksLos, passable: t.passable, cover: t.cover });
    }
  });

  /** 自動單位（靶、敵機）：開局的 units 與 SPAWN 鉤子共用同一個格式。 */
  const toSpawn = (u: RawUnit, where: string): UnitSpawn => {
    if (!rules.chassis[u.chassis]) errors.push(`地圖 ${raw.id}：${where} 的機體 "${u.chassis}" 不存在`);
    if (u.ai !== undefined && u.ai !== 'DUEL' && u.ai !== 'GUARD') {
      errors.push(`地圖 ${raw.id}：${where} 的 ai 只能是 DUEL 或 GUARD（現在是 "${u.ai}"）`);
    }
    const script: Script = u.patrol && u.patrol.length > 0
      ? { kind: 'PATROL', points: u.patrol.map(([c, r]) => offsetToHex(c, r)), next: 0 }
      : u.ai === 'DUEL' ? { kind: 'DUEL' } : u.ai === 'GUARD' ? { kind: 'GUARD', awake: false } : { kind: 'IDLE' };
    const spawn: UnitSpawn = { chassis: u.chassis, hex: offsetToHex(u.col, u.row), facing: u.facing ?? 3, script };
    if (u.id !== undefined) spawn.id = u.id;
    return spawn;
  };
  const units = (raw.units ?? []).map((u, i) => toSpawn(u, `units[${i}]`));
  const spawnPlaces: { where: string; spawn: UnitSpawn }[] = units.map((spawn, i) => ({ where: `units[${i}]`, spawn }));

  const course: Course | null = raw.course
    ? {
        name: raw.course.name ?? raw.name,
        checkpoints: raw.course.checkpoints.map((c, i) => {
          if (c.type !== 'PASS' && c.type !== 'STOP') {
            errors.push(`地圖 ${raw.id}：檢查點 ${i + 1} 的 type 必須是 PASS 或 STOP（現在是 "${c.type}"）`);
          }
          const radius = c.radius ?? 1;
          if (!Number.isInteger(radius) || radius < 0) errors.push(`地圖 ${raw.id}：檢查點 ${i + 1} 的 radius 必須是 ≥ 0 的整數`);
          const hooks: CourseHook[] = (c.hooks ?? []).map((h, j) => {
            const when = (h.when ?? 'REACH') as HookWhen;
            if (when !== 'REACH' && when !== 'ACTIVATE') {
              errors.push(`地圖 ${raw.id}：檢查點 ${i + 1} 的鉤子 ${j + 1} 的 when 必須是 REACH 或 ACTIVATE`);
            }
            if (typeof h.type !== 'string' || h.type === '') {
              errors.push(`地圖 ${raw.id}：檢查點 ${i + 1} 的鉤子 ${j + 1} 缺少 type`);
            }
            const hook: CourseHook = { ...h, when, type: String(h.type) };
            // SPAWN 是 core 自己會處理的鉤子：讀圖時先驗證、轉成 axial，放在 spawn 欄位
            if (hook.type === 'SPAWN') {
              const where = `檢查點 ${i + 1} 的 SPAWN 鉤子`;
              hook.spawn = toSpawn(h as unknown as RawUnit, where);
              spawnPlaces.push({ where, spawn: hook.spawn as UnitSpawn });
            }
            return hook;
          });
          return {
            id: c.id ?? `cp${i + 1}`,
            type: c.type as 'PASS' | 'STOP',
            at: offsetToHex(c.col, c.row),
            radius,
            hint: c.hint ?? '',
            hooks,
          };
        }),
      }
    : null;
  if (course && course.checkpoints.length === 0) errors.push(`地圖 ${raw.id}：跑道至少要有一個檢查點`);
  const ids = new Set<string>();
  for (const c of course?.checkpoints ?? []) {
    if (ids.has(c.id)) errors.push(`地圖 ${raw.id}：檢查點 id "${c.id}" 重複`);
    ids.add(c.id);
  }
  const chassis = raw.course?.chassis ?? null;
  if (chassis !== null && !rules.chassis[chassis]) errors.push(`地圖 ${raw.id}：跑道指定的機體 "${chassis}" 不存在`);

  const map: GameMap = {
    id: raw.id,
    name: raw.name,
    width: raw.width,
    height: raw.height,
    cells,
    playerSpawn: { hex: offsetToHex(raw.spawns.player.col, raw.spawns.player.row), facing: raw.spawns.player.facing },
    enemySpawns: (raw.spawns.enemies ?? []).map((s) => ({ hex: offsetToHex(s.col, s.row), facing: s.facing })),
    units,
    course,
    chassis,
    brief: raw.brief ?? null,
  };

  if (errors.length === 0) {
    for (const s of [map.playerSpawn, ...map.enemySpawns]) {
      if (!cellAt(map, s.hex)) errors.push(`地圖 ${raw.id}：出生點 (${s.hex.q},${s.hex.r}) 在地圖外`);
    }
    course?.checkpoints.forEach((c, i) => {
      if (!cellAt(map, c.at)) errors.push(`地圖 ${raw.id}：檢查點 ${i + 1} 的中心在地圖外`);
    });
    if (cellAt(map, map.playerSpawn.hex)?.passable === false) errors.push(`地圖 ${raw.id}：玩家出生點在開不進去的格子上`);
    for (const { where, spawn } of spawnPlaces) {
      const cell = cellAt(map, spawn.hex);
      if (!cell) errors.push(`地圖 ${raw.id}：${where} 的位置在地圖外`);
      else if (!cell.passable) errors.push(`地圖 ${raw.id}：${where} 站在開不進去的格子上`);
      if (spawn.script.kind === 'PATROL' && spawn.script.points.some((p) => !cellAt(map, p))) {
        errors.push(`地圖 ${raw.id}：${where} 的巡邏點在地圖外`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return map;
}

/** 敵機（DUEL）的 id，依地圖上的順序。 */
export function duelists(map: GameMap): string[] {
  return map.units.filter((u) => u.script.kind === 'DUEL').map((u) => u.id ?? u.chassis);
}

/**
 * 換掉地圖上某台自動單位的機體（決鬥場換對手用）。回傳新的地圖，不改動傳入的。
 * 找不到這個 id、或機體不存在就原樣回傳。
 */
export function withUnitChassis(rules: Rules, map: GameMap, unitId: string, chassis: string): GameMap {
  if (!rules.chassis[chassis]) return map;
  return { ...map, units: map.units.map((u) => ((u.id ?? u.chassis) === unitId ? { ...u, chassis } : u)) };
}

/** 地圖外回傳 null。 */
export function cellAt(map: GameMap, h: Hex): Cell | null {
  const { col, row } = hexToOffset(h);
  if (col < 0 || col >= map.width || row < 0 || row >= map.height) return null;
  return map.cells[row * map.width + col];
}

/** 全部格子（axial），依位移座標順序。render 與 bot 用。 */
export function allHexes(map: GameMap): Hex[] {
  const out: Hex[] = [];
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) out.push(offsetToHex(col, row));
  }
  return out;
}
