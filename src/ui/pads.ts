/**
 * 兩個觸控盤。
 *
 * 左盤 = 機動宣告（設計者 2026-09-11）：先轉向（最上排 左轉／機首／右轉），再加速。
 * 方向鍵**跟著機首排**（轉完之後的機首），上面那顆永遠是「前」。
 * 往某個方向點幾下就是這回合在那個方向加速幾；確認鍵（roguelike 的「空過」鍵）一次送出轉向＋加速，
 * 什麼都不點直接確認 = 不轉、不加速。點另一個方向 = 改選；同一個方向點超過上限 = 歸零。
 * 選擇的狀態由 Game 持有，這裡只負責畫與回報點了哪顆。
 *
 * 右盤 = 功能盤，也就是座艙：佈局由機型的座艙定義（ui.json 的 cockpits），"" 是保留的空位。
 * 每一鍵顯示 AP 成本與產熱，會造成透支的以警示色標示。
 *
 * 不能按的鍵不用 `disabled` —— 那樣點下去什麼都不會發生。改用 aria-disabled，
 * 點了之後把理由告訴玩家（例如「噴射往左後方推不動」）。
 */
import type { PadCell, PadKey } from './config';
import { h } from './dom';

export interface MoveKeyView {
  /** 相對機首的方向 0..5。 */
  rel: number;
  glyph: string;
  name: string;
  /** 這個方向最多能點幾下。0 = 推不動。 */
  max: number;
  /** 目前點了幾下（沒選這個方向就是 0）。 */
  taps: number;
}

export interface ConfirmView {
  label: string;
  sub: string;
}

/** 轉向那一排：機首（轉完之後）與代價；左右鍵各寫下一面的代價。 */
export interface TurnView {
  noseLabel: string;
  noseSub: string;
  /** 已經選了要轉（機首那格亮起來）。 */
  turning: boolean;
  leftSub: string;
  rightSub: string;
}

export interface FuncKeyView {
  key: PadKey;
  label: string;
  sub: string;
  enabled: boolean;
  /** 會造成透支（警示色）。 */
  warn: boolean;
  reason?: string;
}

export interface PadHandlers {
  tap(rel: number): void;
  /** 左盤轉向：+1 右轉一面、−1 左轉一面；0 = 不轉（點機首那格）。 */
  turn(delta: number): void;
  confirm(): void;
  action(key: PadKey): void;
  refused(reason: string): void;
}

const NOT_DECLARE = '行動階段：在右盤行動，或按「待機」結束這一回合';

export class Pads {
  private moveButtons = new Map<number, HTMLButtonElement>();
  private confirmButton: HTMLButtonElement | null = null;
  private turnButtons = new Map<string, HTMLButtonElement>();
  private funcButtons = new Map<PadKey, HTMLButtonElement>();
  private funcViews = new Map<PadKey, FuncKeyView>();
  private moveActive = false;
  private funcActive = false;
  private funcLayout = '';

  constructor(
    private moveRoot: HTMLElement,
    private funcRoot: HTMLElement,
    private on: PadHandlers,
  ) {}

  /** 左盤佈局：方向編號字串、'OK'、'L' / 'R' / 'NOSE'、''（空格）。同一列相鄰的相同代號合併成跨欄的一顆鍵。 */
  buildMove(layout: string[][]): void {
    this.moveRoot.replaceChildren(h('div', 'pad-title', '① 機動（轉向＋加速）'));
    const grid = h('div', 'pad-grid');
    const cells: { key: string; span: number }[] = [];
    for (const row of layout) {
      for (let i = 0; i < row.length; i++) {
        if (i > 0 && row[i] !== '' && row[i - 1] === row[i]) continue;
        let span = 1;
        while (row[i] !== '' && row[i + span] === row[i]) span++;
        cells.push({ key: row[i], span });
      }
    }
    for (const { key, span } of cells) {
      if (key === '') {
        grid.append(h('span', 'pad-blank'));
        continue;
      }
      const cls = key === 'OK' ? 'key confirm-key' : key === 'L' || key === 'R' || key === 'NOSE' ? 'key turn-key' : 'key move-key';
      const b = h('button', cls);
      b.type = 'button';
      b.dataset.key = key;
      if (span > 1) b.style.gridColumn = `span ${span}`;
      b.append(h('b', 'key-main'), h('small', 'key-sub'));
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      const guard = (f: () => void) => () => (this.moveActive ? f() : this.on.refused(NOT_DECLARE));
      if (key === 'OK') {
        b.addEventListener('click', guard(() => this.on.confirm()));
        this.confirmButton = b;
      } else if (key === 'L' || key === 'R' || key === 'NOSE') {
        const delta = key === 'L' ? -1 : key === 'R' ? 1 : 0;
        b.addEventListener('click', guard(() => this.on.turn(delta)));
        this.turnButtons.set(key, b);
      } else {
        const rel = Number(key);
        b.addEventListener('click', guard(() => this.on.tap(rel)));
        this.moveButtons.set(rel, b);
      }
      grid.append(b);
    }
    this.moveRoot.append(grid);
  }

