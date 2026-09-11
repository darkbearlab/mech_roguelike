import { describe, expect, it } from 'vitest';
import { applyCommand, checkLegal, judge, newGame, turnPrice } from '../src/core/engine';
import { DIR_VEC, add, hexDist, scale } from '../src/core/hex';
import type { Dir } from '../src/core/hex';
import { RULES } from '../src/core/rules';
import type { GameEvent } from '../src/core/state';
import { activeUnit, currentStep, playerUnit, unitAt, unitById } from '../src/core/state';
import {
  COAST, TURN_L, TURN_R, WAIT, accel, customRules, flatMap, game, patch, player, run,
} from './helpers';

const ends = (ev: GameEvent[]) => ev.filter((e) => e.type === 'PHASE_END').map((e) => (e as { reason: string }).reason);

describe('開局與回合結構', () => {
  it('開局停在第 1 回合玩家的加速宣告；靜止、速度方向 = 面向、配額已發', () => {
    const s = game('wk1');
    expect(s.round).toBe(1);
    expect(currentStep(s)).toEqual({ kind: 'DECLARE', unitId: 'player' });
    expect(player(s)).toMatchObject({ pos: { q: 10, r: 5 }, heading: 0, speed: 0, facing: 0, ap: 1, debt: 0, heat: 0 });
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
    expect(s.units[1]).toMatchObject({ pos: { q: 3, r: 3 }, facing: 2 });
    expect(s.units[2]).toMatchObject({ name: '燕二號', facing: 3 });
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

  it('左盤確認後位移立即解算（循序制），然後停在右盤', () => {
    const { state, events } = run(game('jt1'), [accel(0, 3)]);
    expect(currentStep(state)).toEqual({ kind: 'ACT', unitId: 'player' });
    expect(events.find((e) => e.type === 'MOVED')).toMatchObject({ heading: 0, speed: 3 });
    expect(player(state).pos).toEqual({ q: 10, r: 2 });
    expect(player(state).heat).toBe(6);
  });

  it('靜止時直接確認 = 空過：不動、不產熱', () => {
    const { state } = run(game('jt1'), [COAST]);
    expect(player(state)).toMatchObject({ pos: { q: 10, r: 5 }, speed: 0, heat: 0 });
  });

  it('待機 → 世界階段（被動散熱）→ 下一回合', () => {
    const { state, events } = run(game('jt1'), [accel(0, 3), WAIT]);
    expect(state.round).toBe(2);
    expect(events.map((e) => e.type)).toEqual(['MOVED', 'WAITED', 'PHASE_END', 'ROUND', 'PHASE']);
    expect(player(state).heat).toBe(3);
    expect(currentStep(state)).toEqual({ kind: 'DECLARE', unitId: 'player' });
  });

  it('非法指令回傳同一個狀態物件，並帶著理由', () => {
    const s = game('jt1');
    expect(applyCommand(s, WAIT).state).toBe(s);
    expect(checkLegal(s, TURN_R).reason).toContain('先在左盤確認加速');
    expect(checkLegal(s, accel(2, 1)).reason).toContain('推不動');
    const acted = run(s, [COAST]).state;
    expect(checkLegal(acted, COAST).reason).toContain('已經宣告過');
  });

  it('加速宣告的合法性回報點數產生的熱', () => {
    expect(checkLegal(game('jt1'), accel(0, 2))).toMatchObject({ ok: true, ap: 0, heat: 4, overdraft: 0 });
    expect(checkLegal(game('jt1'), COAST).heat).toBe(0);
  });
});

describe('設計者的範例，整段在引擎裡跑一次', () => {
  it('3 速往北 → 左前點 2 → 4 速往西北 → 右盤左轉（−1 速）→ 往後點 3 → 靜止', () => {
    let s = game('jt1', { map: flatMap(31, 31) });
    const start = player(s).pos;
    s = run(s, [accel(0, 3), WAIT]).state;
    expect(player(s)).toMatchObject({ heading: 0, speed: 3, pos: add(start, scale(DIR_VEC[0], 3)) });

    s = run(s, [accel(5, 2)]).state;
    expect(player(s)).toMatchObject({ heading: 5, speed: 4, facing: 0 });
    const afterVeer = player(s).pos;

    s = run(s, [TURN_L]).state;
    expect(player(s)).toMatchObject({ facing: 5, speed: 3, ap: 1 });   // 噴射轉向免費 AP，但吃 1 速
    s = run(s, [WAIT]).state;

    const r = run(s, [accel(3, 3)]);
    expect(player(r.state)).toMatchObject({ speed: 0, heading: 5, pos: afterVeer });
    expect(r.events.find((e) => e.type === 'MOVED')).toMatchObject({ path: [afterVeer] });
  });

  it('機體永遠停在格子中心：每一步都是整數格、每回合走的格數 = 速度', () => {
    let s = game('jt1', { map: flatMap(41, 41) });
    const orders = [accel(0, 3), accel(1, 2), COAST, accel(0, 1), accel(5, 2), COAST];
    for (const o of orders) {
      const before = player(s).pos;
      const r = run(s, [o]);
      const moved = r.events.find((e) => e.type === 'MOVED') as Extract<GameEvent, { type: 'MOVED' }>;
      expect(Number.isInteger(moved.to.q) && Number.isInteger(moved.to.r)).toBe(true);
      expect(hexDist(before, moved.to)).toBe(moved.speed);
      s = run(r.state, [WAIT]).state;
    }
  });
});

describe('右盤轉向', () => {
  it('步行：每回合第一面免費；第二面 1 AP，AP 用完就自動結束這個階段', () => {
    let s = run(game('wk1'), [COAST]).state;
    expect(turnPrice(RULES, player(s))).toEqual({ ap: 0, heat: 0 });
    s = run(s, [TURN_R]).state;
    expect(player(s)).toMatchObject({ facing: 1, ap: 1, facesTurned: 1 });
    expect(currentStep(s)?.kind).toBe('ACT');
    const r = run(s, [TURN_R]);
    expect(player(r.state).facing).toBe(2);
    expect(ends(r.events)).toEqual(['AP_SPENT']);
    expect(r.state.round).toBe(2);
    expect(currentStep(r.state)?.kind).toBe('DECLARE');
  });

  it('履帶：每一面都要 1 AP（配額 1 → 轉一面就結束）', () => {
    const s = run(game('tk1'), [COAST]).state;
    expect(checkLegal(s, TURN_R).ap).toBe(1);
    const r = run(s, [TURN_R]);
    expect(player(r.state).facing).toBe(1);
    expect(ends(r.events)).toEqual(['AP_SPENT']);
  });

  it('噴射：轉向免費，但每一面吃 1 速（最低 0）', () => {
    let s = run(game('jt1'), [accel(0, 2)]).state;
    s = run(s, [TURN_R, TURN_R, TURN_R]).state;
    expect(player(s)).toMatchObject({ facing: 3, speed: 0, ap: 1 });
    expect(currentStep(s)?.kind).toBe('ACT');
  });

  it('免費額度每個階段重算', () => {
    let s = run(game('wk1'), [COAST, TURN_L, WAIT, COAST]).state;
    expect(player(s).facing).toBe(5);
    expect(turnPrice(RULES, player(s))).toEqual({ ap: 0, heat: 0 });
    s = run(s, [TURN_L]).state;
    expect(player(s)).toMatchObject({ facing: 4, ap: 1 });
  });
});

describe('透支與 AP 用完', () => {
  // 把切換驅動改成 2 AP，才做得出「配額 1、行動 2」的透支
  const rules = customRules((r) => { r.actions.switchDrive.ap = 2; });

  it('透支：行動照常結算，然後階段結束；不夠的部分從下一個階段的配額扣', () => {
    let s = run(game('hy1', { rules }), [COAST]).state;
    expect(checkLegal(s, { type: 'SWITCH_DRIVE' })).toMatchObject({ ok: true, ap: 2, overdraft: 1 });
    const r = run(s, [{ type: 'SWITCH_DRIVE' }]);
    expect(ends(r.events)).toEqual(['OVERDRAFT']);
    s = r.state;
    expect(player(s).drive).toBe('jet');
    // 第 2 回合：配額 1 先還債 → AP 0 → 位移之後行動階段直接跳過
    expect(s.round).toBe(2);
    expect(player(s)).toMatchObject({ ap: 0, debt: 0 });
    const r2 = run(s, [COAST]);
    expect(ends(r2.events)).toEqual(['AP_SPENT']);
    expect(r2.state.round).toBe(3);
    expect(player(r2.state).ap).toBe(1);
  });

  it('背著債的世界階段不散熱', () => {
    let s = patch(run(game('hy1', { rules }), [COAST]).state, (n) => { n.units[0].heat = 50; });
    s = run(s, [{ type: 'SWITCH_DRIVE' }]).state;   // +5 → 55，透支 1
    expect(player(s).heat).toBe(55);
    s = run(s, [COAST]).state;                       // 這一回合沒有債了（開頭已還），世界階段照常散熱
    expect(player(s).heat).toBe(52);
  });

  it('透支超過上限就不能做', () => {
    const r2 = customRules((r) => { r.actions.switchDrive.ap = 4; });
    const s = run(game('hy1', { rules: r2 }), [COAST]).state;
    expect(checkLegal(s, { type: 'SWITCH_DRIVE' }).reason).toContain('超過上限');
  });

  it('剛好用完 AP 也結束；還有 AP 就繼續', () => {
    const quota2 = customRules((r) => { r.chassis.tk1.apQuota = 2; });
    let s = run(game('tk1', { rules: quota2 }), [COAST]).state;
    s = run(s, [TURN_R]).state;
    expect(currentStep(s)?.kind).toBe('ACT');
    const r = run(s, [TURN_R]);
    expect(ends(r.events)).toEqual(['AP_SPENT']);
  });
});

describe('散熱、驅動切換、過熱', () => {
  it('散熱 1 AP、−25 熱；熱量為 0 時不給按', () => {
    expect(checkLegal(run(game('wk1'), [COAST]).state, { type: 'COOL' }).reason).toContain('已經是 0');
    const s = patch(run(game('wk1'), [COAST]).state, (n) => { n.units[0].heat = 30; });
    const r = run(s, [{ type: 'COOL' }]);
    expect(r.events).toContainEqual({ type: 'COOLED', unitId: 'player', heat: 5 });
    expect(ends(r.events)).toEqual(['AP_SPENT']);
  });

  it('複合機切換驅動：1 AP +5 熱；速度超過新極速時當場夾住', () => {
    let s = run(game('hy1'), [COAST]).state;
    s = patch(s, (n) => { n.units[0].drive = 'jet'; n.units[0].speed = 5; });
    const r = run(s, [{ type: 'SWITCH_DRIVE' }]);
    expect(player(r.state)).toMatchObject({ drive: 'walker', speed: 2, heat: 2 });
  });

  it('單一驅動的機體不能切換，但仍回報成本讓按鍵顯示', () => {
    const l = checkLegal(run(game('wk1'), [COAST]).state, { type: 'SWITCH_DRIVE' });
    expect(l).toMatchObject({ ok: false, ap: 1, heat: 5 });
    expect(l.reason).toContain('只有一種驅動');
  });

  it('加速造成過熱：推進照樣發生；下一個階段強制不加速（慣性照衰減），之後重新開機', () => {
    let s = run(game('jt1', { map: flatMap(41, 41) }), [accel(0, 3), WAIT]).state;
    s = patch(s, (n) => { n.units[0].heat = 97; });
    const r = run(s, [accel(0, 2)]);   // 97 + 4 → 100
    const types = r.events.map((e) => e.type);
    expect(types).toContain('OVERHEAT');
    expect(types).toContain('REBOOT');
    const moves = r.events.filter((e) => e.type === 'MOVED') as Extract<GameEvent, { type: 'MOVED' }>[];
    expect(moves.map((m) => [m.order, m.speed])).toEqual([[{ rel: 0, taps: 2 }, 5], [null, 4]]);
    expect(ends(r.events)).toEqual(['SHUTDOWN', 'SHUTDOWN']);
    expect(player(r.state).shutdown).toBe(0);
  });

  it('行動造成過熱：這個階段當場結束', () => {
    let s = run(game('hy1'), [COAST]).state;
    s = patch(s, (n) => { n.units[0].heat = 97; });
    const r = run(s, [{ type: 'SWITCH_DRIVE' }]);
    expect(r.events.map((e) => e.type)).toContain('OVERHEAT');
    expect(ends(r.events)[0]).toBe('SHUTDOWN');
  });
});

describe('敵人、陣亡與勝敗（第 5～6 步的掛勾）', () => {
  const withEnemy = () => game('wk1', { enemies: [{ chassis: 'tk1', hex: { q: 3, r: 3 }, facing: 3 }] });

  it('敵人的階段一樣是 宣告 → 位移 → 行動，由呼叫端送指令', () => {
    let s = run(withEnemy(), [COAST, WAIT]).state;
    expect(currentStep(s)).toEqual({ kind: 'DECLARE', unitId: 'enemy1' });
    s = run(s, [accel(0, 1)]).state;
    expect(s.units[1]).toMatchObject({ heading: 3, speed: 1, pos: { q: 3, r: 4 } });
    s = run(s, [WAIT]).state;
    expect(s.round).toBe(2);
  });

  it('回合中陣亡的單位，剩下的步驟自動略過；敵人全滅 → 玩家勝', () => {
    let s = run(withEnemy(), [COAST]).state;
    s = patch(s, (n) => { n.units[1].alive = false; });
    const r = run(s, [WAIT]);
    expect(r.state.over).toEqual({ winner: 'PLAYER' });
    expect(checkLegal(r.state, COAST).reason).toContain('已結束');
  });

  it('玩家陣亡 → 敵方勝；開局沒有敵人的自由移動永遠不結束', () => {
    const s = withEnemy();
    expect(judge(patch(s, (n) => { n.units[0].alive = false; }))).toEqual({ winner: 'ENEMY' });
    expect(judge(s)).toBeNull();
    expect(judge(game('wk1'))).toBeNull();
  });

  it('撞上其他單位時停在它前面、速度歸零', () => {
    const s = game('jt1', { enemies: [{ chassis: 'tk1', hex: { q: 10, r: 2 }, facing: 3 }] });
    const r = run(s, [accel(0, 3)]);
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'COLLIDED' }));
    expect(player(r.state)).toMatchObject({ pos: { q: 10, r: 3 }, speed: 0 });
    expect(unitAt(r.state, { q: 10, r: 2 })?.id).toBe('enemy1');
    expect(unitAt(r.state, { q: 10, r: 2 }, 'enemy1')).toBeUndefined();
  });
});

