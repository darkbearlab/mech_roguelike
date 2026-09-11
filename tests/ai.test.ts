import { describe, expect, it } from 'vitest';
import { affordableTurn, duelAction, duelDeclare, duelGoal, foeOf, tacticalCost } from '../src/core/ai';
import { newGame, planTurn } from '../src/core/engine';
import type { Dir, Hex } from '../src/core/hex';
import { hexDist } from '../src/core/hex';
import { cellAt, duelists, loadMap, withUnitChassis } from '../src/core/map';
import type { RawMap, RawUnit } from '../src/core/map';
import { allOrders } from '../src/core/movement';
import { RULES } from '../src/core/rules';
import type { Rules } from '../src/core/rules';
import type { GameState } from '../src/core/state';
import { unitById } from '../src/core/state';
import { COAST, WAIT, customRules, flatRaw, patch, player, run } from './helpers';

interface ArenaOpts {
  rules?: Rules;
  chassis?: string;
  rival?: string;
  /** 對手的位移座標與機首。玩家在 (10,10) = axial (10,5)，朝北。 */
  col?: number;
  row?: number;
  facing?: Dir;
  extra?: RawUnit[];
  raw?: RawMap;
  hex?: Hex;
}

/** 21×21 的空地：玩家在中央朝北，對手預設在正前方 4 格、朝南（面對面）。 */
function arena(o: ArenaOpts = {}): GameState {
  const rules = o.rules ?? RULES;
  const raw = o.raw ?? flatRaw(21, 21);
  raw.units = [
    { id: 'rival', chassis: o.rival ?? 'wk1', col: o.col ?? 10, row: o.row ?? 6, facing: o.facing ?? 3, ai: 'DUEL' },
    ...(o.extra ?? []),
  ];
  return newGame(rules, loadMap(rules, raw), { seed: 1, player: { chassis: o.chassis ?? 'wk1', hex: o.hex } });
}

const rival = (s: GameState) => unitById(s, 'rival')!;
/** 必中（命中率夾在 100）。 */
const SURE = customRules((r) => { r.combat.maxHit = 100; r.fireControls.std.aptitude.rifle = 100; });

describe('對手是誰', () => {
  it('另一邊、還活著、不是靶；有好幾個取最近的', () => {
    const s = arena({
      extra: [
        { id: 'near', chassis: 'target', col: 10, row: 8 },
        { id: 'rival2', chassis: 'tk1', col: 10, row: 13, ai: 'DUEL' },
      ],
    });
    // 固定靶最近，但靶不算對手；兩台敵機取近的
    expect(foeOf(s, player(s))!.id).toBe('rival2');
    expect(foeOf(s, rival(s))!.id).toBe('player');
    const dead = patch(s, (n) => { for (const u of n.units) if (u.side === 'ENEMY') u.alive = false; });
    expect(foeOf(dead, player(dead))).toBeNull();
  });
});

