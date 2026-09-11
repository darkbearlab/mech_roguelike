/**
 * 介面接線：輸入 → 指令 → core → 事件 → 演出與畫面。
 *
 * 規則全在 core/。這裡只做三件事：把按鍵翻成 Command、把 GameEvent 翻成動畫與提示、
 * 以及從 core 的純函式（checkLegal / resolveMotion）拿預測來畫 ——
 * 預測與實際走的是同一段程式碼，所以畫面上的落點就是按下去之後的落點。
 *
 * 左盤的「點了哪個方向、點了幾下」與「選了哪個目標」是介面狀態，放在這裡，不進 GameState。
 *
 * 射擊：行動階段自動選命中率最高的目標；點地圖上的目標 = 手動選（並列出命中明細）。
 * 加速階段的命中率與射界是照「這樣加速之後」的位置算的 —— 靶在玩家行動之後才動，
 * 所以宣告階段看到的數字就是行動階段按下射擊時的數字（只要不再轉向）。
 */
import { arcHexes, inOptimal, shotCheck, targetsFor, weaponOf } from '../core/combat';
import type { ShotCheck } from '../core/combat';
import { hooksOf } from '../core/course';
import type { CourseHook } from '../core/course';
import { applyCommand, checkLegal, newGame, planTurn } from '../core/engine';
import type { TurnPlan } from '../core/engine';
import type { Hex } from '../core/hex';
import { DIR_NAME, hexDist, hexRound, sameHex } from '../core/hex';
import type { GameMap } from '../core/map';
import { cellAt, duelists, loadMap, withUnitChassis } from '../core/map';
import { accelLegality, driveOf, maxTaps, resolveMotion, worldOf } from '../core/movement';
import type { MotionResult } from '../core/movement';
import type { Rules, RulesPatch } from '../core/rules';
import { RULES, withPatch } from '../core/rules';
import { rawMapById } from '../core/content';
import type { AccelOrder, Command, GameEvent, GameState, RelDir, Unit } from '../core/state';
import { activeUnit, currentStep, playerUnit, unitById } from '../core/state';
import type { Camera, SafeArea, WorldBounds } from '../render/camera';
import { computeCamera, effectivePan, hexSizeFor, mapBounds, screenToWorld } from '../render/camera';
import { Effects } from '../render/effects';
import type { Pt } from '../render/geometry';
import { DIR_GLYPH, REL_NAME, axialToWorld, dirAngle, worldToAxial } from '../render/geometry';
import { Motion } from '../render/motion';
import type { ArcCell, Preview, RelHint, TargetView } from '../render/renderer';
import { draw } from '../render/renderer';
import type { Cockpit, PadKey } from './config';
import { UI } from './config';
import { $ } from './dom';
import { Hud } from './hud';
import { Pads } from './pads';
import type { ConfirmView, FuncKeyView, MoveKeyView, TurnView } from './pads';
import { bestOf, recordFinish, savePrefs } from './prefs';
import { TuningPanel, loadPatch } from './tuning';

export interface GameOptions {
  seed: number;
  chassis: string;
  mapId: string;
  /** 決鬥場的對手機體；null = 用地圖寫的。 */
  rival: string | null;
}

const FUNC_LABEL: Record<PadKey, string> = {
  lock: '鎖定', fire: '射擊', reload: '裝填', swap: '換武器', cool: '散熱', switchDrive: '換驅動', wait: '待機',
};

/** 相對機首方向的箭頭：左盤跟著機首排，所以「前」永遠是 ↑。 */
const REL_GLYPH = ['↑', '↗', '↘', '↓', '↙', '↖'] as const;

/** 還沒接線的鍵：先按 actions.json 顯示成本，但不能按（鎖定與電戰一起做；換武器等右側武器面板）。 */
const UNWIRED: Partial<Record<PadKey, keyof Rules['actions']>> = { lock: 'lock', swap: 'swap' };

/** 理由的短版（按鍵上的小字）：「超出射程（7 格 > 6）」→「超出射程」。 */
function short(reason: string): string {
  return reason.split(/[（：]/)[0];
}

const KIND_TEXT: Record<MotionResult['kind'], string> = {
  COAST: '不加速', START: '起步', PUSH: '加速', VEER60: '轉 60°', VEER120: '轉 120°', BRAKE: '煞車',
};

export class Game {
  state!: GameState;
  private patch: RulesPatch = loadPatch();
  private rules: Rules = RULES;
  private map!: GameMap;
  private bounds!: WorldBounds;
  private chassis: string;
  private mapId: string;
  private rival: string | null;
  /** 演出用的延遲提示（例如敵機的子彈飛到了才說「被擊中」）。重開時全部取消。 */
  private timers: number[] = [];
  /** 上一批事件的演出排到什麼時候結束（performance.now 的時間）。 */
  private fxEnd = 0;

  private canvas = $('map') as HTMLCanvasElement;
  private ctx = this.canvas.getContext('2d')!;
  private viewW = 0;
  private viewH = 0;
  private dpr = 0;
  private safe: SafeArea = { top: 0, bottom: 0 };
  private cam: Camera = { size: 24, ox: 0, oy: 0 };

  private motion = new Motion();
  private fx = new Effects();
  private hud = new Hud();
  private pads: Pads;

