import { describe, expect, it } from 'vitest';
import { RAW_MAPS, rawMapById } from '../src/core/content';
import { allHexes, cellAt, hexToOffset, loadMap, offsetToHex } from '../src/core/map';
import { RULES } from '../src/core/rules';
import { flatRaw } from './helpers';

describe('§8 地圖', () => {
  it('位移座標 ↔ axial 往返不變', () => {
    for (let col = 0; col < 12; col++) for (let row = 0; row < 12; row++) {
      expect(hexToOffset(offsetToHex(col, row))).toEqual({ col, row });
    }
  });

  it('奇數欄往下錯半格：奇數欄 (1,0) 的東南鄰居是 (2,1)，偶數欄 (2,0) 的東南鄰居是 (3,0)', () => {
    const a = offsetToHex(1, 0);
    expect(hexToOffset({ q: a.q + 1, r: a.r })).toEqual({ col: 2, row: 1 });
    const b = offsetToHex(2, 0);
    expect(hexToOffset({ q: b.q + 1, r: b.r })).toEqual({ col: 3, row: 0 });
  });

  it('試驗場讀得進來：40×40、出生點都可進入、四種地形都有', () => {
    const raw = rawMapById('proving_ground')!;
    const m = loadMap(RULES, raw);
    expect([m.width, m.height, m.cells.length]).toEqual([40, 40, 1600]);
    for (const s of [m.playerSpawn, ...m.enemySpawns]) expect(cellAt(m, s.hex)?.passable).toBe(true);
    expect(new Set(m.cells.map((c) => c.terrain))).toEqual(new Set(['open', 'rubble', 'ridge', 'highland']));
    expect(m.enemySpawns).toHaveLength(3);
    expect(RAW_MAPS.map((r) => r.id)).toContain('proving_ground');
    expect(rawMapById('nope')).toBeUndefined();
  });

  it('格子帶著地形的高度、阻力、通行與視線屬性', () => {
    const m = loadMap(RULES, flatRaw(5, 5, [[1, 1, ','], [3, 1, '#'], [3, 3, '^']]));
    expect(cellAt(m, offsetToHex(1, 1))).toMatchObject({ terrain: 'rubble', dragModifier: 2 });
    expect(cellAt(m, offsetToHex(3, 1))).toMatchObject({ terrain: 'ridge', passable: false, blocksLos: true });
    expect(cellAt(m, offsetToHex(3, 3))).toMatchObject({ terrain: 'highland', elevation: 1 });
  });

  it('地圖外回傳 null', () => {
    const m = loadMap(RULES, flatRaw(5, 5));
    expect(cellAt(m, offsetToHex(-1, 0))).toBeNull();
    expect(cellAt(m, offsetToHex(5, 0))).toBeNull();
    expect(cellAt(m, offsetToHex(0, -1))).toBeNull();
    expect(cellAt(m, offsetToHex(0, 5))).toBeNull();
    expect(allHexes(m)).toHaveLength(25);
  });

  it('壞圖一次列出全部問題', () => {
    const raw = flatRaw(5, 5);
    raw.rows[1] = '..x..';
    raw.rows[2] = '....';
    raw.rows.push('.....');
    expect(() => loadMap(RULES, raw)).toThrow(/height=5 但有 6 列[\s\S]*未知的地形字元 "x"[\s\S]*第 2 列長度 4/);
  });

  it('出生點不可以在稜線上', () => {
    const raw = flatRaw(5, 5, [[2, 2, '#']]);
    expect(() => loadMap(RULES, raw)).toThrow('出生點');
    raw.rows[2] = '.....';
    raw.spawns.enemies = [{ col: 9, row: 9, facing: 3 }];
    expect(() => loadMap(RULES, raw)).toThrow('出生點');
  });
});