describe('往哪開', () => {
  it('還遠：沿直線靠到有利射程；近了：同樣距離、偏 60° 繞圈', () => {
    const far = arena({ row: 0 });   // axial (10,−5)：距離 10
    const g = duelGoal(far, rival(far), player(far));
    expect(g).toEqual({ q: 10, r: 2 });   // 玩家往北 3 格 = 對著它的那一側
    const near = arena();   // 距離 4
    const g2 = duelGoal(near, rival(near), player(near));
    expect(hexDist(g2, player(near).pos)).toBe(3);
    expect(g2).not.toEqual({ q: 10, r: 2 });
  });

  it('目標格在地圖外就換方向；全部在外面就直接往對手去', () => {
    const corner = arena({ hex: { q: 1, r: 1 }, col: 1, row: 8 });
    const g = duelGoal(corner, rival(corner), player(corner));
    expect(cellAt(corner.map, g)).not.toBeNull();
    // 3×3 的小圖：對手身邊 3 格全在圖外
    const tiny = flatRaw(3, 3);
    const s = arena({ raw: tiny, col: 0, row: 0 });
    expect(duelGoal(s, rival(s), player(s))).toEqual(player(s).pos);
  });

  it('沒有對手就不動；遠的時候機首轉向目標、照導航靠近', () => {
    const s = arena({ row: 0, facing: 0 });   // 背對玩家、距離 10
    expect(duelDeclare(patch(s, (n) => { n.units[0].alive = false; }), rival(s))).toEqual({ turn: 0, order: null });
    const d = duelDeclare(s, rival(s));
    // 步行只有第一面免費、配額 1：付得起兩面（第二面 1 AP）—— 還遠，打不到，AP 拿去轉向
    expect(Math.abs(d.turn)).toBeGreaterThan(0);
    const before = hexDist(rival(s).pos, player(s).pos);
    const after = run(s, [COAST, WAIT]).state;
    expect(hexDist(rival(after).pos, player(after).pos)).toBeLessThan(before);
  });

  it('近了：每個付得起的轉向 × 每個合法加速都推演一回合，挑分數最低的', () => {
    const s = arena();
    const d = duelDeclare(s, rival(s));
    const plan = planTurn(RULES, rival(s), d.turn);
    expect(plan.ok).toBe(true);
    const all = allOrders(RULES, plan.unit);
    expect(all).toContainEqual(d.order);
    // 不轉的選項裡最好的，不會比選中的好
    const bestNoTurn = Math.min(...allOrders(RULES, rival(s)).map((x) => tacticalCost(s, rival(s), player(s), x)));
    expect(tacticalCost(s, plan.unit, player(s), d.order) + Math.abs(d.turn) * 0.05).toBeLessThanOrEqual(bestNoTurn);
  });

  // 敵機的 AP 在它自己的階段開頭才補：在玩家的階段看它，要先照它的配額補上
  const ready = (s: GameState) => patch(s, (n) => { n.units[1].ap = 1; });

  it('近了、背對對手：先轉過去（這回合反正打不到，也要替下一回合擺好機首）', () => {
    const s = ready(arena({ facing: 0 }));   // 在玩家正北 4 格、朝北 = 背對
    const d = duelDeclare(s, rival(s));
    const t = planTurn(RULES, rival(s), d.turn).unit;
    expect(Math.abs(d.turn)).toBeGreaterThan(1);
    expect([2, 3, 4]).toContain(t.facing);
  });

  it('評分：移動完打不到（背對對手、或 AP 花在轉向上）扣分；撞上扣很多', () => {
    const facing = ready(arena());
    const away = ready(arena({ facing: 0 }));
    // 同樣不加速：背對玩家的那台打不到，分數高
    expect(tacticalCost(away, rival(away), player(away), null)).toBeGreaterThan(tacticalCost(facing, rival(facing), player(facing), null));
    // 轉向把 AP 花光（例如履帶）：面對玩家也沒得打
    const broke = { ...rival(facing), ap: 0 };
    expect(tacticalCost(facing, broke, player(facing), null)).toBeGreaterThan(tacticalCost(facing, rival(facing), player(facing), null));
    // 貼在玩家正前方、朝南往前推 = 撞上玩家
    const touching = arena({ row: 9 });
    const bump = tacticalCost(touching, rival(touching), player(touching), { rel: 0, taps: 1 });
    expect(bump).toBeGreaterThanOrEqual(12);
  });

  it('付得起幾面轉幾面', () => {
    const s = arena({ chassis: 'tk1' });
    // 履帶每面 1 AP、配額 1：想轉 3 面也只轉得了 1 面
    expect(affordableTurn(s, player(s), 3)).toBe(1);
    expect(affordableTurn(s, player(s), -2)).toBe(-1);
    expect(affordableTurn(s, { ...player(s), ap: 0 }, 2)).toBe(0);
  });
});

describe('行動（用玩家自己的行動階段測：AI 只透過 checkLegal 看局面）', () => {
  const act = (o: ArenaOpts = {}) => run(arena(o), [COAST]).state;

  it('打得中就打', () => {
    const s = act();
    expect(duelAction(s, player(s))).toEqual({ type: 'FIRE', targetId: 'rival' });
  });

  it('命中率太低就不打', () => {
    const s = act({ rules: customRules((r) => { r.fireControls.std.aptitude.rifle = 5; r.weapons.rifle.optimal.bonus = 0; }) });
    expect(duelAction(s, player(s))).toEqual({ type: 'WAIT' });
  });

  it('行動階段不再轉向：對手在背後就散熱或待機（轉向是下一回合機動宣告的事）', () => {
    const behind = act({ row: 14 });
    expect(duelAction(behind, player(behind))).toEqual({ type: 'WAIT' });
    const hot = patch(behind, (n) => { n.units[0].heat = 80; });
    expect(duelAction(hot, player(hot))).toEqual({ type: 'COOL' });
  });

  it('打光了就裝填；沒有對手就待機', () => {
    const empty = patch(act(), (n) => { n.units[0].ammo = 0; });
    expect(duelAction(empty, player(empty))).toEqual({ type: 'RELOAD' });
    const alone = patch(act(), (n) => { n.units[1].alive = false; });
    expect(duelAction(alone, player(alone))).toEqual({ type: 'WAIT' });
  });
});

