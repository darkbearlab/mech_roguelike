/**
 * 的硬性規則，寫成測試讓它們不會悄悄被打破：
 *  - core/ 不得 import render/ 或 ui/，也不得碰 DOM / canvas / 瀏覽器 API
 *  - 亂數只能走 seeded RNG（不得 Math.random / Date.now）
 *  - 介面資料（ui.json）與規則資料互相對得上
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ui from '../src/data/ui.json';
import { RULES } from '../src/core/rules';

const CORE = join(__dirname, '..', 'src', 'core');
const files = readdirSync(CORE).filter((f) => f.endsWith('.ts'));

describe('分層', () => {
  it.each(files)('core/%s 沒有 import render/ 或 ui/', (f) => {
    const src = readFileSync(join(CORE, f), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const p of imports) {
      expect(p).not.toMatch(/(^|\/)(render|ui)(\/|$)/);
    }
  });

  it.each(files)('core/%s 沒有碰瀏覽器 API 或非種子亂數', (f) => {
    // 去掉註解再檢查 —— 註解裡提到「禁止 Math.random()」是可以的
    const src = readFileSync(join(CORE, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const banned of ['document.', 'window.', 'localStorage', 'HTMLCanvas', 'requestAnimationFrame', 'Math.random', 'Date.now', 'performance.now']) {
      expect(src.includes(banned), banned).toBe(false);
    }
  });
});

describe('介面資料與規則對得上', () => {
  type Cockpit = { pad: string[][]; readouts: Record<string, unknown> };
  const cockpits = ui.cockpits as Record<string, Cockpit>;
  // "" = 保留的空位（轉向搬到左盤之後，右盤原本轉向的兩格留給未決的功能）
  const PAD_KEYS = new Set(['', 'lock', 'fire', 'reload', 'swap', 'cool', 'switchDrive', 'wait']);

  it('每台機體的座艙都有定義', () => {
    for (const c of Object.values(RULES.chassis)) expect(cockpits[c.cockpit], c.id).toBeDefined();
  });

  it('座艙的功能盤只用得到認得的按鍵，而且 v0.1 的六個按鍵都在', () => {
    for (const [id, c] of Object.entries(cockpits)) {
      const keys = c.pad.flat();
      for (const k of keys) expect(PAD_KEYS.has(k), `${id}: ${k}`).toBe(true);
      for (const must of ['lock', 'fire', 'reload', 'swap', 'cool', 'wait']) expect(keys, id).toContain(must);
    }
  });

  it('左盤＝機動宣告：最上排轉向（左轉／機首／右轉）、再來 左前／前／右前、確認、左後／後／右後', () => {
    const pad = ui.movePad as string[][];
    expect(pad[0]).toEqual(['L', 'NOSE', 'R']);
    expect(pad[1]).toEqual(['5', '0', '1']);
    expect(pad[2][1]).toBe('OK');
    expect(pad[3]).toEqual(['4', '3', '2']);
    expect(new Set(pad.flat().filter(Boolean))).toEqual(new Set(['0', '1', '2', '3', '4', '5', 'OK', 'L', 'R', 'NOSE']));
  });

  it('右盤不再有轉向', () => {
    for (const c of Object.values(cockpits)) expect(c.pad.flat().some((k) => k.startsWith('turn'))).toBe(false);
  });
});
