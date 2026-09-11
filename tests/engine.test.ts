import { describe, expect, it } from 'vitest';
import { applyCommand, checkLegal, judge, newGame, turnPrice } from '../src/core/engine';
import { hexLen, hexToSub, subToHex, vec } from '../src/core/hex';
import { RULES, withPatch } from '../src/core/rules';
import type { GameState } from '../src/core/state';
import { activeUnit, currentStep, playerUnit, unitAt, unitById } from '../src/core/state';
import { BRAKE, CRUISE, WAIT, flatMap, game, player, push, run, turn } from './helpers';

const TURN_R = { type: 'TURN', delta: 1 } as const;
const TURN_L = { type: 'TURN', delta: -1 } as const;

/** 直接改複製品上的欄位（模擬第 5 步以後才會有的傷害、外部加熱等）。 */
function patch(s: GameState, f: (s: GameState) => void): GameState {
  const n = structuredClone({ ...s, rules: null, map: null }) as unknown as GameState;
  n.rules = s.rules;
  n.map = s.map;
  f(n);
  return n;
}

describe('§5 開局與回合結構', () => {
  it('開局停在第 1 回合玩家的加速宣告，配額已發', () => {
    const s = game('wk1');
    expect(s.round).toBe(1);
    expect(currentStep(s)).toEqual({ kind: 'DECLARE', unitId: 'player' });
    expect(player(s)).toMatchObject({ ap: 1, debt: 0, heat: 0, drive: 'walker', facing: 0 });
    expect(activeUnit(s)?.id).toBe('player');
  });

  it('玩家永遠先手，敵人依陣列順序；敵人預設站地圖的敵方出生點', () => {
    const map = flatMap();
    map.enemySpawns.push({ hex: { q: 3, r: 3 }, facing: 2 });
    const s = newGame(RULES, map, {
      seed: 1,
      player: { chassis: 'wk1' },
      enemies: [{ chassis: 'tk1' }, { chassis: 'jt1', hex: { q: 12, r: 3 }, name: '燕二號' }],
    });
    expect(s.units.map((u) => u.id)).toEqual(['player', 'enemy1', 'enemy2']);
    expect(subToHex(s.units[1].posSub)).toEqual({ q: 3, r: 3 });
    expect(s.units[1].facing).toBe(2);
    expect(s.units[2].name).toBe('燕二號');
    expect(s.units[2].facing).toBe(3);
    expect(s.steps.map((st) => st.kind)).toEqual([
      'DECLARE', 'MOVE', 'ACT', 'DECLARE', 'MOVE', 'ACT', 'DECLARE', 'MOVE', 'ACT', 'WORLD',
    ]);
  });

  it('設定錯誤時丟出例外', () => {
    const map = flatMap();
    expect(() => newGame(RULES, map, { seed: 1, player: { chassis: 'zz9' } })).toThrow('沒有這個機體');
    expect(() => newGame(RULES, map, { seed: 1, player: { chassis: 'wk1' }, order: 'NOPE' })).toThrow('解算順序');
    expect(() => newGame(RULES, map, { seed: 1, player: { chassis: 'wk1' }, enemies: [{ chassis: 'tk1' }] }))
      .toThrow('出生點');
  });

  it('加速宣告後位移立即解算（循序制），然後停在行動', () => {
    const { state, events } = run(game('jt1'), [push(0)]);
    expect(currentStep(state)).toEqual({ kind: 'ACT', unitId: 'player' });
    const moved = events.find((e) => e.type === 'MOVED');
    expect(moved).toMatchObject({ unitId: 'player', velSub: { q: 0, r: -12 } });
    expect(player(state).heat).toBe(6);
  });

  it('待機 → 世界階段（被動散熱）→ 下一回合', () => {
    const { state, events } = run(game('jt1'), turn(push(0)));
    expect(state.round).toBe(2);
    expect(events.map((e) => e.type)).toEqual(['MOVED', 'WAITED', 'ROUND', 'PHASE']);
    expect(player(state).heat).toBe(3);   // 6 − 被動 3
    expect(currentStep(state)).toEqual({ kind: 'DECLARE', unitId: 'player' });
  });

  it('非法指令回傳同一個狀態物件', () => {
    const s = game('wk1');
    expect(applyCommand(s, WAIT).state).toBe(s);
    expect(checkLegal(s, TURN_R).reason).toContain('先宣告加速');
    const acted = run(s, [CRUISE]).state;
    expect(checkLegal(acted, CRUISE).reason).toContain('已經宣告過');
    expect(checkLegal(acted, push(3)).ok).toBe(false);
  });

  it('側向加速被拒時帶著理由', () => {
    const l = checkLegal(game('tk1'), push(3));
    expect(l.ok).toBe(false);
    expect(l.reason).toContain('前方三面');
  });

  it('加速宣告的合法性回報加速產熱', () => {
    expect(checkLegal(game('jt1'), push(2))).toMatchObject({ ok: true, ap: 0, heat: 6, overdraft: 0 });
    expect(checkLegal(game('jt1'), CRUISE).heat).toBe(0);
  });
});