  private pan: Pt = { x: 0, y: 0 };
  private picked: Hex | null = null;
  /** 左盤目前的選擇（還沒確認）：加速方向與點數（相對轉完之後的機首）。 */
  private sel: AccelOrder = null;
  /** 左盤目前選的轉向：正 = 右轉幾面、負 = 左轉幾面（還沒確認）。 */
  private turnSel = 0;
  /** 選中的目標。手動選的留到這一回合結束（或打爆）；自動選的會換成命中率最高的。 */
  private target: string | null = null;
  private targetManual = false;
  private targetRound = 0;
  private trail: Hex[] = [];
  private dirty = true;
  private wasAnimating = false;

  constructor(private opts: GameOptions) {
    this.chassis = opts.chassis;
    this.mapId = opts.mapId;
    this.rival = opts.rival;
    this.pads = new Pads($('move-pad'), $('func-pad'), {
      tap: (rel) => this.tap(rel as RelDir),
      turn: (delta) => this.turnTap(delta),
      confirm: () => this.confirm(),
      action: (k) => this.pressFunc(k),
      refused: (reason) => this.hud.toast(reason, 'warn'),
    });
    this.pads.buildMove(UI.movePad);
    // 面板自己綁 ⚙ 按鈕；Game 只提供它需要的幾個存取點
    new TuningPanel({
      rules: () => this.rules,
      base: () => RULES,
      chassis: () => this.chassis,
      map: () => this.mapId,
      patch: () => this.patch,
      setPatch: (p) => this.applyPatch(p),
      setChassis: (id) => {
        this.chassis = id;
        this.savePrefs();
        this.restart();
      },
      setMap: (id) => {
        this.mapId = id;
        this.savePrefs();
        this.rebuildRules();
        this.restart();
      },
      rival: () => this.rivalId(),
      setRival: (id) => {
        this.rival = id;
        this.savePrefs();
        this.rebuildRules();
        this.restart();
      },
      restart: () => this.restart(),
    });
    this.rebuildRules();
    this.restart();
    this.bindInput();
    $('btn-course-restart').addEventListener('click', () => this.restart());
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    this.resize();
    requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- 開局與調參

  restart(): void {
    this.state = newGame(this.rules, this.map, { seed: this.opts.seed, player: { chassis: this.chassis } });
    this.trail = [];
    this.pan = { x: 0, y: 0 };
    this.picked = null;
    this.sel = null;
    this.turnSel = 0;
    this.target = null;
    this.targetManual = false;
    this.motion.finish();
    this.fx.clear();
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    this.pads.buildFunc(this.cockpit().pad);
    this.refresh();
    // 開局時第一個檢查點就是目標：它的 ACTIVATE 鉤子在這裡發（之後的由引擎隨事件發出）
    if (this.map.course) for (const h of hooksOf(this.map.course, 0, 'ACTIVATE')) this.runHook(h);
  }

  private rebuildRules(): void {
    this.rules = withPatch(RULES, this.patch);
    const raw = rawMapById(this.mapId) ?? rawMapById('proving_ground')!;
    this.map = loadMap(this.rules, raw);
    // 決鬥場：換成選的對手
    const rivalUnit = duelists(this.map)[0];
    if (rivalUnit && this.rival) this.map = withUnitChassis(this.rules, this.map, rivalUnit, this.rival);
    this.bounds = mapBounds(this.map);
  }

  /** 這張圖的決鬥對手（機體 id）；不是決鬥場就是 null。 */
  private rivalId(): string | null {
    const id = duelists(this.map)[0];
    if (!id) return null;
    return this.map.units.find((u) => (u.id ?? u.chassis) === id)!.chassis;
  }

  private savePrefs(): void {
    savePrefs({ map: this.mapId, chassis: this.chassis, rival: this.rival ?? undefined });
  }

  /** 過一段時間再做（演出用）。重開時全部取消。 */
  private later(ms: number, f: () => void): void {
    this.timers.push(window.setTimeout(f, Math.max(0, ms)));
  }

  /** 換一份規則但保留當下的局面 —— 調完參數可以接著開，不必回到出生點。 */
  private applyPatch(p: RulesPatch): void {
    this.patch = p;
    this.rebuildRules();
    this.state = { ...this.state, rules: this.rules, map: this.map };
    // 上限可能變小了：選擇超出新上限就清掉
    if (this.sel && this.sel.taps > maxTaps(driveOf(this.rules, this.me()), this.sel.rel)) this.sel = null;
    this.refresh();
  }

  private cockpit(): Cockpit {
    return UI.cockpits[this.rules.chassis[this.chassis].cockpit];
  }

  // ---------------------------------------------------------------- 左盤

  /** 點一個方向：同方向 +1（超過上限歸零）；別的方向 = 改選、從 1 開始。 */
  private tap(rel: RelDir): void {
    const u = this.me();
    const max = maxTaps(driveOf(this.rules, u), rel);
    if (max === 0) {
      this.hud.toast(accelLegality(this.rules, u, { rel, taps: 1 }).reason ?? '這個方向推不動', 'warn');
      return;
    }
    if (this.sel && this.sel.rel === rel) {
      this.sel = this.sel.taps + 1 > max ? null : { rel, taps: this.sel.taps + 1 };
    } else {
      this.sel = { rel, taps: 1 };
    }
    this.refresh();
  }

  /**
   * 左盤的轉向：+1 右轉一面、−1 左轉一面、0 = 不轉。只是選擇，確認時才跟加速一起送出；
   * 付不起（AP、免費面數用完）或超過半圈就說為什麼。
   */
  private turnTap(delta: number): void {
    const next = delta === 0 ? 0 : this.turnSel + delta;
    const plan = planTurn(this.rules, this.me(), next);
    if (!plan.ok) {
      this.hud.toast(plan.reason ?? '轉不過去', 'warn');
      return;
    }
    this.turnSel = next;
    this.refresh();
  }

  /** 照左盤目前選的轉向，轉完之後的自己（機首、速度、AP）。 */
  private pending(): Unit {
    return planTurn(this.rules, this.me(), this.turnSel).unit;
  }

  private confirm(): void {
    const order = this.sel;
    const turn = this.turnSel;
    this.sel = null;
    this.turnSel = 0;
    this.dispatch({ type: 'ACCEL', order, turn });
  }

  // ---------------------------------------------------------------- 指令

  dispatch(cmd: Command): void {
    const legal = checkLegal(this.state, cmd);
    if (!legal.ok) {
      this.hud.toast(legal.reason ?? '不能這樣做', 'warn');
      this.refresh();
      return;
    }
    const wasOver = this.state.over !== null;
    const before = this.me().hp;
    const { state, events } = applyCommand(this.state, cmd);
    this.motion.finish();
    this.state = state;
    if (cmd.type === 'ACCEL' && UI.camera.recenterAfterMove) this.pan = { x: 0, y: 0 };
    this.present(events, before);
    if (!wasOver && this.state.over && !this.map.course) this.result();
    this.refresh();
  }

  /** 決鬥之類沒有跑道的地圖分出勝負（跑道的完賽由 COURSE_DONE 說）。勝場記最少回合。 */
  private result(): void {
    const round = this.state.round;
    const win = this.state.over!.winner === 'PLAYER';
    let text = `💥 被擊毀（第 ${round} 回合）。按「重來」再打一次，或在 ⚙ 換機體、換對手`;
    if (win) {
      const key = this.recordKey();
      const best = bestOf(key, this.chassis);
      const record = recordFinish(key, this.chassis, round);
      text = `🏆 勝利：第 ${round} 回合擊毀敵機` + (record && best !== null ? `（新紀錄，原本 ${best} 回合）` : '');
    }
    // 等最後那一槍的演出播完才說
    this.later(this.fxEnd - performance.now(), () => this.hud.toast(text, win ? 'info' : 'bad', 5000));
  }

  /** 最佳紀錄的鍵：決鬥場連同對手一起記（打不同對手的回合數不能比）。 */
  private recordKey(): string {
    const rival = this.rivalId();
    return rival ? `${this.mapId}@${rival}` : this.mapId;
  }

  private pressFunc(k: PadKey): void {
    switch (k) {
      case 'fire': return this.fire();
      case 'reload': return this.dispatch({ type: 'RELOAD' });
      case 'cool': return this.dispatch({ type: 'COOL' });
      case 'switchDrive': return this.dispatch({ type: 'SWITCH_DRIVE' });
      case 'wait': return this.dispatch({ type: 'WAIT' });
      default: this.hud.toast(`${FUNC_LABEL[k]}還沒接線`, 'info');
    }
  }

  private fire(): void {
    const t = this.selectedTarget();
    if (!t) {
      this.hud.toast(this.noTargetReason(), 'warn');
      return;
    }
    this.dispatch({ type: 'FIRE', targetId: t.id });
  }

  // ---------------------------------------------------------------- 目標

  private selectedTarget(): Unit | null {
    const t = this.target ? unitById(this.state, this.target) : undefined;
    return t && t.alive ? t : null;
  }

  /**
   * 開火的「那一刻」的自己：行動階段就是現在；加速階段是照左盤目前的選擇移動之後。
   * 靶在玩家行動之後才動，所以用它算出來的命中率就是行動階段的命中率。
   */
  private shooter(): Unit {
    if (!this.isDeclare()) return this.me();
    const m = this.predict();
    return { ...this.pending(), pos: m.pos, heading: m.heading, speed: m.speed };
  }

  private checkOn(t: Unit): ShotCheck {
    return shotCheck(this.state, this.shooter(), t);
  }

  /**
   * 選中的目標沒了就清掉；自動選的打不到了就換成命中率最高的。
   * 手動選的留到這一回合結束 —— 玩家看得到為什麼打不到、可以轉過去打；下一回合回到自動。
   */
  private autoTarget(): void {
    if (!this.selectedTarget()) {
      this.target = null;
      this.targetManual = false;
    }
    if (this.targetManual && this.state.round !== this.targetRound) this.targetManual = false;
    if (this.targetManual) return;
    const cur = this.selectedTarget();
    if (cur && this.checkOn(cur).ok) return;
    const best = targetsFor(this.state, this.shooter())[0];
    if (best) this.target = best.unit.id;
  }

  private noTargetReason(): string {
    const u = this.me();
    const w = weaponOf(this.rules, u);
    if (!w) return '沒有武器';
    if (u.ammo === 0) return '沒子彈了：先裝填';
    if (!this.state.units.some((x) => x.alive && x.side !== u.side)) return '場上沒有目標';
    return `射界與射程內沒有目標（射程 ${w.range}、射界 ±${w.arcDegrees / 2}°）—— 轉向，或點地圖上的目標看原因`;
  }

  /** 點目標時的說明：命中率怎麼來的（明細逐項列出），或為什麼打不到。 */
  private shotText(t: Unit): string {
    const chk = this.checkOn(t);
    const c = this.rules.chassis[t.chassis];
    const head = `${c.name} · 距離 ${chk.distance} · 耐久 ${t.hp}/${c.hp}`;
    if (!chk.ok) return `${head} —— ${chk.reason}`;
    const parts = chk.terms.filter((x) => x.value !== 0).map((x) => `${x.label} ${x.value > 0 ? '+' : '−'}${Math.abs(x.value)}`);
    const raw = chk.terms.reduce((a, x) => a + x.value, 0);
    const clamp = raw !== chk.chance ? `（夾在 ${this.rules.combat.minHit}–${this.rules.combat.maxHit}）` : '';
    return `${head} —— 命中 ${chk.chance}%${clamp}：${parts.join('、')}`;
  }

  private targetCount(): { total: number; killed: number } {
    const ts = this.state.units.filter((u) => this.rules.chassis[u.chassis].role === 'TARGET');
    return { total: ts.length, killed: ts.filter((u) => !u.alive).length };
  }

  /** 有靶的地圖：「 · 擊毀 3／5 · 命中 4／7」；沒有靶就是空字串。 */
  private scoreText(): string {
    const n = this.targetCount();
    if (n.total === 0) return '';
    const st = this.state.stats;
    return ` · 擊毀 ${n.killed}／${n.total} · 命中 ${st.hits}／${st.shots}`;
  }

  /**
   * 事件 → 動畫與提示。同一批事件照順序一段一段播（busy = 排到哪個時間了）：
   * 你開槍 → 敵機移動 → 敵機轉向 → 敵機開槍，看得出先後。
   * 跟演出時間點有關的提示（被擊中）也等到那一刻才跳。
   * @param hpBefore 這一批之前玩家的耐久（被連打時逐發算出剩多少）
   */
  private present(events: GameEvent[], hpBefore: number): void {
    const now = performance.now();
    const a = UI.animation;
    let busy = now;
    let hp = hpBefore;
    const hpMax = this.rules.chassis[this.me().chassis].hp;
    for (const e of events) {
      switch (e.type) {
        case 'MOVED': {
          const hexes = e.path.length - 1;
          const bump = events.some((x) => x.type === 'COLLIDED' && x.unitId === e.unitId);
          if (hexes > 0) {
            const dur = Math.min(a.maxMoveMs, hexes * a.msPerHex);
            this.motion.move(e.unitId, e.from, e.to, busy, dur, bump);
            // 自己的位移不擋後面的東西（同一批裡只剩檢查點之類的提示）；別人的要播完才輪到下一段
            if (e.unitId !== 'player') busy += dur;
          }
          if (e.unitId === 'player' && hexes > 0) {
            this.trail.push(e.from);
            if (this.trail.length > UI.preview.trailLength) this.trail.shift();
          }
          break;
        }
        case 'TURNED':
          this.motion.turn(e.unitId, dirAngle(e.from), dirAngle(e.to), busy, a.turnMs);
          if (e.unitId !== 'player') busy += a.turnMs;
          break;
        case 'FIRED': {
          const impact = busy + a.shotMs * 0.35;
          this.fx.shot(e.from, e.to, e.hit, busy, a.shotMs);
          this.fx.float(e.to, e.hit ? `−${e.damage}` : '未命中', e.hit ? '#ffe08a' : '#cfd8e3', impact, a.floatMs);
          if (e.targetId === 'player') {
            hp -= e.damage;
            const text = e.hit
              ? `被擊中 −${e.damage}（對方命中率 ${e.chance}%）· 耐久 ${hp}／${hpMax}`
              : `對方沒打中（命中率 ${e.chance}%）`;
            this.later(impact - now, () => this.hud.toast(text, e.hit ? 'bad' : 'info'));
          }
          busy += a.shotMs;
          break;
        }
        case 'DESTROYED': {
          const u = unitById(this.state, e.unitId)!;
          this.fx.float(u.pos, '擊毀', '#ff6b5a', busy, a.floatMs);
          // 靶：報一下進度。敵機或自己被打爆 = 分出勝負，由 result() 說
          if (e.by === 'player' && this.rules.chassis[u.chassis].role === 'TARGET') {
            const n = this.targetCount();
            this.hud.toast(`💥 擊毀${this.rules.chassis[u.chassis].name}（${n.killed}／${n.total}）`, 'info');
          }
          break;
        }
        case 'RELOADED':
          if (e.unitId === 'player') this.hud.toast(`裝填完成：${e.ammo} 發`, 'info');
          break;
        case 'SPAWNED': {
          // 不跳 toast：同一批裡通常還有檢查點的旁白，別蓋掉它
          const u = unitById(this.state, e.unitId)!;
          this.fx.float(u.pos, '出現', '#ff6b5a', busy, a.floatMs * 1.5);
          break;
        }
        case 'COLLIDED': {
          const what = e.collision.blocker === 'EDGE' ? '地圖邊緣' : '其他機體';
          this.hud.toast(`撞上${what}（${e.collision.speed} 速）— 速度歸零`, 'bad');
          break;
        }
        case 'OVERHEAT':
          this.hud.toast('過熱！強制停機：這回合剩下的行動取消，下回合不能加速', 'bad');
          break;
        case 'REBOOT':
          this.hud.toast('重新開機', 'info');
          break;
        case 'DRIVE':
          this.hud.toast('驅動切換：' + this.rules.drives[e.drive].name, 'info');
          break;
        case 'PHASE_END':
          if (e.unitId !== 'player') break;
          if (e.reason === 'AP_SPENT') this.hud.toast('AP 用完，推進回合', 'info');
          if (e.reason === 'OVERDRAFT') this.hud.toast(`透支：行動已結算，推進回合（下回合 AP −${this.me().debt}）`, 'warn');
          break;
        case 'CHECKPOINT': {
          const total = this.map.course?.checkpoints.length ?? 0;
          if (e.index + 1 < total) this.hud.toast(`✓ 檢查點 ${e.index + 1}／${total}（第 ${e.round} 回合）`, 'info');
          break;
        }
        case 'COURSE_HOOK':
          this.runHook(e.hook);
          break;
        case 'COURSE_DONE': {
          const best = bestOf(this.mapId, this.chassis);
          const record = recordFinish(this.mapId, this.chassis, e.round);
          this.hud.toast((record && best !== null
            ? `🏁 完賽：${e.round} 回合 —— 新紀錄（原本 ${best}）`
            : `🏁 完賽：${e.round} 回合`) + this.scoreText(), 'info', 4000);
          break;
        }
        default:
          break;
      }
    }
    this.fxEnd = busy;
  }

  /**
   * 檢查點的事件鉤子。core 只負責在對的時機發出來，內容由訂閱的系統解讀 ——
   * 介面目前只認得 MESSAGE（跳一段旁白）。其他 type 先記在主控台，之後的新手教學、
   * 生敵、開放按鍵之類的系統接上來時，就在這裡（或各自的訂閱處）加分支。
   */
  private runHook(hook: CourseHook): void {
    if (hook.type === 'MESSAGE' && typeof hook.text === 'string') {
      this.hud.toast(hook.text, 'story', 4000);
      return;
    }
    console.info('[mech] 還沒有系統處理這種檢查點鉤子：', hook);
  }

  // ---------------------------------------------------------------- 畫面資料

  private me(): Unit {
    return playerUnit(this.state)!;
  }

  private isDeclare(): boolean {
    const u = activeUnit(this.state);
    return !this.state.over && !!u && u.side === 'PLAYER' && currentStep(this.state)?.kind === 'DECLARE';
  }

  private isAct(): boolean {
    const u = activeUnit(this.state);
    return !this.state.over && !!u && u.side === 'PLAYER' && currentStep(this.state)?.kind === 'ACT';
  }

  /** 左盤目前的選擇（轉向＋加速）會發生什麼。 */
  private predict(): MotionResult {
    return resolveMotion(worldOf(this.state, 'player'), this.pending(), this.sel);
  }

  /** 滑行預測：從 base 開始都不加速，再滑幾回合（停了或撞了就停）。 */
  private drift(base: MotionResult): Hex[] {
    const w = worldOf(this.state, 'player');
    let u: Unit = { ...this.me(), pos: base.pos, heading: base.heading, speed: base.speed };
    const out: Hex[] = [];
    for (let i = 0; i < UI.preview.driftTurns && u.speed > 0; i++) {
      const m = resolveMotion(w, u, null);
      if (m.path.length > 1) out.push(m.pos);
      if (m.collision) break;
      u = { ...u, pos: m.pos, heading: m.heading, speed: m.speed };
    }
    return out;
  }

  private refresh(): void {
    this.dirty = true;
    this.autoTarget();
    const s = this.state;
    const u = this.me();
    const rules = this.rules;
    const c = rules.chassis[u.chassis];
    const drive = rules.drives[u.drive];
    const weapon = weaponOf(rules, u);
    const declare = this.isDeclare();
    const act = this.isAct();

    // 左盤
    const moves: MoveKeyView[] = [0, 1, 2, 3, 4, 5].map((rel) => ({
      rel,
      glyph: REL_GLYPH[rel],
      name: REL_NAME[rel],
      max: maxTaps(drive, rel as RelDir),
      taps: this.sel && this.sel.rel === rel ? this.sel.taps : 0,
    }));
    this.pads.updateMove(moves, this.confirmView(declare), this.turnView(declare), declare);

    // 右盤
    const cp = this.cockpit();
    this.pads.buildFunc(cp.pad);
    this.pads.updateFunc(cp.pad.flat().filter((k): k is PadKey => k !== '').map((k) => this.funcView(k)), act);

    this.hud.update({
      chassisName: c.name,
      driveName: drive.name + (c.drives.length > 1 ? `（${c.drives.map((d) => rules.drives[d].name).join('／')}）` : ''),
      heading: u.heading,
      speed: u.speed,
      maxSpeed: drive.maxSpeed,
      facing: u.facing,
      heat: u.heat,
      heatCap: c.heatCap,
      hotAbove: rules.economy.heatWarnAbove,
      shutdown: u.shutdown > 0,
      weaponName: weapon?.name ?? null,
      ammo: u.ammo,
      magazine: weapon?.magazine ?? 0,
      hp: u.hp,
      hpMax: c.hp,
      ap: u.ap,
      quota: c.apQuota,
      debt: u.debt,
      debtCap: rules.economy.apDebtCap,
      round: s.round,
      readouts: cp.readouts,
    });
    $('btn-recenter').classList.toggle('hidden', this.pan.x === 0 && this.pan.y === 0);
    this.refreshCourse();
  }

  /** 跑道那一行：下一個檢查點與這一步的提示；跑完就顯示成績。決鬥場顯示對手的耐久與勝負。 */
  private refreshCourse(): void {
    const bar = $('hud-course');
    const course = this.map.course;
    const p = this.state.course;
    bar.classList.toggle('hidden', !course && !this.map.brief);
    bar.classList.remove('lost');
    $('btn-course-restart').textContent = course ? '重跑' : '重來';
    if (!course || !p) return this.refreshBrief();
    const best = bestOf(this.mapId, this.chassis);
    const n = this.targetCount();
    bar.classList.toggle('done', p.done !== null);
    if (p.done !== null) {
      $('course-step').textContent = `🏁 完賽 ${p.done} 回合`;
      $('course-hint').textContent = `${this.rules.chassis[this.chassis].name}${best !== null ? `・最佳 ${best} 回合` : ''}${this.scoreText()}。按「重跑」再來一次，或在 ⚙ 換機體比較。`;
      return;
    }
    const cp = course.checkpoints[p.next];
    $('course-step').textContent = `${p.next + 1}／${course.checkpoints.length} ${cp.type === 'STOP' ? '停車' : '通過'}`
      + (n.total > 0 ? ` · 🎯${n.killed}／${n.total}` : '');
    $('course-hint').textContent = cp.hint + (best !== null && p.next === 0 ? `（最佳 ${best} 回合）` : '');
  }

  /** 沒有跑道、有說明的地圖（決鬥場）：對手的耐久、說明；分出勝負就顯示結果。 */
  private refreshBrief(): void {
    const brief = this.map.brief;
    if (!brief) return;
    const bar = $('hud-course');
    const over = this.state.over;
    const rivals = this.state.units.filter((u) => u.side === 'ENEMY' && this.rules.chassis[u.chassis].role !== 'TARGET');
    const best = bestOf(this.recordKey(), this.chassis);
    bar.classList.toggle('done', over?.winner === 'PLAYER');
    bar.classList.toggle('lost', over !== null && over.winner !== 'PLAYER');
    const vs = rivals.map((r) => `${this.rules.chassis[r.chassis].name} 耐久 ${r.hp}`).join('、');
    if (over) {
      $('course-step').textContent = over.winner === 'PLAYER' ? `🏆 勝利 第 ${this.state.round} 回合` : `💥 被擊毀 第 ${this.state.round} 回合`;
      $('course-hint').textContent = `${this.rules.chassis[this.chassis].name} 對 ${rivals.map((r) => this.rules.chassis[r.chassis].name).join('、')}`
        + `${best !== null ? `・最佳 ${best} 回合` : ''} · 命中 ${this.state.stats.hits}／${this.state.stats.shots}`
        + ` · 被命中 ${this.state.stats.enemyHits}／${this.state.stats.enemyShots}。按「重來」再打一次，或在 ⚙ 換機體、換對手。`;
      return;
    }
    $('course-step').textContent = `對手 ${vs}`;
    $('course-hint').textContent = brief + (best !== null ? `（最佳 ${best} 回合）` : '');
  }

  /** 確認鍵上寫這回合會變成什麼：「3速 轉向−1 → 轉60° −1 +2 → 4速↖」。 */
  private confirmView(declare: boolean): ConfirmView {
    if (!declare) return { label: '確認', sub: '行動階段' };
    const m = this.predict();
    const u = this.me();
    const t = this.pending();
    if (!this.sel && u.speed === 0) return { label: '空過', sub: this.turnSel ? '原地轉向、不加速' : '靜止、不加速' };
    const dir = m.speed > 0 ? DIR_GLYPH[m.heading] : '';
    const parts = [`${u.speed}速`];
    if (t.speed < u.speed) parts.push(`轉向 −${u.speed - t.speed}`);
    parts.push(KIND_TEXT[m.kind]);
    if (m.loss > 0) parts.push(`−${m.loss}`);
    if (this.sel) parts.push(m.kind === 'BRAKE' ? `−${this.sel.taps}` : `+${this.sel.taps}`);
    else if (m.kind === 'COAST') parts.push(`−${driveOf(this.rules, u).decay}`);
    return { label: '確認', sub: `${parts.join(' ')} → ${m.speed}速${dir}${m.collision ? '（撞）' : ''}` };
  }

  /** 轉向那一排：轉完之後的機首與代價；左右鍵寫「再轉一面」要付多少。 */
  private turnView(declare: boolean): TurnView {
    const u = this.me();
    const now = planTurn(this.rules, u, this.turnSel);
    const t = now.unit;
    const price = (p: TurnPlan): string => {
      const bits = [p.ap > 0 ? `${p.ap} AP` : '免費'];
      if (p.unit.speed < u.speed) bits.push(`−${u.speed - p.unit.speed}速`);
      return bits.join(' ');
    };
    const step = (d: number): string => {
      if (!declare) return '';
      const p = planTurn(this.rules, u, this.turnSel + d);
      if (!p.ok) return '—';
      const extra = { ...p, ap: p.ap - now.ap, unit: { ...p.unit, speed: u.speed - (t.speed - p.unit.speed) } };
      return price(extra);
    };
    // 機首那格很窄：「右1面」「右2面 1AP」「左1面 −1速」
    const side = this.turnSel > 0 ? '右' : '左';
    const cost = [now.ap > 0 ? `${now.ap}AP` : '', t.speed < u.speed ? `−${u.speed - t.speed}速` : ''].filter(Boolean).join(' ');
    return {
      noseLabel: `${DIR_GLYPH[t.facing]}${DIR_NAME[t.facing]}`,
      noseSub: !declare ? '機首' : this.turnSel === 0 ? '不轉' : `${side}${Math.abs(this.turnSel)}面${cost ? ' ' + cost : ''}`,
      turning: this.turnSel !== 0,
      leftSub: step(-1),
      rightSub: step(1),
    };
  }

  private funcView(k: PadKey): FuncKeyView {
    const s = this.state;
    const u = this.me();
    const unwired = UNWIRED[k];
    if (unwired) {
      const a = this.rules.actions[unwired];
      return { key: k, label: FUNC_LABEL[k], sub: costText(a.ap, a.heat), enabled: false, warn: false, reason: `${FUNC_LABEL[k]}還沒接線` };
    }
    if (k === 'fire') return this.fireView();
    // 成本一律照資料寫（不從 checkLegal 拿：加速階段的 checkLegal 會以「還沒到行動階段」拒絕，成本是 0）
    const acts = this.rules.actions;
    const w = weaponOf(this.rules, u);
    const cmd: Command = k === 'reload' ? { type: 'RELOAD' }
      : k === 'cool' ? { type: 'COOL' }
        : k === 'switchDrive' ? { type: 'SWITCH_DRIVE' }
          : { type: 'WAIT' };
    const l = checkLegal(s, cmd);
    let sub: string;
    if (k === 'reload') {
      // 彈數在儀表上（步槍 5/6），鍵上只寫成本
      sub = w ? costText(w.reload.ap, w.reload.heat) : '沒有武器';
    } else if (k === 'cool') {
      sub = costText(acts.cool.ap, acts.cool.heat);
    } else if (k === 'switchDrive') {
      const list = this.rules.chassis[u.chassis].drives;
      const next = list[(list.indexOf(u.drive) + 1) % list.length];
      sub = list.length > 1 ? `→${this.rules.drives[next].name} · ${costText(acts.switchDrive.ap, acts.switchDrive.heat)}` : '單一驅動';
    } else {
      sub = '結束回合';
    }
    return { key: k, label: FUNC_LABEL[k], sub, enabled: l.ok, warn: l.overdraft > 0, reason: l.reason };
  }

  /**
   * 射擊鍵：鍵名後面寫對選中目標的命中率，小字寫成本；
   * 加速階段顯示的是「這樣加速之後」的命中率（≈）。打不到就在小字寫原因。
   */
  private fireView(): FuncKeyView {
    const base = { key: 'fire' as PadKey, label: FUNC_LABEL.fire };
    const w = weaponOf(this.rules, this.me());
    if (!w) return { ...base, sub: '沒有武器', enabled: false, warn: false, reason: '沒有武器' };
    const t = this.selectedTarget();
    if (!t) {
      const reason = this.noTargetReason();
      return { ...base, sub: short(reason), enabled: false, warn: false, reason };
    }
    const chk = this.checkOn(t);
    if (!chk.ok) return { ...base, sub: short(chk.reason!), enabled: false, warn: false, reason: chk.reason };
    const l = checkLegal(this.state, { type: 'FIRE', targetId: t.id });
    return {
      ...base,
      label: `${FUNC_LABEL.fire} ${this.isDeclare() ? '≈' : ''}${chk.chance}%`,
      sub: costText(w.fire.ap, w.fire.heat),
      enabled: l.ok, warn: l.overdraft > 0, reason: l.reason,
    };
  }

  /** 行動（或預測的）位置上，這把武器打得到哪些格子。場上沒有目標就不畫。 */
  private arcView(): ArcCell[] | null {
    const w = weaponOf(this.rules, this.me());
    if (!w || this.state.over || !this.state.units.some((x) => x.alive && x.side !== 'PLAYER')) return null;
    const v = this.shooter();
    return arcHexes(w, v.pos, v.facing).map((hex) => ({ hex, optimal: inOptimal(w, hexDist(v.pos, hex)) }));
  }

  private targetView(): TargetView | null {
    if (this.state.over) return null;
    const me = this.shooter();
    const chance = new Map<string, number>();
    for (const t of targetsFor(this.state, me)) chance.set(t.unit.id, t.check.chance);
    // 威脅：有武器的對手現在打你的命中率（取最高）。用它目前的位置與速度估 —— 它在你之後才動，所以只是參考
    let threat: number | null = null;
    for (const e of this.state.units) {
      if (!e.alive || e.side === me.side || !weaponOf(this.rules, e)) continue;
      const c = shotCheck(this.state, e, me);
      if (c.ok) threat = Math.max(threat ?? 0, c.chance);
    }
    return { selected: this.target, chance, threat, threatAt: me.pos };
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

    // 桌機測試用的鍵盤（跟著機首）：W 前、E 右前、D 右後、S 後、A 左後、Q 左前、← → 轉向、空白 確認；
    // F 射擊、R 裝填、Tab 換目標、C 散熱、V 切換、Enter 待機
    const keys: Record<string, () => void> = {
      w: () => this.keyTap(0), e: () => this.keyTap(1), d: () => this.keyTap(2),
      s: () => this.keyTap(3), a: () => this.keyTap(4), q: () => this.keyTap(5),
      ' ': () => (this.isDeclare() ? this.confirm() : this.hud.toast('行動階段：按 Enter（待機）結束這一回合', 'warn')),
      arrowleft: () => this.keyTurn(-1), arrowright: () => this.keyTurn(1),
      f: () => this.keyFunc('fire'), r: () => this.keyFunc('reload'), tab: () => this.cycleTarget(),
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

  private keyTap(rel: RelDir): void {
    if (!this.isDeclare()) {
      this.hud.toast('行動階段：按 Enter（待機）結束這一回合', 'warn');
      return;
    }
    this.tap(rel);
  }

  private keyTurn(delta: number): void {
    if (!this.isDeclare()) {
      this.hud.toast('轉向在左盤、移動之前決定：下一回合再轉', 'warn');
      return;
    }
    this.turnTap(delta);
  }

  /** 鍵盤走和觸控盤一樣的路：不能按就說為什麼。 */
  private keyFunc(k: PadKey): void {
    if (!this.isAct()) {
      this.hud.toast('先在左盤確認加速：行動在位移之後', 'warn');
      return;
    }
    const v = this.funcView(k);
    if (!v.enabled) {
      this.hud.toast(v.reason ?? '不能這樣做', 'warn');
      return;
    }
    this.pressFunc(k);
  }

  /** Tab：在場上的目標之間輪流（手動選）。 */
  private cycleTarget(): void {
    const list = this.state.units.filter((u) => u.alive && u.side !== 'PLAYER');
    if (list.length === 0) return;
    const i = list.findIndex((u) => u.id === this.target);
    this.selectTarget(list[(i + 1) % list.length]);
  }

  private selectTarget(t: Unit): void {
    this.target = t.id;
    this.targetManual = true;
    this.targetRound = this.state.round;
    this.picked = null;
    this.hud.toast(this.shotText(t), 'info', 4500);
    this.refresh();
  }

  /** 點地圖：點到目標 = 選它並列出命中明細；點到空地 = 顯示那一格的地形與距離（同一把尺）。 */
  private pick(x: number, y: number): void {
    const w = screenToWorld(this.cam, x, y);
    const a = worldToAxial(w.x, w.y);
    const hex = hexRound(a.q, a.r);
    const cell = cellAt(this.map, hex);
    this.dirty = true;
    if (!cell) {
      this.picked = null;
      return;
    }
    const unit = this.state.units.find((u) => u.alive && u.side !== 'PLAYER' && sameHex(u.pos, hex));
    if (unit) return this.selectTarget(unit);
    this.picked = hex;
    const t = this.rules.terrain[cell.terrain];
    this.hud.toast(`${t.name} · 距離 ${hexDist(this.me().pos, hex)} · 高度 ${cell.elevation}（地形目前不影響移動）`);
  }

  // ---------------------------------------------------------------- 畫面

  /**
   * 畫面大小 = 畫布實際佔的大小（CSS 讓它鋪滿畫面）。**不用 window.innerWidth**：
   * iOS（iOS 版 Chrome 也是同一個核心）剛載入時可能還回報桌面預設的 980，之後也不一定發 resize ——
   * 鏡頭就會以為畫面有 980 寬：格子放到最大、機體偏右、地圖右半邊怎麼拖都拖不進畫面。
   * 所以每一幀都比對一次（沒變就什麼都不做），錯過的 resize 自己會補回來。
   */
  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (w === this.viewW && h === this.viewH && dpr === this.dpr) return;
    this.viewW = w;
    this.viewH = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
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
    const p = this.motion.posOf('player', this.me().pos, now);
    return axialToWorld(p.q, p.r);
  }

  private clampPan(): void {
    const size = hexSizeFor(this.viewW, UI.camera.hexesAcross, UI.camera.minHexPx, UI.camera.maxHexPx);
    const focus = this.focusPoint(performance.now());
    const cam = computeCamera(this.bounds, this.viewW, this.viewH, size, focus, this.pan, this.safe);
    this.pan = effectivePan(cam, this.viewW, this.safe, focus);
    if (Math.abs(this.pan.x) < 1e-6 && Math.abs(this.pan.y) < 1e-6) this.pan = { x: 0, y: 0 };
  }

  private loop = (now: number): void => {
    this.resize();
    const animating = this.motion.active(now) || this.fx.active(now);
    // 動畫剛結束的那一幀一定要再畫一次：速度箭頭、預測、滑行都只在靜止時畫
    if (this.wasAnimating && !animating) this.dirty = true;
    this.wasAnimating = animating;
    if (this.dirty || animating) {
      this.dirty = false;
      this.measureSafe();
      const size = hexSizeFor(this.viewW, UI.camera.hexesAcross, UI.camera.minHexPx, UI.camera.maxHexPx);
      this.cam = computeCamera(this.bounds, this.viewW, this.viewH, size, this.focusPoint(now), this.pan, this.safe);
      const declare = this.isDeclare();
      const u = this.me();
      let preview: Preview | null = null;
      let hint: RelHint | null = null;
      let drift: Hex[];
      if (declare) {
        const m = this.predict();
        const facing = this.pending().facing;
        preview = {
          path: m.path, pos: m.pos, heading: m.heading, speed: m.speed, facing,
          collision: m.collision?.at ?? null, selected: this.sel !== null || this.turnSel !== 0,
        };
        const drive = driveOf(this.rules, u);
        hint = {
          facing,
          taps: [0, 1, 2, 3, 4, 5].map((r) => maxTaps(drive, r as RelDir)),
          sel: this.sel,
        };
        drift = this.drift(m);
      } else {
        // 行動階段：從目前位置開始，看下回合不加速會滑到哪
        drift = this.drift({ pos: u.pos, heading: u.heading, speed: u.speed } as MotionResult);
      }
      const course = this.map.course && this.state.course
        ? { checkpoints: this.map.course.checkpoints, next: this.state.course.next, start: this.map.playerSpawn.hex }
        : null;
      draw(this.ctx, {
        state: this.state, cam: this.cam, viewW: this.viewW, viewH: this.viewH, safe: this.safe, now,
        motion: this.motion, preview, hint, drift, trail: this.trail, picked: this.picked, course,
        arc: this.arcView(), targets: this.targetView(), fx: this.fx,
      });
    }
    requestAnimationFrame(this.loop);
  };
}

function costText(ap: number, heat: number): string {
  const h = heat === 0 ? '' : heat > 0 ? ` · +${heat}` : ` · ${heat}`;
  return `${ap} AP${h}`;
}
