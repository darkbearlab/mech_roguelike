/**
 * 介面接線：輸入 → 指令 → core → 事件 → 演出與畫面。
 *
 * 規則全在 core/。這裡只做三件事：把按鍵翻成 Command、把 GameEvent 翻成動畫與提示、
 * 以及從 core 的純函式（checkLegal / resolveMotion）拿預測來畫幽靈標記 ——
 * 預測與實際走的是同一段程式碼，所以畫面上的落點就是按下去之後的落點。
 */
import { applyCommand, checkLegal, newGame, turnPrice } from '../core/engine';
import type { Hex, SubVec } from '../core/hex';
import { hexDist, hexLen, hexRound, subToHex } from '../core/hex';
import type { GameMap } from '../core/map';
import { cellAt, loadMap } from '../core/map';
import { ALL_CHOICES, choiceFromKey, choiceKey, resolveMotion, worldOf } from '../core/movement';
import type { Rules, RulesPatch } from '../core/rules';
import { RULES, withPatch } from '../core/rules';
import { rawMapById } from '../core/content';
import type { Command, GameEvent, GameState, Unit } from '../core/state';
import { activeUnit, currentStep, playerUnit } from '../core/state';
import type { Camera, SafeArea, WorldBounds } from '../render/camera';
import { computeCamera, effectivePan, hexSizeFor, mapBounds, screenToWorld } from '../render/camera';
import type { Pt } from '../render/geometry';
import { DIR_GLYPH, dirAngle, subToWorld, worldToAxial } from '../render/geometry';
import { Motion } from '../render/motion';
import type { Ghost } from '../render/renderer';
import { draw, speedText } from '../render/renderer';
import type { Cockpit, PadKey } from './config';
import { UI } from './config';
import { $ } from './dom';
import { Hud } from './hud';
import { Pads } from './pads';
import type { FuncKeyView, MoveKeyView } from './pads';
import { TuningPanel, loadPatch } from './tuning';

export interface GameOptions {
  seed: number;
  chassis: string;
  mapId: string;
}

const FUNC_LABEL: Record<PadKey, string> = {
  turnL: '⟲ 左轉', turnR: '右轉 ⟳', lock: '鎖定', fire: '射擊', reload: '裝填',
  swap: '換武器', cool: '散熱', switchDrive: '換驅動', wait: '待機',
};

/** 第 5 步才接線的武器鍵：先按 actions.json 顯示成本，但不能按。 */
const WEAPON_ACTION: Partial<Record<PadKey, keyof Rules['actions']>> = {
  lock: 'lock', fire: 'fireLight', reload: 'reload', swap: 'swap',
};

export class Game {
  state!: GameState;
  private patch: RulesPatch = loadPatch();
  private rules: Rules = RULES;
  private map!: GameMap;
  private bounds!: WorldBounds;
  private chassis: string;

  private canvas = $('map') as HTMLCanvasElement;
  private ctx = this.canvas.getContext('2d')!;
  private viewW = 0;
  private viewH = 0;
  private safe: SafeArea = { top: 0, bottom: 0 };
  private cam: Camera = { size: 24, ox: 0, oy: 0 };

  private motion = new Motion();
  private hud = new Hud();
  private pads: Pads;

  private pan: Pt = { x: 0, y: 0 };
  private picked: Hex | null = null;
  private previewKey: string | null = null;
  private ghostCache: { state: GameState; ghosts: Ghost[] } | null = null;
  private trail: SubVec[] = [];
  private dirty = true;
  private wasAnimating = false;

