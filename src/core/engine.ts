/**
 * 回合引擎與指令 —— 規則層唯一的入口。
 *
 *   checkLegal(state, cmd)   能不能做、要花多少（介面拿它畫按鍵）
 *   applyCommand(state, cmd) 做下去，回傳新狀態與事件（不改動傳入的狀態）
 *
 * 非法指令回傳**同一個**狀態物件與空事件陣列 —— 呼叫端用 `next === state` 判斷被拒。
 *
 * 一回合 = 解算順序模組（order.ts）排出的步驟表。引擎只負責一步一步走：
 * 需要輸入的步驟（DECLARE、ACT）停下來等指令；自動步驟（MOVE、WORLD、停機中的單位）直接走完。
 *
 * 行動階段（右盤）什麼時候結束：
 *   - 主動按待機
 *   - AP 用完（歸零）
 *   - 透支：行動照常結算，然後結束，不夠的部分從下一個階段的配額扣
 *   - 過熱停機
 *
 * 自動單位（control = SCRIPT：靶與敵機）的階段由引擎照腳本直接走完，不等指令。
 * 敵機（腳本 DUEL）的行動由 ai.ts 一個一個挑，走的是和玩家同一段 checkLegal / perform。
 */
import { shotCheck, weaponOf } from './combat';
import { advanceCourse, hooksOf, newProgress } from './course';
import type { CourseHook, HookWhen } from './course';
import type { Dir, Hex } from './hex';
import { rotate } from './hex';
import type { GameMap, UnitSpawn } from './map';
import { addHeat, checkAp, passiveCool, payQuota, spendAp } from './economy';
import { accelHeat, accelLegality, driveOf, resolveMotion, worldOf } from './movement';
import { ORDERS } from './order';
import { createRng, nextFloat } from './rng';
import type { Rules } from './rules';
import { duelAction } from './ai';
import { scriptAccel, scriptFacing } from './script';
import type { AccelOrder, Command, GameEvent, GameState, Side, Step, Unit } from './state';
import { activeUnit, currentStep, unitById } from './state';

// ---------------------------------------------------------------- 開局

export interface UnitSetup {
  chassis: string;
  name?: string;
  /** 省略時用地圖的出生點。 */
  hex?: Hex;
  facing?: Dir;
}

export interface Setup {
  seed: number;
  player: UnitSetup;
  enemies?: UnitSetup[];
  /** 解算順序模組 id，預設 SEQUENTIAL。 */
  order?: string;
}

export function makeUnit(rules: Rules, id: string, side: Side, spec: UnitSetup, hex: Hex, facing: Dir): Unit {
  const c = rules.chassis[spec.chassis];
  if (!c) throw new Error('沒有這個機體：' + spec.chassis);
  return {
    id,
    name: spec.name ?? c.name,
    side,
    chassis: c.id,
    drive: c.drives[0],
    pos: { q: hex.q, r: hex.r },
    heading: facing,
    speed: 0,
    facing,
    ap: 0,
    debt: 0,
    heat: 0,
    shutdown: 0,
    facesTurned: 0,
    pendingAccel: null,
    alive: true,
    hp: c.hp,
    ammo: c.weapon ? rules.weapons[c.weapon].magazine : 0,
    control: 'INPUT',
    script: null,
  };
}

/** 放一個自動單位（靶）上場：地圖開局的 units，或 SPAWN 鉤子。id 重複就自動加編號。 */
function addScripted(s: GameState, sp: UnitSpawn): Unit {
  const base = sp.id ?? sp.chassis;
  let id = base;
  for (let n = 2; s.units.some((u) => u.id === id); n++) id = `${base}${n}`;
  const u = makeUnit(s.rules, id, 'ENEMY', { chassis: sp.chassis }, sp.hex, sp.facing);
  u.control = 'SCRIPT';
  u.script = structuredClone(sp.script);
  s.units.push(u);
  return u;
}

