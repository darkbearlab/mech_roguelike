import { describe, expect, it } from 'vitest';
import { advanceCourse, checkpointHexes, hooksOf, inCheckpoint, newProgress } from '../src/core/course';
import type { Course } from '../src/core/course';
import { applyCommand, checkLegal, newGame } from '../src/core/engine';
import { rawMapById } from '../src/core/content';
import { DIR_VEC, add, scale } from '../src/core/hex';
import type { Hex } from '../src/core/hex';
import { loadMap } from '../src/core/map';
import { RULES } from '../src/core/rules';
import { COAST, WAIT, accel, flatRaw, player, run } from './helpers';

const N = DIR_VEC[0];
const at = (q: number, r: number): Hex => ({ q, r });
const line = (from: Hex, n: number): Hex[] => Array.from({ length: n + 1 }, (_, i) => add(from, scale(N, i)));

const cp = (type: 'PASS' | 'STOP', where: Hex, radius: number, id = 'x', hooks: Course['checkpoints'][number]['hooks'] = []) =>
  ({ id, type, at: where, radius, hint: id, hooks });

/** 一條往北的直線跑道：兩個通過區、一個停車框。 */
const course: Course = {
  name: 'test',
  checkpoints: [cp('PASS', at(0, -3), 0, 'a'), cp('PASS', at(0, -6), 1, 'b'), cp('STOP', at(0, -10), 1, 'c')],
};

describe('檢查點判定', () => {
  it('區域 = 中心加半徑（cube 距離）', () => {
    const cp = course.checkpoints[1];
    expect(inCheckpoint(cp, at(0, -6))).toBe(true);
    expect(inCheckpoint(cp, at(1, -6))).toBe(true);
    expect(inCheckpoint(cp, at(0, -8))).toBe(false);
    // 半徑 0 = 1 格、1 = 7 格、2 = 19 格，而且每一格都在區域內
    expect([0, 1, 2].map((radius) => checkpointHexes({ ...cp, radius }).length)).toEqual([1, 7, 19]);
    expect(checkpointHexes(cp).every((h) => inCheckpoint(cp, h))).toBe(true);
  });

  it('路徑碰到就算通過；一次長距離位移可以連續通過好幾個', () => {
    const r = advanceCourse(course, newProgress(), line(at(0, 0), 5), 5, 3);
    expect(r.passed).toEqual([0, 1]);
    expect(r.progress).toEqual({ next: 2, reached: [3, 3], done: null });
  });

  it('只有下一個算數：先碰到後面的不會跳關', () => {
    const r = advanceCourse(course, newProgress(), [at(0, -7), at(0, -6)], 0, 1);
    expect(r.passed).toEqual([]);
  });

  it('停車框要停在框裡、速度 0；經過不算', () => {
    const p = { next: 2, reached: [1, 2], done: null };
    expect(advanceCourse(course, p, line(at(0, -6), 5), 3, 4).passed).toEqual([]);
    const r = advanceCourse(course, p, [at(0, -8), at(0, -9)], 0, 5);
    expect(r.passed).toEqual([2]);
    expect(r.progress.done).toBe(5);
  });

  it('停住的那一格若也在下一個通過區裡，一併算；跑完之後不再變動', () => {
    const c: Course = { name: 'x', checkpoints: [cp('STOP', at(0, 0), 1, 's'), cp('PASS', at(0, 1), 1, 'p')] };
    const r = advanceCourse(c, newProgress(), [at(0, 0)], 0, 2);
    expect(r.passed).toEqual([0, 1]);
    expect(r.progress.done).toBe(2);
    const again = advanceCourse(c, r.progress, [at(0, 0)], 0, 3);
    expect(again.passed).toEqual([]);
    expect(again.progress.done).toBe(2);
  });

  it('不改動傳入的進度', () => {
    const p = newProgress();
    advanceCourse(course, p, line(at(0, 0), 5), 5, 1);
    expect(p).toEqual(newProgress());
  });
});