  constructor(private opts: GameOptions) {
    this.chassis = opts.chassis;
    this.pads = new Pads($('move-pad'), $('func-pad'), {
      preview: (k) => {
        this.previewKey = k;
        this.dirty = true;
      },
      accel: (k) => this.dispatch({ type: 'ACCEL', choice: choiceFromKey(k) }),
      action: (k) => this.pressFunc(k),
      refused: (reason) => this.hud.toast(reason, 'warn'),
    });
    this.pads.buildMove(UI.movePad);
    // 面板自己綁 ⚙ 按鈕；Game 只提供它需要的幾個存取點
    new TuningPanel({
      rules: () => this.rules,
      base: () => RULES,
      chassis: () => this.chassis,
      patch: () => this.patch,
      setPatch: (p) => this.applyPatch(p),
      setChassis: (id) => {
        this.chassis = id;
        this.restart();
      },
      restart: () => this.restart(),
    });
    this.rebuildRules();
    this.restart();
    this.bindInput();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- 開局與調參

  restart(): void {
    this.state = newGame(this.rules, this.map, { seed: this.opts.seed, player: { chassis: this.chassis } });
    this.trail = [];
    this.pan = { x: 0, y: 0 };
    this.picked = null;
    this.motion.finish();
    this.pads.buildFunc(this.cockpit().pad);
    this.refresh();
  }

  private rebuildRules(): void {
    this.rules = withPatch(RULES, this.patch);
    const raw = rawMapById(this.opts.mapId) ?? rawMapById('proving_ground')!;
    // 地形阻力是讀圖時烘進格子的，所以調了地形就要重讀地圖（幾何不變）
    this.map = loadMap(this.rules, raw);
    this.bounds = mapBounds(this.map);
  }

  /** 換一份規則但保留當下的局面 —— 調完參數可以接著開，不必回到出生點。 */
  private applyPatch(p: RulesPatch): void {
    this.patch = p;
    this.rebuildRules();
    this.state = { ...this.state, rules: this.rules, map: this.map };
    this.ghostCache = null;
    this.refresh();
  }

  private cockpit(): Cockpit {
    return UI.cockpits[this.rules.chassis[this.chassis].cockpit];
  }

  // ---------------------------------------------------------------- 指令

  dispatch(cmd: Command): void {
    const legal = checkLegal(this.state, cmd);
    if (!legal.ok) {
      this.hud.toast(legal.reason ?? '不能這樣做', 'warn');
      return;
    }
    const { state, events } = applyCommand(this.state, cmd);
    this.motion.finish();
    this.state = state;
    if (cmd.type === 'ACCEL' && UI.camera.recenterAfterMove) this.pan = { x: 0, y: 0 };
    this.present(events);
    this.refresh();
  }

  private pressFunc(k: PadKey): void {
    switch (k) {
      case 'turnL': return this.dispatch({ type: 'TURN', delta: -1 });
      case 'turnR': return this.dispatch({ type: 'TURN', delta: 1 });
      case 'cool': return this.dispatch({ type: 'COOL' });
      case 'switchDrive': return this.dispatch({ type: 'SWITCH_DRIVE' });
      case 'wait': return this.dispatch({ type: 'WAIT' });
      default: this.hud.toast('第 5 步才接線（單一武器與命中公式）', 'info');
    }
  }

  /** 事件 → 動畫與提示。 */
  private present(events: GameEvent[]): void {
    const now = performance.now();
    const a = UI.animation;
    for (const e of events) {
      switch (e.type) {
        case 'MOVED': {
          const hexes = Math.max(0, e.path.length - 1);
          const dur = Math.min(a.maxMoveMs, Math.max(a.minMoveMs, hexes * a.msPerHex));
          const bump = events.some((x) => x.type === 'COLLIDED' && x.unitId === e.unitId);
          const moved = hexLen({ q: e.to.q - e.from.q, r: e.to.r - e.from.r }) > 0;
          if (moved) this.motion.move(e.unitId, e.from, e.to, now, dur, bump);
          if (e.unitId === 'player') {
            this.trail.push(e.from);
            if (this.trail.length > UI.preview.trailLength) this.trail.shift();
          }
          break;
        }
        case 'TURNED':
          this.motion.turn(e.unitId, dirAngle(e.from), dirAngle(e.to), now, a.turnMs);
          break;
        case 'COLLIDED': {
          const what = e.collision.blocker === 'EDGE' ? '地圖邊緣' : e.collision.blocker === 'UNIT' ? '其他機體' : '稜線';
          this.hud.toast(`撞上${what}（${(e.collision.speed / 10).toFixed(1)} 格/回）— 速度歸零`, 'bad');
          break;
        }
        case 'OVERHEAT':
          this.hud.toast('過熱！強制停機：這回合剩下的行動取消，下回合只能滑行', 'bad');
          break;
        case 'REBOOT':
          this.hud.toast('重新開機', 'info');
          break;
        case 'DRIVE':
          this.hud.toast('驅動切換：' + this.rules.drives[e.drive].name, 'info');
          break;
        default:
          break;
      }
    }
  }

  // ---------------------------------------------------------------- 畫面資料

  private me(): Unit {
    return playerUnit(this.state)!;
  }

  private isDeclare(): boolean {
    const u = activeUnit(this.state);
    return !!u && u.side === 'PLAYER' && currentStep(this.state)?.kind === 'DECLARE';
  }

  private isAct(): boolean {
    const u = activeUnit(this.state);
    return !!u && u.side === 'PLAYER' && currentStep(this.state)?.kind === 'ACT';
  }

  /** 八個選項的預測。每個狀態只算一次。 */
  private ghosts(): Ghost[] {
    if (this.ghostCache?.state === this.state) return this.ghostCache.ghosts;
    const s = this.state;
    const u = this.me();
    const w = worldOf(s, u.id);
    const ghosts = ALL_CHOICES.map((c): Ghost => {
      const m = resolveMotion(w, u, c);
      return {
        key: choiceKey(c),
        glyph: c.kind === 'DIR' ? DIR_GLYPH[c.dir] : c.kind === 'CRUISE' ? '○' : '■',
        pos: m.posSub,
        vel: m.velSub,
        path: m.path,
        collision: m.collision?.at ?? null,
        legal: checkLegal(s, { type: 'ACCEL', choice: c }).ok,
      };
    });
    this.ghostCache = { state: s, ghosts };
    return ghosts;
  }

  /** 巡航預測：從 base 開始照速度滑行幾回合（撞到就停）。 */
  private drift(base: { pos: SubVec; vel: SubVec }): SubVec[] {
    const s = this.state;
    const w = worldOf(s, 'player');
    let u: Unit = { ...this.me(), posSub: base.pos, velSub: base.vel };
    const out: SubVec[] = [];
    for (let i = 0; i < UI.preview.driftTurns; i++) {
      const m = resolveMotion(w, u, { kind: 'CRUISE' });
      // 已經停了（或撞停在原地）就不再畫同一個點
      if (m.posSub.q === u.posSub.q && m.posSub.r === u.posSub.r) break;
      out.push(m.posSub);
      if (m.collision || hexLen(m.velSub) === 0) break;
      u = { ...u, posSub: m.posSub, velSub: m.velSub };
    }
    return out;
  }

  private refresh(): void {
    this.dirty = true;
    const s = this.state;
    const u = this.me();
    const rules = this.rules;
    const c = rules.chassis[u.chassis];
    const drive = rules.drives[u.drive];
    const declare = this.isDeclare();
    const act = this.isAct();

    // 左盤
    const gs = this.ghosts();
    const moves: MoveKeyView[] = gs.map((g) => {
      const l = checkLegal(s, { type: 'ACCEL', choice: choiceFromKey(g.key) });
      const glyph = g.key === 'CRUISE' ? '巡航' : g.key === 'BRAKE' ? '制動' : g.glyph;
      return {
        key: g.key, glyph, speed: speedText(g.vel), heat: l.heat,
        enabled: l.ok, reason: l.reason, collision: g.collision !== null,
      };
    });
    this.pads.updateMove(moves, declare);

    // 右盤
    const cp = this.cockpit();
    this.pads.buildFunc(cp.pad);
    const funcs: FuncKeyView[] = cp.pad.flat().map((k) => this.funcView(k));
    this.pads.updateFunc(funcs, act);

    this.hud.update({
      chassisName: c.name,
      driveName: drive.name + (c.drives.length > 1 ? `（${c.drives.map((d) => rules.drives[d].name).join('／')}）` : ''),
      velSub: u.velSub,
      maxSpeed: drive.maxSpeed,
      facing: u.facing,
      heat: u.heat,
      heatCap: c.heatCap,
      hotAbove: rules.combat.heatPenaltyAbove,
      shutdown: u.shutdown > 0,
      ap: u.ap,
      quota: c.apQuota,
      debt: u.debt,
      debtCap: rules.economy.apDebtCap,
      round: s.round,
      readouts: cp.readouts,
    });
    $('btn-recenter').classList.toggle('hidden', this.pan.x === 0 && this.pan.y === 0);
  }

  private funcView(k: PadKey): FuncKeyView {
    const s = this.state;
    const u = this.me();
    const weapon = WEAPON_ACTION[k];
    if (weapon) {
      const a = this.rules.actions[weapon];
      return { key: k, label: FUNC_LABEL[k], sub: costText(a.ap, a.heat), enabled: false, warn: false, reason: '第 5 步才接線（單一武器與命中公式）' };
    }
    const cmd: Command = k === 'turnL' ? { type: 'TURN', delta: -1 }
      : k === 'turnR' ? { type: 'TURN', delta: 1 }
        : k === 'cool' ? { type: 'COOL' }
          : k === 'switchDrive' ? { type: 'SWITCH_DRIVE' }
            : { type: 'WAIT' };
    const l = checkLegal(s, cmd);
    let sub = costText(l.ap, l.heat);
    if (k === 'turnL' || k === 'turnR') sub = turnPrice(this.rules, u).ap === 0 ? '免費' : costText(l.ap, l.heat);
    if (k === 'wait') sub = '結束回合';
    if (k === 'switchDrive') {
      const list = this.rules.chassis[u.chassis].drives;
      const next = list[(list.indexOf(u.drive) + 1) % list.length];
      sub = list.length > 1 ? `→${this.rules.drives[next].name} · ${costText(l.ap, l.heat)}` : '單一驅動';
    }
    return { key: k, label: FUNC_LABEL[k], sub, enabled: l.ok, warn: l.overdraft > 0, reason: l.reason };
  }

  // ---------------------------------------------------------------- 輸入

  private bindInput(): void {
    const cv = this.canvas;
    let down: { x: number; y: number; id: number; panX: number; panY: number } | null = null;
    let dragging = false;
    cv.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, id: e.pointerId, panX: this.pan.x, panY: this.pan.y };
      dragging = false;
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!down || e.pointerId !== down.id) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (!dragging && Math.hypot(dx, dy) > 8) dragging = true;
      if (dragging) {
        this.pan = { x: down.panX - dx / this.cam.size, y: down.panY - dy / this.cam.size };
        this.clampPan();
        this.dirty = true;
        $('btn-recenter').classList.remove('hidden');
      }
    });
    cv.addEventListener('pointerup', (e) => {
      if (!down || e.pointerId !== down.id) return;
      if (!dragging) this.pick(e.clientX, e.clientY);
      down = null;
    });
    cv.addEventListener('pointercancel', () => {
      down = null;
    });
    $('btn-recenter').addEventListener('click', () => {
      this.pan = { x: 0, y: 0 };
      this.refresh();
    });

    // 桌機測試用的鍵盤：QWE / ASD = 六向、空白 = 巡航、X = 制動；← → 轉向、C 散熱、V 切換、Enter 待機
    const keys: Record<string, () => void> = {
      q: () => this.keyAccel('5'), w: () => this.keyAccel('0'), e: () => this.keyAccel('1'),
      a: () => this.keyAccel('4'), s: () => this.keyAccel('3'), d: () => this.keyAccel('2'),
      ' ': () => this.keyAccel('CRUISE'), x: () => this.keyAccel('BRAKE'),
      arrowleft: () => this.pressFunc('turnL'), arrowright: () => this.pressFunc('turnR'),
      c: () => this.pressFunc('cool'), v: () => this.pressFunc('switchDrive'), enter: () => this.pressFunc('wait'),
    };
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const f = keys[e.key.toLowerCase()];
      if (f) {
        e.preventDefault();
        f();
      }
    });
  }

  private keyAccel(key: string): void {
    if (!this.isDeclare()) {
      this.hud.toast('行動階段：按 Enter（待機）結束這一回合', 'warn');
      return;
    }
    this.dispatch({ type: 'ACCEL', choice: choiceFromKey(key) });
  }

  /** 點地圖：顯示那一格的地形與距離（同一把尺）。 */
  private pick(x: number, y: number): void {
    const w = screenToWorld(this.cam, x, y);
    const a = worldToAxial(w.x, w.y);
    const hex = hexRound(a.q, a.r);
    const cell = cellAt(this.map, hex);
    if (!cell) {
      this.picked = null;
      this.dirty = true;
      return;
    }
    this.picked = hex;
    const t = this.rules.terrain[cell.terrain];
    const dist = hexDist(subToHex(this.me().posSub), hex);
    const bits = [t.name, `距離 ${dist}`, `高度 ${cell.elevation}`];
    if (cell.dragModifier) bits.push(`阻力 +${cell.dragModifier}`);
    if (!cell.passable) bits.push('不可進入');
    if (cell.blocksLos) bits.push('擋視線');
    this.hud.toast(bits.join(' · '));
    this.dirty = true;
  }

  // ---------------------------------------------------------------- 畫面

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.viewW = window.innerWidth;
    this.viewH = window.innerHeight;
    this.canvas.width = Math.round(this.viewW * dpr);
    this.canvas.height = Math.round(this.viewH * dpr);
    this.canvas.style.width = this.viewW + 'px';
    this.canvas.style.height = this.viewH + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  private measureSafe(): void {
    this.safe = {
      top: $('hud').getBoundingClientRect().bottom,
      bottom: $('controls').getBoundingClientRect().top,
    };
  }

  private focusPoint(now: number): Pt {
    const u = this.me();
    return subToWorld(this.motion.posOf(u.id, u.posSub, now));
  }

  private clampPan(): void {
    const size = hexSizeFor(this.viewW, UI.camera.hexesAcross, UI.camera.minHexPx, UI.camera.maxHexPx);
    const focus = this.focusPoint(performance.now());
    const cam = computeCamera(this.bounds, this.viewW, this.viewH, size, focus, this.pan, this.safe);
    this.pan = effectivePan(cam, this.viewW, this.safe, focus);
    if (Math.abs(this.pan.x) < 1e-6 && Math.abs(this.pan.y) < 1e-6) this.pan = { x: 0, y: 0 };
  }

  private loop = (now: number): void => {
    const animating = this.motion.active(now);
    // 動畫剛結束的那一幀一定要再畫一次：速度箭頭、幽靈標記、巡航預測都只在靜止時畫。
    // （用「上一幀還在動」判斷，而不是猜下一幀的時間 —— 幀間隔不固定。）
    if (this.wasAnimating && !animating) this.dirty = true;
    this.wasAnimating = animating;
    if (this.dirty || animating) {
      this.dirty = false;
      this.measureSafe();
      const size = hexSizeFor(this.viewW, UI.camera.hexesAcross, UI.camera.minHexPx, UI.camera.maxHexPx);
      this.cam = computeCamera(this.bounds, this.viewW, this.viewH, size, this.focusPoint(now), this.pan, this.safe);
      const declare = this.isDeclare();
      const ghosts = declare && UI.preview.showAllGhosts ? this.ghosts() : [];
      const focus = declare && this.previewKey ? this.ghosts().find((g) => g.key === this.previewKey) ?? null : null;
      const u = this.me();
      const drift = this.drift(focus ? { pos: focus.pos, vel: focus.vel } : { pos: u.posSub, vel: u.velSub });
      draw(this.ctx, {
        state: this.state, cam: this.cam, viewW: this.viewW, viewH: this.viewH, now,
        motion: this.motion, ghosts, focus, drift, trail: this.trail, picked: this.picked,
      });
    }
    requestAnimationFrame(this.loop);
  };
}

function costText(ap: number, heat: number): string {
  const h = heat === 0 ? '' : heat > 0 ? ` · +${heat}` : ` · ${heat}`;
  return `${ap} AP${h}`;
}
