import { describe, expect, it } from 'vitest';
import {
  DIRS, DIR_NAME, DIR_VEC, SUB, add, dirToward, hexDist, hexLen, hexLine, hexRound, hexToSub,
  inFrontArc, neighbor, rotate, sameHex, scale, sub, subToHex, turnSteps, vec,
} from '../src/core/hex';
import type { Dir } from '../src/core/hex';

describe('§2 方向與座標', () => {
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
    expect(hexLen({ q: 1, r: -2 })).toBe(2);           // N + NE：相鄰方向相加，長度相加
    expect(hexLen(add(DIR_VEC[0], DIR_VEC[2]))).toBe(1); // N + SE = NE：隔一個方向相加，長度 1
  });

  it('整數向量的長度必為整數（次格速度可以直接比較）', () => {
    for (let q = -7; q <= 7; q++) for (let r = -7; r <= 7; r++) {
      expect(Number.isInteger(hexLen({ q, r }))).toBe(true);
    }
  });

  it('vec / add / sub / scale 會把 -0 正規化成 0', () => {
    expect(Object.is(vec(-0, -0).q, 0)).toBe(true);
    expect(Object.is(scale({ q: 0, r: 3 }, -1).q, 0)).toBe(true);
    expect(sub({ q: 3, r: 1 }, { q: 1, r: 1 })).toEqual({ q: 2, r: 0 });
    expect(sameHex({ q: 1, r: 2 }, { q: 1, r: 2 })).toBe(true);
    expect(sameHex({ q: 1, r: 2 }, { q: 2, r: 1 })).toBe(false);
  });
});

describe('§2 次格精度與取整', () => {
  it('SUB = 10', () => {
    expect(SUB).toBe(10);
  });

  it('hexRound 取最近的格，三個分量都可能是被修正的那個', () => {
    expect(hexRound(0.1, 0.1)).toEqual({ q: 0, r: 0 });
    expect(hexRound(0.45, 0.3)).toEqual({ q: 1, r: 0 });    // 修正 q
    expect(hexRound(0.3, 0.45)).toEqual({ q: 0, r: 1 });    // 修正 r
    expect(hexRound(0.4, -0.9)).toEqual({ q: 0, r: -1 });   // 修正 s
    expect(Object.is(hexRound(-0.2, -0.2).q, 0)).toBe(true);
  });

  it('佔格 = round(posSub / SUB)；格中心往返不變', () => {
    expect(subToHex({ q: 12, r: -8 })).toEqual({ q: 1, r: -1 });
    expect(subToHex({ q: 4, r: 0 })).toEqual({ q: 0, r: 0 });
    for (let q = -3; q <= 3; q++) for (let r = -3; r <= 3; r++) {
      expect(subToHex(hexToSub({ q, r }))).toEqual({ q, r });
    }
  });
});

describe('§3.1 第 6 步的六角直線', () => {
  it('含兩端、長度 = 距離 + 1、每一步都是相鄰格', () => {
    const a = { q: -3, r: 5 };
    const b = { q: 4, r: -2 };
    const line = hexLine(a, b);
    expect(line[0]).toEqual(a);
    expect(line[line.length - 1]).toEqual(b);
    expect(line.length).toBe(hexDist(a, b) + 1);
    for (let i = 1; i < line.length; i++) expect(hexDist(line[i - 1], line[i])).toBe(1);
  });

  it('同一組端點永遠得到同一條線（bot 可重現）', () => {
    const a = { q: 0, r: 0 };
    const b = { q: 2, r: -4 };   // 剛好擦過格線交界的方向
    expect(hexLine(a, b)).toEqual(hexLine(a, b));
  });

  it('起點等於終點時只有一格', () => {
    expect(hexLine({ q: 2, r: 2 }, { q: 2, r: 2 })).toEqual([{ q: 2, r: 2 }]);
  });
});

describe('朝向', () => {
  it('rotate 正負都繞回 0..5', () => {
    expect(rotate(0, -1)).toBe(5);
    expect(rotate(5, 1)).toBe(0);
    expect(rotate(2, 9)).toBe(5);
    expect(rotate(1, -8)).toBe(5);
  });

  it('turnSteps 取最短方向，最多 3 面', () => {
    expect(turnSteps(0, 0)).toBe(0);
    expect(turnSteps(0, 5)).toBe(1);
    expect(turnSteps(1, 4)).toBe(3);
    expect(turnSteps(4, 0)).toBe(2);
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
    // (1,-2) 剛好在 N 與 NE 之間：兩者走一步都剩 1 格
    expect(dirToward({ q: 0, r: 0 }, { q: 1, r: -2 }, 1)).toBe(1);
    expect(dirToward({ q: 0, r: 0 }, { q: 1, r: -2 }, 0)).toBe(0);
    expect(dirToward({ q: 0, r: 0 }, { q: 1, r: -2 }, 3)).toBe(0);
  });
});