describe('跑道地圖', () => {
  it('基礎跑道讀得進來：11 個檢查點、兩個停車框、建議機體是噴射、掛了旁白鉤子', () => {
    const m = loadMap(RULES, rawMapById('track_01')!);
    const cps = m.course!.checkpoints;
    expect(cps).toHaveLength(11);
    expect(cps.filter((c) => c.type === 'STOP').map((c) => c.id)).toEqual(['stop1', 'goal']);
    expect(cps.every((c) => c.hint.length > 0)).toBe(true);
    expect(hooksOf(m.course!, 0, 'ACTIVATE')[0]).toMatchObject({ type: 'MESSAGE' });
    expect(cps.flatMap((c) => c.hooks).every((h) => h.type === 'MESSAGE' && typeof h.text === 'string')).toBe(true);
    expect(m.chassis).toBe('jt1');
    expect(loadMap(RULES, rawMapById('proving_ground')!).course).toBeNull();
  });

  it('跑道資料有錯時列出問題', () => {
    const raw = flatRaw(9, 9);
    raw.course = {
      chassis: 'zz9',
      checkpoints: [
        { type: 'JUMP', col: 4, row: 2 },
        { type: 'PASS', col: 4, row: 2, radius: -1 },
        { type: 'STOP', col: 40, row: 2 },
      ],
    };
    expect(() => loadMap(RULES, raw)).toThrow(/檢查點 1 的 type[\s\S]*檢查點 2 的 radius[\s\S]*"zz9" 不存在/);
    raw.course = { checkpoints: [{ type: 'STOP', col: 40, row: 2 }] };
    expect(() => loadMap(RULES, raw)).toThrow('檢查點 1 的中心在地圖外');
    raw.course = { checkpoints: [] };
    expect(() => loadMap(RULES, raw)).toThrow('至少要有一個檢查點');
  });

  it('跑道沒寫名字就用地圖名；半徑預設 1、id 預設 cp1…、鉤子預設 REACH', () => {
    const raw = flatRaw(9, 9);
    raw.course = {
      checkpoints: [
        { type: 'PASS', col: 4, row: 1, hooks: [{ type: 'MESSAGE', text: '嗨' }] },
        { id: 'goal', type: 'STOP', col: 4, row: 3, hooks: [{ when: 'ACTIVATE', type: 'SPAWN', unit: 'x' }] },
      ],
    };
    const m = loadMap(RULES, raw);
    expect(m.course).toMatchObject({
      name: '測試場',
      checkpoints: [
        { id: 'cp1', radius: 1, hint: '', hooks: [{ when: 'REACH', type: 'MESSAGE', text: '嗨' }] },
        { id: 'goal', hooks: [{ when: 'ACTIVATE', type: 'SPAWN', unit: 'x' }] },
      ],
    });
    expect(m.chassis).toBeNull();
    expect(hooksOf(m.course!, 0, 'REACH')).toHaveLength(1);
    expect(hooksOf(m.course!, 0, 'ACTIVATE')).toEqual([]);
    expect(hooksOf(m.course!, 5, 'REACH')).toEqual([]);
  });

  it('鉤子與 id 的資料錯誤', () => {
    const raw = flatRaw(9, 9);
    raw.course = {
      checkpoints: [
        { id: 'a', type: 'PASS', col: 4, row: 1, hooks: [{ when: 'SOON', type: 'MESSAGE' }, { text: '沒有 type' }] },
        { id: 'a', type: 'PASS', col: 4, row: 2 },
      ],
    };
    expect(() => loadMap(RULES, raw)).toThrow(/鉤子 1 的 when[\s\S]*鉤子 2 缺少 type[\s\S]*id "a" 重複/);
  });
});

