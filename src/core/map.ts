/**
 * 地圖。
 *
 * 檔案格式是「odd-q 位移座標」的逐列字串：第 row 列第 col 個字元就是那一格的地形字元，
 * 奇數欄往下錯半格 —— 這樣在文字編輯器裡改圖時，看到的形狀大致就是遊戲裡的形狀。
 * 讀進來之後一律轉成 axial (q, r)，core/ 其他地方不再碰位移座標。
 */
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

export interface RawMap {
  id: string;
  name: string;
  width: number;
  height: number;
  rows: string[];
  spawns: { player: Spawn; enemies?: Spawn[] };
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

  const map: GameMap = {
    id: raw.id,
    name: raw.name,
    width: raw.width,
    height: raw.height,
    cells,
    playerSpawn: { hex: offsetToHex(raw.spawns.player.col, raw.spawns.player.row), facing: raw.spawns.player.facing },
    enemySpawns: (raw.spawns.enemies ?? []).map((s) => ({ hex: offsetToHex(s.col, s.row), facing: s.facing })),
  };

  if (errors.length === 0) {
    for (const s of [map.playerSpawn, ...map.enemySpawns]) {
      if (!cellAt(map, s.hex)) errors.push(`地圖 ${raw.id}：出生點 (${s.hex.q},${s.hex.r}) 在地圖外`);
    }
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