describe('引擎：敵機跟玩家用同一套規則', () => {
  it('玩家待機之後，敵機自己移動、開槍；紀錄敵方的射擊', () => {
    const r = run(arena(), [COAST, WAIT]);
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'MOVED', unitId: 'rival' }));
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'FIRED', shooterId: 'rival', targetId: 'player' }));
    expect(r.state.stats.enemyShots).toBe(1);
    expect(r.state.stats.shots).toBe(0);
    // 回到玩家的加速宣告
    expect(r.state.steps[r.state.cursor]).toEqual({ kind: 'DECLARE', unitId: 'player' });
  });

  it('噴射機背對玩家：機動宣告裡轉過來（免費、吃速度）→ 移動 → 開槍', () => {
    const r = run(arena({ rival: 'jt1', facing: 0 }), [COAST, WAIT]);
    const mine = r.events.filter((e) => ('unitId' in e && e.unitId === 'rival') || ('shooterId' in e && e.shooterId === 'rival'));
    const kinds = mine.map((e) => e.type);
    expect(kinds).toContain('TURNED');
    expect(kinds.indexOf('MOVED')).toBeGreaterThan(kinds.indexOf('TURNED'));
    expect(kinds.indexOf('FIRED')).toBeGreaterThan(kinds.indexOf('MOVED'));
  });

  it('被打爆 → 敵方勝；打爆敵機 → 玩家勝', () => {
    const lose = patch(arena({ rules: SURE }), (n) => { n.units[0].hp = 10; });
    const r1 = run(lose, [COAST, WAIT]);
    expect(r1.events).toContainEqual({ type: 'DESTROYED', unitId: 'player', by: 'rival' });
    expect(r1.state.over).toEqual({ winner: 'ENEMY' });
    expect(r1.state.stats.enemyHits).toBe(1);
    const win = patch(arena({ rules: SURE }), (n) => { n.units[1].hp = 10; });
    const r2 = run(win, [COAST, { type: 'FIRE', targetId: 'rival' }]);
    expect(r2.state.over).toEqual({ winner: 'PLAYER' });
  });

  it('擲骰走種子亂數：同一個種子、同一串指令 → 同一場', () => {
    const a = run(arena(), [COAST, WAIT, COAST, WAIT, COAST, WAIT]).events;
    const b = run(arena(), [COAST, WAIT, COAST, WAIT, COAST, WAIT]).events;
    expect(a).toEqual(b);
  });
});

describe('地圖：敵機與決鬥場', () => {
  it('ai: DUEL 讀成敵機腳本；決鬥場讀得進來；可以換對手的機體', () => {
    const s = arena();
    expect(rival(s)).toMatchObject({ control: 'SCRIPT', side: 'ENEMY', script: { kind: 'DUEL' } });
    const raw = flatRaw(9, 9);
    raw.units = [{ chassis: 'wk1', col: 1, row: 1, ai: 'SMART' }];
    expect(() => loadMap(RULES, raw)).toThrow('ai 只能是 DUEL');
    const map = loadMap(RULES, (() => { const r = flatRaw(9, 9); r.units = [{ id: 'x', chassis: 'wk1', col: 1, row: 1, ai: 'DUEL' }, { chassis: 'target', col: 3, row: 3 }]; r.brief = '說明'; return r; })());
    expect(duelists(map)).toEqual(['x']);
    expect(map.brief).toBe('說明');
    expect(withUnitChassis(RULES, map, 'x', 'jt1').units[0].chassis).toBe('jt1');
    expect(map.units[0].chassis).toBe('wk1');
    expect(withUnitChassis(RULES, map, 'x', 'ufo')).toBe(map);
    // 沒有 id 的單位用機體名當 id
    expect(withUnitChassis(RULES, map, 'target', 'drone').units[1].chassis).toBe('drone');
  });
});