describe('事件鉤子（檢查點當作事件的觸發點）', () => {
  const raw = flatRaw(9, 12);
  raw.spawns.player = { col: 4, row: 10, facing: 0 };
  raw.course = {
    checkpoints: [
      { id: 'one', type: 'PASS', col: 4, row: 8, radius: 0, hooks: [
        { type: 'MESSAGE', text: '過了第一個' },
        { when: 'ACTIVATE', type: 'MESSAGE', text: '開局就是目標' },
      ] },
      { id: 'two', type: 'PASS', col: 4, row: 7, radius: 0, hooks: [{ when: 'ACTIVATE', type: 'CUSTOM', n: 2 }] },
      { id: 'three', type: 'PASS', col: 4, row: 2, radius: 0 },
    ],
  };
  const map = loadMap(RULES, raw);

  it('每個檢查點依序發 ACTIVATE、REACH 各一次 —— 一次衝過好幾個也一樣；內容原封不動', () => {
    const s = newGame(RULES, map, { seed: 1, player: { chassis: 'jt1' } });
    const r = applyCommand(s, accel(0, 3));   // 一次穿過 one、two
    const seq = r.events.filter((e) => e.type === 'CHECKPOINT' || e.type === 'COURSE_HOOK')
      .map((e) => (e.type === 'CHECKPOINT' ? `CP:${e.id}` : `HOOK:${e.checkpointId}:${e.hook.when}:${e.hook.type}`));
    expect(seq).toEqual(['CP:one', 'HOOK:one:REACH:MESSAGE', 'HOOK:two:ACTIVATE:CUSTOM', 'CP:two']);
    expect(r.events).toContainEqual(expect.objectContaining({
      type: 'COURSE_HOOK', hook: { when: 'ACTIVATE', type: 'CUSTOM', n: 2 },
    }));
  });

  it('開局的第一個目標的 ACTIVATE 鉤子由介面在開局時用 hooksOf 取', () => {
    expect(hooksOf(map.course!, 0, 'ACTIVATE')).toEqual([{ when: 'ACTIVATE', type: 'MESSAGE', text: '開局就是目標' }]);
  });

  it('只通過一個時，下一個的 ACTIVATE 鉤子跟著發出', () => {
    const s = newGame(RULES, map, { seed: 1, player: { chassis: 'jt1' } });
    const r = applyCommand(s, accel(0, 2));   // 只到 one
    expect(r.events).toContainEqual({
      type: 'COURSE_HOOK', index: 1, checkpointId: 'two', hook: { when: 'ACTIVATE', type: 'CUSTOM', n: 2 }, round: 1,
    });
  });
});

describe('引擎：跑道進度、事件與完賽', () => {
  // 出生點 (col 4,row 10) = axial (4, 8)，朝北；北方 3 格是通過點 (4,5)，再往北是停車框 (4,1)
  const raw = flatRaw(9, 12);
  raw.spawns.player = { col: 4, row: 10, facing: 0 };
  raw.course = {
    checkpoints: [
      { type: 'PASS', col: 4, row: 7, radius: 0, hint: '通過' },
      { type: 'STOP', col: 4, row: 3, radius: 1, hint: '停' },
    ],
  };
  const map = loadMap(RULES, raw);
  const start = () => newGame(RULES, map, { seed: 1, player: { chassis: 'jt1' } });

  it('開局帶著空的進度；沒有跑道的地圖是 null', () => {
    expect(start().course).toEqual({ next: 0, reached: [], done: null });
    expect(newGame(RULES, loadMap(RULES, flatRaw()), { seed: 1, player: { chassis: 'jt1' } }).course).toBeNull();
  });

  it('通過檢查點發出事件；高速衝過停車框不算', () => {
    const r = run(start(), [accel(0, 3)]);
    expect(r.events).toContainEqual({ type: 'CHECKPOINT', index: 0, id: 'cp1', round: 1 });
    // 3 + 2 = 5 速往北：一路穿過停車框（速度不是 0）
    const r2 = run(r.state, [WAIT, accel(0, 2)]);
    expect(player(r2.state).speed).toBe(5);
    expect(r2.state.course).toMatchObject({ next: 1, done: null });
    expect(r2.state.over).toBeNull();
  });

  it('完賽：停在最後一個框裡 → COURSE_DONE、winner PLAYER，之後的指令都不合法', () => {
    const raw2 = flatRaw(9, 12);
    raw2.spawns.player = { col: 4, row: 10, facing: 0 };
    raw2.course = { checkpoints: [{ type: 'STOP', col: 4, row: 8, radius: 1 }] };
    const s0 = newGame(RULES, loadMap(RULES, raw2), { seed: 1, player: { chassis: 'jt1' } });
    const r = applyCommand(s0, accel(0, 1));   // 1 速往北一格，停不住（速度 1）
    expect(r.state.course?.done).toBeNull();
    const s1 = run(r.state, [WAIT]).state;
    const r2 = run(s1, [COAST]);                   // 1 − 衰減 1 = 0：停在框裡
    expect(r2.events).toContainEqual({ type: 'COURSE_DONE', round: 2 });
    expect(r2.state.over).toEqual({ winner: 'PLAYER' });
    expect(checkLegal(r2.state, WAIT).reason).toContain('已結束');
  });
});