describe('§3.3 轉向（行動階段）', () => {
  it('步行：每回合第一面免費，第二面 1 AP，第三面透支', () => {
    let s = run(game('wk1'), [CRUISE]).state;
    expect(turnPrice(RULES, player(s))).toEqual({ ap: 0, heat: 0 });
    s = run(s, [TURN_R]).state;
    expect(player(s)).toMatchObject({ facing: 1, ap: 1, facesTurned: 1 });
    expect(checkLegal(s, TURN_R)).toMatchObject({ ok: true, ap: 1, overdraft: 0 });
    s = run(s, [TURN_R]).state;
    expect(player(s)).toMatchObject({ facing: 2, ap: 0, debt: 0 });
    expect(checkLegal(s, TURN_R)).toMatchObject({ ok: true, ap: 1, overdraft: 1 });
    s = run(s, [TURN_R]).state;
    expect(player(s)).toMatchObject({ facing: 3, debt: 1 });
    // 還清前不能再做要花 AP 的事
    expect(checkLegal(s, TURN_R).reason).toContain('償還債務');
  });

  it('免費額度每個階段重算', () => {
    let s = run(game('wk1'), [CRUISE, TURN_L, WAIT, CRUISE]).state;
    expect(player(s).facing).toBe(5);
    expect(turnPrice(RULES, player(s))).toEqual({ ap: 0, heat: 0 });
    s = run(s, [TURN_L]).state;
    expect(player(s)).toMatchObject({ facing: 4, ap: 1 });
  });

  it('履帶：每一面都要 1 AP', () => {
    let s = run(game('tk1'), [CRUISE]).state;
    expect(checkLegal(s, TURN_R).ap).toBe(1);
    s = run(s, [TURN_R]).state;
    expect(player(s)).toMatchObject({ facing: 1, ap: 0 });
  });

  it('噴射：免費任意，背著債也能轉', () => {
    let s = run(game('jt1'), [CRUISE, TURN_R, TURN_R, TURN_R]).state;
    expect(player(s)).toMatchObject({ facing: 3, ap: 1, debt: 0 });
    s = patch(s, (n) => { n.units[0].debt = 2; });
    expect(checkLegal(s, TURN_L).ok).toBe(true);
  });
});

describe('§4.1 透支與脆弱視窗', () => {
  it('透支的債背過整個敵人與世界階段（不散熱），在下一個自己的階段開始時才扣抵', () => {
    const hot = patch(run(game('wk1'), [CRUISE]).state, (n) => { n.units[0].heat = 50; });
    // 散熱 1 AP，再轉兩面：一面免費、一面透支
    let s = run(hot, [{ type: 'COOL' }, TURN_R, TURN_R]).state;
    expect(player(s)).toMatchObject({ heat: 25, debt: 1, ap: 0 });
    s = run(s, [WAIT]).state;
    // 世界階段：債務 > 0 → 不散熱
    expect(player(s)).toMatchObject({ heat: 25, debt: 0, ap: 0 });
    expect(s.round).toBe(2);
    s = run(s, [CRUISE, WAIT]).state;
    expect(player(s)).toMatchObject({ heat: 22, debt: 0 });
  });
});