/** 開一局。回傳時已經停在第 1 回合玩家的加速宣告。 */
export function newGame(rules: Rules, map: GameMap, setup: Setup): GameState {
  const order = setup.order ?? 'SEQUENTIAL';
  if (!ORDERS[order]) throw new Error('沒有這個解算順序：' + order);
  const p = setup.player;
  const units: Unit[] = [
    // 玩家永遠先手 —— 步驟表照 units 的順序排，所以玩家必須在第一個。
    makeUnit(rules, 'player', 'PLAYER', p, p.hex ?? map.playerSpawn.hex, p.facing ?? map.playerSpawn.facing),
  ];
  (setup.enemies ?? []).forEach((e, i) => {
    const spawn = map.enemySpawns[i];
    const hex = e.hex ?? spawn?.hex;
    if (!hex) throw new Error(`敵人 ${i} 沒有指定位置，地圖也沒有第 ${i} 個敵方出生點`);
    units.push(makeUnit(rules, 'enemy' + (i + 1), 'ENEMY', e, hex, e.facing ?? spawn?.facing ?? 3));
  });
  const s: GameState = {
    rules,
    map,
    units,
    round: 0,
    order,
    steps: [],
    cursor: -1,
    rng: createRng(setup.seed),
    course: map.course ? newProgress() : null,
    stats: { shots: 0, hits: 0, kills: 0, enemyShots: 0, enemyHits: 0 },
    over: null,
  };
  for (const sp of map.units) addScripted(s, sp);
  // 開局時第一個檢查點就是目標：它的 ACTIVATE 鉤子裡、會改變局面的（SPAWN）在這裡生效。
  // 介面層的鉤子（MESSAGE 之類）由呼叫端自己用 hooksOf(course, 0, 'ACTIVATE') 取。
  if (map.course) for (const h of hooksOf(map.course, 0, 'ACTIVATE')) applyHookEffect(s, h, []);
  proceed(s, []);
  return s;
}

/**
 * core 自己會處理的鉤子：會改變局面的那幾種。其他 type 只轉發（COURSE_HOOK 事件），由訂閱的系統解讀。
 * 目前只有 SPAWN（生出一個自動單位）；之後的「開放按鍵」「換規則」之類也加在這裡。
 */
function applyHookEffect(s: GameState, h: CourseHook, ev: GameEvent[]): void {
  if (h.type === 'SPAWN' && h.spawn) {
    const u = addScripted(s, h.spawn as UnitSpawn);
    ev.push({ type: 'SPAWNED', unitId: u.id });
  }
}

// ---------------------------------------------------------------- 合法性

export interface Legal {
  ok: boolean;
  reason?: string;
  /** 這個指令的 AP 成本與產熱（加速宣告的熱是點數產生的）。 */
  ap: number;
  heat: number;
  /** 會新增的債務。> 0 時介面用警示色，而且做完這一下階段就結束。 */
  overdraft: number;
}

function no(reason: string): Legal {
  return { ok: false, reason, ap: 0, heat: 0, overdraft: 0 };
}

/** 下一面要付多少（轉向規則）：免費額度內 0，超過的照 actions.turn 收。 */
export function turnPrice(rules: Rules, u: Unit): { ap: number; heat: number } {
  const free = rules.drives[u.drive].turnRule.freeFacesPerTurn;
  if (free === 'ANY' || u.facesTurned < free) return { ap: 0, heat: 0 };
  return { ap: rules.actions.turn.ap, heat: rules.actions.turn.heat };
}

export function checkLegal(s: GameState, cmd: Command): Legal {
  if (s.over) return no('對局已結束');
  const step = currentStep(s);
  const u = activeUnit(s);
  if (!step || !u) return no('現在沒有人在等指令');
  const rules = s.rules;

  if (cmd.type === 'ACCEL') {
    if (step.kind !== 'DECLARE') return no('這回合已經宣告過加速');
    const l = accelLegality(rules, u, cmd.order);
    if (!l.ok) return no(l.reason!);
    return { ok: true, ap: 0, heat: accelHeat(driveOf(rules, u), cmd.order), overdraft: 0 };
  }

  // 其餘都是行動：順序是 左盤加速 → 位移 → 右盤行動。
  if (step.kind !== 'ACT') return no('先在左盤確認加速：行動在位移之後');

  const priced = (ap: number, heat: number): Legal => {
    const c = checkAp(rules, u, ap);
    if (!c.ok) return { ok: false, reason: c.reason, ap, heat, overdraft: c.overdraft };
    return { ok: true, ap, heat, overdraft: c.overdraft };
  };

  switch (cmd.type) {
    case 'TURN': {
      const p = turnPrice(rules, u);
      return priced(p.ap, p.heat);
    }
    case 'FIRE': {
      const w = weaponOf(rules, u);
      const target = unitById(s, cmd.targetId);
      if (!w) return no('沒有武器');
      if (!target) return { ...no('沒有這個目標'), ap: w.fire.ap, heat: w.fire.heat };
      const shot = shotCheck(s, u, target);
      if (!shot.ok) return { ...no(shot.reason!), ap: w.fire.ap, heat: w.fire.heat };
      return priced(w.fire.ap, w.fire.heat);
    }
    case 'RELOAD': {
      const w = weaponOf(rules, u);
      if (!w) return no('沒有武器');
      if (u.ammo >= w.magazine) return { ...no('彈匣是滿的'), ap: w.reload.ap, heat: w.reload.heat };
      return priced(w.reload.ap, w.reload.heat);
    }
    case 'COOL': {
      const a = rules.actions.cool;
      const l = priced(a.ap, a.heat);
      if (l.ok && u.heat === 0) return { ...l, ok: false, reason: '熱量已經是 0' };
      return l;
    }
    case 'SWITCH_DRIVE': {
      const a = rules.actions.switchDrive;
      if (rules.chassis[u.chassis].drives.length < 2) return { ...no('這台機體只有一種驅動'), ap: a.ap, heat: a.heat };
      return priced(a.ap, a.heat);
    }
    case 'WAIT':
      return { ok: true, ap: 0, heat: 0, overdraft: 0 };
  }
}