  /** 右盤佈局。換機型（換座艙）時重建；同一套佈局不重建，按鍵不會閃。"" = 保留的空位。 */
  buildFunc(layout: PadCell[][]): void {
    const sig = JSON.stringify(layout);
    if (sig === this.funcLayout) return;
    this.funcLayout = sig;
    this.funcButtons.clear();
    this.funcRoot.replaceChildren(h('div', 'pad-title', '② 行動'));
    const grid = h('div', 'pad-grid');
    for (const key of layout.flat()) {
      if (key === '') {
        grid.append(h('span', 'pad-blank reserved'));
        continue;
      }
      const b = h('button', 'key func-key');
      b.type = 'button';
      b.dataset.key = key;
      b.append(h('b', 'key-main'), h('small', 'key-sub'));
      b.addEventListener('click', () => this.pressFunc(key));
      this.funcButtons.set(key, b);
      grid.append(b);
    }
    this.funcRoot.append(grid);
  }

  updateMove(views: MoveKeyView[], confirm: ConfirmView, turn: TurnView, active: boolean): void {
    this.moveActive = active;
    this.moveRoot.classList.toggle('pad-active', active);
    const setTurn = (key: string, main: string, sub: string, label: string) => {
      const b = this.turnButtons.get(key);
      if (!b) return;
      b.setAttribute('aria-disabled', String(!active));
      (b.children[0] as HTMLElement).textContent = main;
      (b.children[1] as HTMLElement).textContent = sub;
      b.setAttribute('aria-label', `${label}：${sub}`);
    };
    setTurn('L', '⟲', turn.leftSub, '左轉一面');
    setTurn('R', '⟳', turn.rightSub, '右轉一面');
    setTurn('NOSE', turn.noseLabel, turn.noseSub, '機首（點一下 = 不轉）');
    this.turnButtons.get('NOSE')?.classList.toggle('key-selected', turn.turning);
    for (const v of views) {
      const b = this.moveButtons.get(v.rel);
      if (!b) continue;
      b.setAttribute('aria-disabled', String(!active || v.max === 0));
      b.classList.toggle('key-selected', v.taps > 0);
      (b.children[0] as HTMLElement).textContent = v.glyph;
      // 點數：實心 = 已點、空心 = 還能點；推不動就是一條線
      (b.children[1] as HTMLElement).textContent = v.max === 0 ? '—' : '●'.repeat(v.taps) + '○'.repeat(v.max - v.taps);
      b.setAttribute('aria-label', `${v.name}：${v.max === 0 ? '推不動' : `已點 ${v.taps}／最多 ${v.max}`}`);
    }
    if (this.confirmButton) {
      this.confirmButton.setAttribute('aria-disabled', String(!active));
      (this.confirmButton.children[0] as HTMLElement).textContent = confirm.label;
      (this.confirmButton.children[1] as HTMLElement).textContent = confirm.sub;
      this.confirmButton.setAttribute('aria-label', `${confirm.label}：${confirm.sub}`);
    }
  }

  updateFunc(views: FuncKeyView[], active: boolean): void {
    this.funcActive = active;
    this.funcRoot.classList.toggle('pad-active', active);
    for (const v of views) {
      this.funcViews.set(v.key, v);
      const b = this.funcButtons.get(v.key);
      if (!b) continue;
      const on = active && v.enabled;
      b.setAttribute('aria-disabled', String(!on));
      b.classList.toggle('key-warn', on && v.warn);
      (b.children[0] as HTMLElement).textContent = v.label;
      (b.children[1] as HTMLElement).textContent = v.sub;
      b.setAttribute('aria-label', `${v.label}（${v.sub}）${!on && v.reason ? '：' + v.reason : ''}`);
    }
  }

  private pressFunc(key: PadKey): void {
    if (!this.funcActive) {
      this.on.refused('先在左盤確認機動：行動在位移之後');
      return;
    }
    const v = this.funcViews.get(key);
    if (!v?.enabled) {
      if (v?.reason) this.on.refused(v.reason);
      return;
    }
    this.on.action(key);
  }
}