describe('選取器與可重現性', () => {
  it('自動步驟上沒有 activeUnit；cursor 超出範圍時沒有 currentStep', () => {
    const s = game('wk1');
    expect(activeUnit(patch(s, (n) => { n.cursor = 1; }))).toBeNull();
    expect(currentStep(patch(s, (n) => { n.cursor = 99; }))).toBeNull();
    expect(checkLegal(patch(s, (n) => { n.cursor = 99; }), COAST).reason).toContain('沒有人');
    expect(unitById(s, 'ghost')).toBeUndefined();
    expect(playerUnit(s)?.id).toBe('player');
  });

  it('同一個種子、同一串指令 → 完全相同的狀態', () => {
    const cmds = [accel(0, 1), WAIT, accel(1, 1), TURN_R, WAIT, accel(3, 1), WAIT, COAST, WAIT];
    const a = run(game('wk1', { seed: 7 }), cmds).state;
    const b = run(game('wk1', { seed: 7 }), cmds).state;
    expect(JSON.stringify({ ...a, rules: 0, map: 0 })).toBe(JSON.stringify({ ...b, rules: 0, map: 0 }));
  });

  it('applyCommand 不改動傳入的狀態', () => {
    const s = game('jt1');
    const snap = JSON.stringify({ ...s, rules: 0, map: 0 });
    run(s, [accel(0, 2), TURN_R, WAIT]);
    expect(JSON.stringify({ ...s, rules: 0, map: 0 })).toBe(snap);
  });

  it('朝向與速度方向各自獨立：側滑', () => {
    let s = run(game('jt1', { map: flatMap(41, 41) }), [accel(0, 3), TURN_R, TURN_R, WAIT]).state;
    expect(player(s)).toMatchObject({ heading: 0, facing: 2 as Dir, speed: 1 });
    s = run(s, [COAST]).state;
    expect(player(s)).toMatchObject({ heading: 0, facing: 2, speed: 0 });
  });
});