// ---------------------------------------------------------------- 指令

export function applyCommand(s: GameState, cmd: Command): { state: GameState; events: GameEvent[] } {
  const legal = checkLegal(s, cmd);
  if (!legal.ok) return { state: s, events: [] };
  const n = cloneState(s);
  const ev: GameEvent[] = [];
  const u = activeUnit(n)!;

  if (cmd.type === 'ACCEL') {
    u.pendingAccel = cmd.order;
    proceed(n, ev);
  } else {
    const reason = perform(n, u, cmd, legal, ev);
    if (reason) {
      endPhase(u, reason, ev);
      proceed(n, ev);
    }
  }
  return { state: n, events: ev };
}

type ActionCommand = Exclude<Command, { type: 'ACCEL' }>;

/**
 * 一個行動的效果（已經確認合法）。玩家的指令與敵機 AI 的指令都走這裡 —— 同一段程式碼，沒有捷徑。
 * 不推進步驟；回傳這個行動之後階段要不要結束（原因），null = 繼續等下一個行動。
 */
function perform(n: GameState, u: Unit, cmd: ActionCommand, legal: Legal, ev: GameEvent[]): EndReason | null {
  const rules = n.rules;
  switch (cmd.type) {
    case 'TURN': {
      const p = turnPrice(rules, u);
      spendAp(u, p.ap);
      const from = u.facing;
      u.facing = rotate(from, cmd.delta);
      u.facesTurned++;
      // 依機體類型，轉動機身也會吃掉速度
      u.speed = Math.max(0, u.speed - driveOf(rules, u).facingTurnSpeedLoss);
      ev.push({ type: 'TURNED', unitId: u.id, from, to: u.facing, speed: u.speed });
      heat(n, u, p.heat, ev);
      break;
    }
    case 'FIRE': {
      const w = weaponOf(rules, u)!;
      const target = unitById(n, cmd.targetId)!;
      const { chance } = shotCheck(n, u, target);
      spendAp(u, w.fire.ap);
      u.ammo--;
      // 擲骰走狀態裡的種子亂數：同一個種子、同一串指令，永遠同一個結果
      const hit = nextFloat(n.rng) * 100 < chance;
      const mine = u.side === 'PLAYER';
      if (mine) n.stats.shots++;
      else n.stats.enemyShots++;
      ev.push({
        type: 'FIRED', shooterId: u.id, targetId: target.id, hit, chance, damage: hit ? w.damage : 0,
        from: { ...u.pos }, to: { ...target.pos },
      });
      if (hit) {
        if (mine) n.stats.hits++;
        else n.stats.enemyHits++;
        target.hp = Math.max(0, target.hp - w.damage);
        if (target.hp === 0) {
          target.alive = false;
          if (mine) n.stats.kills++;
          ev.push({ type: 'DESTROYED', unitId: target.id, by: u.id });
        }
      }
      heat(n, u, w.fire.heat, ev);
      break;
    }
    case 'RELOAD': {
      const w = weaponOf(rules, u)!;
      spendAp(u, w.reload.ap);
      u.ammo = w.magazine;
      ev.push({ type: 'RELOADED', unitId: u.id, ammo: u.ammo });
      heat(n, u, w.reload.heat, ev);
      break;
    }
    case 'COOL': {
      const a = rules.actions.cool;
      spendAp(u, a.ap);
      heat(n, u, a.heat, ev);
      ev.push({ type: 'COOLED', unitId: u.id, heat: u.heat });
      break;
    }
    case 'SWITCH_DRIVE': {
      const a = rules.actions.switchDrive;
      const list = rules.chassis[u.chassis].drives;
      spendAp(u, a.ap);
      u.drive = list[(list.indexOf(u.drive) + 1) % list.length];
      // 新驅動的極速比現在的速度低時，當場夾住
      u.speed = Math.min(u.speed, driveOf(rules, u).maxSpeed);
      ev.push({ type: 'DRIVE', unitId: u.id, drive: u.drive });
      heat(n, u, a.heat, ev);
      break;
    }
    case 'WAIT':
      ev.push({ type: 'WAITED', unitId: u.id });
      return 'WAIT';
  }
  return phaseOver(u, legal);
}