describe('§4.2 散熱與驅動切換', () => {
  it('散熱 1 AP、−25 熱；熱量為 0 時不給按', () => {
    expect(checkLegal(run(game('wk1'), [CRUISE]).state, { type: 'COOL' }).reason).toContain('已經是 0');
    const s = patch(run(game('wk1'), [CRUISE]).state, (n) => { n.units[0].heat = 30; });
    const r = run(s, [{ type: 'COOL' }]);
    expect(player(r.state)).toMatchObject({ heat: 5, ap: 0 });
    expect(r.events).toContainEqual({ type: 'COOLED', unitId: 'player', heat: 5 });
  });

  it('複合機在步行與噴射之間切換，1 AP +5 熱；速度保留', () => {
    let s = run(game('hy1'), [push(0), push(0)].flatMap((c) => [c, WAIT])).state;
    const v = player(s).velSub;
    s = run(s, [CRUISE, { type: 'SWITCH_DRIVE' }]).state;
    expect(player(s).drive).toBe('jet');
    expect(player(s).ap).toBe(0);
    expect(hexLen(player(s).velSub)).toBeGreaterThan(0);
    expect(hexLen(v)).toBeGreaterThan(0);
    s = run(s, [WAIT, CRUISE, { type: 'SWITCH_DRIVE' }]).state;
    expect(player(s).drive).toBe('walker');
  });

  it('單一驅動的機體不能切換，但仍回報成本讓按鍵顯示', () => {
    const l = checkLegal(run(game('wk1'), [CRUISE]).state, { type: 'SWITCH_DRIVE' });
    expect(l).toMatchObject({ ok: false, ap: 1, heat: 5 });
    expect(l.reason).toContain('只有一種驅動');
  });
});

describe('§4.2 過熱停機', () => {
  it('行動造成過熱：這個階段當場結束，下一個階段強制巡航（阻力照常），之後重新開機', () => {
    let s = run(game('hy1'), [CRUISE]).state;
    s = patch(s, (n) => { n.units[0].heat = 97; n.units[0].velSub = vec(0, -20); n.units[0].drive = 'jet'; });
    const r = run(s, [{ type: 'SWITCH_DRIVE' }]);
    expect(r.events.map((e) => e.type)).toContain('OVERHEAT');
    s = r.state;
    // 階段已經結束：回合推進、現在又輪到玩家，但玩家停機中 —— 引擎自動巡航並跳過行動
    expect(s.round).toBeGreaterThan(1);
    expect(player(s).heat).toBeLessThan(100);
    expect(player(s).shutdown).toBe(0);
    expect(currentStep(s)).toEqual({ kind: 'DECLARE', unitId: 'player' });
  });

  it('停機的那一個階段：強制巡航、不能行動，速度照阻力衰減', () => {
    let s = run(game('jt1'), [CRUISE]).state;
    s = patch(s, (n) => { n.units[0].heat = 99; n.units[0].velSub = vec(0, -30); });
    // 散熱不會過熱；用轉向不會加熱 —— 所以直接改熱量後推一下（加速產熱 6）
    s = run(s, [WAIT]).state;          // 世界階段 −3 → 96
    expect(player(s).heat).toBe(96);
    const before = player(s).velSub;
    const r = run(s, [push(0)]);       // 96 + 6 → 100：在自己的位移中過熱
    s = r.state;
    const types = r.events.map((e) => e.type);
    expect(types).toContain('OVERHEAT');
    expect(types).toContain('REBOOT');
    // 過熱那一回合的推進照樣發生；接下來整個階段是強制巡航
    const moves = r.events.filter((e) => e.type === 'MOVED');
    expect(moves).toHaveLength(2);
    expect(moves[0]).toMatchObject({ choice: { kind: 'DIR', dir: 0 } });
    expect(moves[1]).toMatchObject({ choice: { kind: 'CRUISE' } });
    expect(hexLen(player(s).velSub)).toBeLessThan(hexLen(before) + 12);
    expect(player(s).shutdown).toBe(0);
    expect(s.round).toBe(4);
  });

  it('停機中的階段照樣扣抵債務；背著債的世界階段不散熱', () => {
    let s = run(game('wk1'), [CRUISE]).state;
    // 在自己的階段中過熱 = 這個階段 + 下一個階段（shutdown 2）
    s = patch(s, (n) => { n.units[0].heat = 100; n.units[0].debt = 2; n.units[0].shutdown = 2; });
    s = run(s, [WAIT]).state;
    // 第 2 回合停機：自動巡航、債務 2 → 1；第 3 回合開機：債務 1 → 0
    expect(player(s)).toMatchObject({ shutdown: 0, debt: 0, ap: 0, heat: 100 });
    expect(s.round).toBe(3);
  });
});

