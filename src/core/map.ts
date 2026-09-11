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

/** 一格。地形目前不影響移動（先無視地形限制），elevation 與 blocksLos 留給日後的視線。 */
export interface Cell {
  terrain: string;
  elevation: number;
  blocksLos: boolean;
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

export interface RawMap {
  id: string;
  name: string;
  width: number;
  height: number;
  rows: string[];
  spawns: { player: Spawn; enemies?: Spawn[] };
  /** 有的話這張圖就是一條跑道（見 course.ts）。 */
  course?: { name?: string; chassis?: string; checkpoints: RawCheckpoint[] };
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
  course: Course | null;
  /** 跑道建議用的機體（新手教學會指定）；介面在沒有其他指定時採用。 */
  chassis: string | null;
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
        cells.push({ terrain: 'open', elevation: 0, blocksLos: false });
        continue;
      }
      const t = rules.terrain[id];
      cells.push({ terrain: id, elevation: t.elevation, blocksLos: t.blocksLos });
    }
  });

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
            return { ...h, when, type: String(h.type) };
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
    course,
    chassis,
  };

  if (errors.length === 0) {
    for (const s of [map.playerSpawn, ...map.enemySpawns]) {
      if (!cellAt(map, s.hex)) errors.push(`地圖 ${raw.id}：出生點 (${s.hex.q},${s.hex.r}) 在地圖外`);
    }
    course?.checkpoints.forEach((c, i) => {
      if (!cellAt(map, c.at)) errors.push(`地圖 ${raw.id}：檢查點 ${i + 1} 的中心在地圖外`);
    });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return map;
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