/** rules 與 map 是不可變的參照，不跟著深複製。 */
function cloneState(s: GameState): GameState {
  const { rules, map, ...rest } = s;
  return { ...structuredClone(rest), rules, map };
}

// ---------------------------------------------------------------- 步驟推進

/** 前進到下一步，自動走完所有不需要輸入的步驟，停在下一個需要輸入的步驟。 */
function proceed(s: GameState, ev: GameEvent[]): void {
  for (;;) {
    s.cursor++;
    if (s.cursor >= s.steps.length) newRound(s, ev);
    if (!arrive(s, s.steps[s.cursor], ev)) return;
  }
}

function newRound(s: GameState, ev: GameEvent[]): void {
  s.round++;
  s.steps = ORDERS[s.order].schedule(s.units);
  s.cursor = 0;
  ev.push({ type: 'ROUND', round: s.round });
}

/** 抵達一個步驟。回傳 true = 這一步自動完成了，繼續往下；false = 停下來等輸入。 */
function arrive(s: GameState, step: Step, ev: GameEvent[]): boolean {
  switch (step.kind) {
    case 'DECLARE': {
      const u = unitById(s, step.unitId)!;
      if (!u.alive) return true;
      beginPhase(s, u, ev);
      // 停機中不能加速，但慣性照常 —— 所以不是跳過位移，而是強制「不加速」（照樣衰減）。
      if (u.shutdown > 0) {
        u.pendingAccel = null;
        return true;
      }
      // 自動單位：照腳本宣告，不等輸入
      if (u.control === 'SCRIPT') {
        u.pendingAccel = scriptAccel(s, u);
        return true;
      }
      return false;
    }
    case 'MOVE':
      // 步驟表保證 DECLARE 在 MOVE 之前；pendingAccel 為 null 就是「沒點、直接確認」
      for (const id of step.unitIds) {
        const u = unitById(s, id)!;
        if (u.alive) move(s, u, u.pendingAccel, ev);
        u.pendingAccel = null;
      }
      return true;
    case 'ACT': {
      const u = unitById(s, step.unitId)!;
      if (!u.alive) return true;
      if (u.shutdown > 0) {
        endPhase(u, 'SHUTDOWN', ev);
        return true;
      }
      // 敵機：照 AI 行動（跟玩家同一套規則）
      if (u.script?.kind === 'DUEL') {
        runAi(s, u, ev);
        return true;
      }
      // 自動單位：巡邏的把機首轉向目標（靶機轉向免費），然後結束
      if (u.control === 'SCRIPT') {
        const to = scriptFacing(u);
        if (to !== null) {
          ev.push({ type: 'TURNED', unitId: u.id, from: u.facing, to, speed: u.speed });
          u.facing = to;
        }
        endPhase(u, 'WAIT', ev);
        return true;
      }
      // 配額被債務吃光：AP 一開始就是 0，這個階段沒有事可做
      if (u.ap <= 0) {
        endPhase(u, 'AP_SPENT', ev);
        return true;
      }
      return false;
    }
    case 'WORLD':
      world(s);
      return s.over === null;
  }
}

function beginPhase(s: GameState, u: Unit, ev: GameEvent[]): void {
  payQuota(u, s.rules.chassis[u.chassis].apQuota);
  u.facesTurned = 0;
  ev.push({ type: 'PHASE', unitId: u.id });
}

type EndReason = 'WAIT' | 'AP_SPENT' | 'OVERDRAFT' | 'SHUTDOWN';

/** 階段結束：沒用完的 AP 作廢（配額不累積）；停機中的階段算一次服刑。 */
function endPhase(u: Unit, reason: EndReason, ev: GameEvent[]): void {
  u.ap = 0;
  ev.push({ type: 'PHASE_END', unitId: u.id, reason });
  if (u.shutdown > 0) {
    u.shutdown--;
    if (u.shutdown === 0) ev.push({ type: 'REBOOT', unitId: u.id });
  }
}