describe('敵人、陣亡與勝敗（第 5～6 步的掛勾）', () => {
  const withEnemy = () => game('wk1', { enemies: [{ chassis: 'tk1', hex: { q: 3, r: 3 }, facing: 3 }] });

  it('敵人的階段一樣是 宣告 → 位移 → 行動，由呼叫端送指令', () => {
    let s = run(withEnemy(), turn(CRUISE)).state;
    expect(currentStep(s)).toEqual({ kind: 'DECLARE', unitId: 'enemy1' });
    s = run(s, [BRAKE]).state;
    expect(currentStep(s)).toEqual({ kind: 'ACT', unitId: 'enemy1' });
    s = run(s, [WAIT]).state;
    expect(s.round).toBe(2);
    expect(currentStep(s)?.kind).toBe('DECLARE');
  });

  it('回合中陣亡的單位，剩下的步驟自動略過；下一回合不再排入', () => {
    let s = run(withEnemy(), [CRUISE]).state;
    s = patch(s, (n) => { n.units[1].alive = false; });
    const r = run(s, [WAIT]);
    expect(r.state.over).toEqual({ winner: 'PLAYER' });
    expect(checkLegal(r.state, CRUISE).reason).toContain('已結束');
  });

  it('玩家陣亡 → 敵方勝；開局沒有敵人的自由移動永遠不結束', () => {
    const s = withEnemy();
    expect(judge(patch(s, (n) => { n.units[0].alive = false; }))).toEqual({ winner: 'ENEMY' });
    expect(judge(s)).toBeNull();
    expect(judge(game('wk1'))).toBeNull();
  });

  it('碰撞其他單位時停在它前面', () => {
    const s = game('jt1', { enemies: [{ chassis: 'tk1', hex: { q: 10, r: 1 }, facing: 3 }] });
    const fast = patch(s, (n) => { n.units[0].velSub = vec(0, -40); });
    const r = run(fast, [CRUISE]);
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'COLLIDED' }));
    expect(subToHex(player(r.state).posSub)).toEqual({ q: 10, r: 2 });
    expect(unitAt(r.state, { q: 10, r: 1 })?.id).toBe('enemy1');
    expect(unitAt(r.state, { q: 10, r: 1 }, 'enemy1')).toBeUndefined();
  });
});

describe('選取器與可重現性', () => {
  it('自動步驟上沒有 activeUnit；cursor 超出範圍時沒有 currentStep', () => {
    const s = game('wk1');
    expect(activeUnit(patch(s, (n) => { n.cursor = 1; }))).toBeNull();
    expect(currentStep(patch(s, (n) => { n.cursor = 99; }))).toBeNull();
    expect(checkLegal(patch(s, (n) => { n.cursor = 99; }), CRUISE).reason).toContain('沒有人');
    expect(unitById(s, 'ghost')).toBeUndefined();
    expect(playerUnit(s)?.id).toBe('player');
  });

  it('同一個種子、同一串指令 → 完全相同的狀態', () => {
    const cmds = [push(0), WAIT, push(1), TURN_R, WAIT, BRAKE, WAIT, CRUISE, WAIT];
    const a = run(game('wk1', { seed: 7 }), cmds).state;
    const b = run(game('wk1', { seed: 7 }), cmds).state;
    expect(JSON.stringify({ ...a, rules: 0, map: 0 })).toBe(JSON.stringify({ ...b, rules: 0, map: 0 }));
  });

  it('applyCommand 不改動傳入的狀態', () => {
    const s = game('jt1');
    const snap = JSON.stringify({ ...s, rules: 0, map: 0 });
    run(s, [push(0), TURN_R, WAIT]);
    expect(JSON.stringify({ ...s, rules: 0, map: 0 })).toBe(snap);
  });

  it('調參後的規則照樣可以開局（面板換一份 Rules 就好）', () => {
    const rules = withPatch(RULES, { drives: { walker: { drag: 5 } } });
    const s = run(game('wk1', { rules, map: flatMap(21, 21, [], rules) }), [push(0)]).state;
    expect(hexLen(player(s).velSub)).toBe(10);
    expect(player(s).posSub).toEqual({ q: 100, r: 50 - 10 });
    expect(hexToSub({ q: 10, r: 5 })).toEqual({ q: 100, r: 50 });
  });
});
