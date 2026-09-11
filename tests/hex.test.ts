import { describe, expect, it } from 'vitest';
import {
  DIRS, DIR_NAME, DIR_VEC, add, dirToward, hexDist, hexLen, hexLine, hexRound,
  inFrontArc, neighbor, relDir, rotate, sameHex, scale, sub, turnSteps, vec,
} from '../src/core/hex';
import type { Dir } from '../src/core/hex';

describe('方向與座標', () => {
  it('六個方向依序是 N, NE, SE, S, SW, NW，向量與規格逐字相同', () => {
    expect(DIR_NAME).toEqual(['N', 'NE', 'SE', 'S', 'SW', 'NW']);
    expect(DIR_VEC).toEqual([
      { q: 0, r: -1 }, { q: 1, r: -1 }, { q: 1, r: 0 },
      { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 },
    ]);
  });

  it('每個方向向量長度都是 1，相對的方向互為反向', () => {
    for (const d of DIRS) {
      expect(hexLen(DIR_VEC[d])).toBe(1);
      expect(add(DIR_VEC[d], DIR_VEC[rotate(d, 3)])).toEqual({ q: 0, r: 0 });
    }
  });

  it('cube 距離 = (|dq| + |dq+dr| + |dr|) / 2', () => {
    expect(hexDist({ q: 0, r: 0 }, { q: 3, r: -1 })).toBe(3);
    expect(hexDist({ q: 2, r: 2 }, { q: -1, r: 0 })).toBe(5);
    expect(hexLen({ q: 1, r: -2 })).toBe(2);
  });

  it('沿同一個方向走 n 步，距離就是 n（移動只走直線）', () => {
    for (const d of DIRS) for (let n = 0; n <= 5; n++) expect(hexLen(scale(DIR_VEC[d], n))).toBe(n);
  });

  it('vec / add / sub / scale 會把 -0 正規化成 0', () => {
    expect(Object.is(vec(-0, -0).q, 0)).toBe(true);
    expect(Object.is(scale({ q: 0, r: 3 }, -1).q, 0)).toBe(true);
    expect(sub({ q: 3, r: 1 }, { q: 1, r: 1 })).toEqual({ q: 2, r: 0 });
    expect(sameHex({ q: 1, r: 2 }, { q: 1, r: 2 })).toBe(true);
    expect(sameHex({ q: 1, r: 2 }, { q: 2, r: 1 })).toBe(false);
  });

  it('hexRound 取最近的格，三個分量都可能是被修正的那個', () => {
    expect(hexRound(0.1, 0.1)).toEqual({ q: 0, r: 0 });
    expect(hexRound(0.45, 0.3)).toEqual({ q: 1, r: 0 });    // 修正 q
    expect(hexRound(0.3, 0.45)).toEqual({ q: 0, r: 1 });    // 修正 r
    expect(hexRound(0.4, -0.9)).toEqual({ q: 0, r: -1 });   // 修正 s
    expect(Object.is(hexRound(-0.2, -0.2).q, 0)).toBe(true);
  });
});

describe('六角直線（第 3 步的視線用）', () => {
  it('含兩端、長度 = 距離 + 1、每一步都是相鄰格', () => {
    const a = { q: -3, r: 5 };
    const b = { q: 4, r: -2 };
    const line = hexLine(a, b);
    expect(line[0]).toEqual(a);
    expect(line[line.length - 1]).toEqual(b);
    expect(line.length).toBe(hexDist(a, b) + 1);
    for (let i = 1; i < line.length; i++) expect(hexDist(line[i - 1], line[i])).toBe(1);
  });

  it('同一組端點永遠得到同一條線；起點等於終點時只有一格', () => {
    expect(hexLine({ q: 0, r: 0 }, { q: 2, r: -4 })).toEqual(hexLine({ q: 0, r: 0 }, { q: 2, r: -4 }));
    expect(hexLine({ q: 2, r: 2 }, { q: 2, r: 2 })).toEqual([{ q: 2, r: 2 }]);
  });
});

describe('朝向與相對方向', () => {
  it('rotate 正負都繞回 0..5', () => {
    expect(rotate(0, -1)).toBe(5);
    expect(rotate(5, 1)).toBe(0);
    expect(rotate(2, 9)).toBe(5);
    expect(rotate(1, -8)).toBe(5);
  });

  it('turnSteps 取最短方向，最多 3 面；relDir 是順時針差幾面', () => {
    expect(turnSteps(0, 0)).toBe(0);
    expect(turnSteps(0, 5)).toBe(1);
    expect(turnSteps(1, 4)).toBe(3);
    expect(turnSteps(4, 0)).toBe(2);
    expect(relDir(0, 5)).toBe(5);
    expect(relDir(4, 1)).toBe(3);
    for (const a of DIRS) for (const b of DIRS) expect(rotate(a, relDir(a, b))).toBe(b);
  });

  it('前方三面 = 朝向與左右各一面', () => {
    const front = (f: Dir) => DIRS.filter((d) => inFrontArc(f, d));
    expect(front(0)).toEqual([0, 1, 5]);
    expect(front(3)).toEqual([2, 3, 4]);
  });

  it('neighbor 沿方向走一格', () => {
    expect(neighbor({ q: 2, r: 2 }, 4)).toEqual({ q: 1, r: 3 });
  });

  it('dirToward：走一步最接近目標的方向；同格或平手時偏好 prefer', () => {
    expect(dirToward({ q: 0, r: 0 }, { q: 0, r: -5 })).toBe(0);
    expect(dirToward({ q: 0, r: 0 }, { q: -4, r: 4 })).toBe(4);
    expect(dirToward({ q: 0, r: 0 }, { q: 0, r: 0 }, 2)).toBe(2);
    expect(dirToward({ q: 0, r: 0 }, { q: 1, r: -2 }, 1)).toBe(1);
    expect(dirToward({ q: 0, r: 0 }, { q: 1, r: -2 }, 0)).toBe(0);
    expect(dirToward({ q: 0, r: 0 }, { q: 1, r: -2 }, 3)).toBe(0);
  });
});