function move(s: GameState, u: Unit, order: AccelOrder, ev: GameEvent[]): void {
  const r = resolveMotion(worldOf(s, u.id), u, order);
  const from = u.pos;
  u.pos = r.pos;
  u.heading = r.heading;
  u.speed = r.speed;
  ev.push({ type: 'MOVED', unitId: u.id, order, from, to: r.pos, heading: r.heading, speed: r.speed, path: r.path });
  if (r.collision) ev.push({ type: 'COLLIDED', unitId: u.id, collision: r.collision });
  heat(s, u, r.heat, ev);
  // s.course 只在地圖有跑道時才建立，所以兩者同時存在
  if (u.side === 'PLAYER' && s.course) {
    const course = s.map.course!;
    const { progress, passed } = advanceCourse(course, s.course, r.path, u.speed, s.round);
    s.course = progress;
    const hook = (index: number, when: HookWhen): void => {
      for (const h of hooksOf(course, index, when)) {
        ev.push({ type: 'COURSE_HOOK', index, checkpointId: course.checkpoints[index].id, hook: h, round: s.round });
        applyHookEffect(s, h, ev);
      }
    };
    // 每個檢查點的 ACTIVATE 與 REACH 各發一次、依序發 —— 一次衝過好幾個也一樣
    // （第一個檢查點的 ACTIVATE 在開局時，由呼叫端用 hooksOf(course, 0, 'ACTIVATE') 取）
    for (const i of passed) {
      ev.push({ type: 'CHECKPOINT', index: i, id: course.checkpoints[i].id, round: s.round });
      hook(i, 'REACH');
      hook(i + 1, 'ACTIVATE');
    }
    // 跑完就當場結束，不必等到世界階段
    if (progress.done !== null) {
      ev.push({ type: 'COURSE_DONE', round: progress.done });
      s.over = judge(s);
    }
  }
}

/**
 * 加熱並處理過熱。
 *
 * 在自己的階段中過熱：這個階段剩下的部分當場作廢，再加上接下來 N 個完整階段 ——
 * 所以停機數要多算一個「現在這個」。
 */
function heat(s: GameState, u: Unit, delta: number, ev: GameEvent[]): void {
  if (!addHeat(s.rules, u, delta)) return;
  u.shutdown = s.rules.economy.overheatShutdownPhases + (inOwnPhase(s, u) ? 1 : 0);
  ev.push({ type: 'OVERHEAT', unitId: u.id });
}

function inOwnPhase(s: GameState, u: Unit): boolean {
  const step = currentStep(s);
  if (!step || step.kind === 'WORLD') return false;
  return step.kind === 'MOVE' ? step.unitIds.includes(u.id) : step.unitId === u.id;
}

/** 行動做完之後：過熱、透支、AP 用完，三者任一成立就結束這個階段。 */
function phaseOver(u: Unit, legal: Legal): EndReason | null {
  if (u.shutdown > 0) return 'SHUTDOWN';
  if (legal.overdraft > 0) return 'OVERDRAFT';
  if (legal.ap > 0 && u.ap <= 0) return 'AP_SPENT';
  return null;
}

/** 敵機的行動階段：一直問 AI 下一個指令，照玩家同一套 checkLegal / perform 結算，直到階段結束。 */
function runAi(s: GameState, u: Unit, ev: GameEvent[]): void {
  let reason: EndReason | null = null;
  // 一個階段最多就那幾個行動；上限只是保險，AI 出錯也不會卡死
  for (let guard = 0; guard < 12 && !reason; guard++) {
    const cmd = duelAction(s, u);
    const legal = checkLegal(s, cmd);
    reason = legal.ok ? perform(s, u, cmd as ActionCommand, legal, ev) : 'WAIT';
  }
  endPhase(u, reason ?? 'WAIT', ev);
}

/**
 * 世界階段：被動散熱、狀態計時、勝敗判定。
 * 停機的計時跟著「自己的階段」走（endPhase），不在這裡 —— 停機是少掉一個階段，不是少掉一段時間。
 */
function world(s: GameState): void {
  for (const u of s.units) if (u.alive) passiveCool(s.rules, u);
  s.over = judge(s);
}

/**
 * 勝敗判定。玩家陣亡 → 敵方勝；跑完跑道、或開局有敵人且全滅 → 玩家勝。
 * 靶（role TARGET）不算敵人：打光射擊場的靶不會提早結束，終點才是終點。
 * 沒有跑道也沒有敵人（試驗場）是自由移動，永遠不結束。
 */
export function judge(s: GameState): GameState['over'] {
  if (!s.units.some((u) => u.side === 'PLAYER' && u.alive)) return { winner: 'ENEMY' };
  if (s.course?.done != null) return { winner: 'PLAYER' };
  const enemies = s.units.filter((u) => u.side === 'ENEMY' && s.rules.chassis[u.chassis].role !== 'TARGET');
  if (enemies.length > 0 && enemies.every((u) => !u.alive)) return { winner: 'PLAYER' };
  return null;
}
