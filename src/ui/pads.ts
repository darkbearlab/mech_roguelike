/**
 * 兩個觸控盤（§9）。
 *
 * 左盤 = 移動：3×2 六向 + 巡航 + 制動。**按住**時地圖上強調那一個選項的整條路徑，
 * 在按鍵上放開才送出；手指滑出按鍵再放開 = 取消。承諾制的遊戲，送出前要看得到後果。
 *
 * 右盤 = 功能盤，也就是座艙：佈局由機型的座艙定義（ui.json 的 cockpits），
 * 每一鍵顯示 AP 成本與產熱，會造成透支的以警示色標示。
 *
 * 不能按的鍵不用 `disabled` —— 那樣點下去什麼都不會發生。改用 aria-disabled，
 * 點了之後把理由告訴玩家（例如「側向加速：步行只能往前方三面推進」）。
 */
import type { PadKey } from './config';
import { h } from './dom';

export interface MoveKeyView {
  key: string;
  glyph: string;
  /** 按下去之後的速度（格/回合）。 */
  speed: string;
  heat: number;
  enabled: boolean;
  reason?: string;
  collision: boolean;
}

export interface FuncKeyView {
  key: PadKey;
  label: string;
  sub: string;
  enabled: boolean;
  /** 會造成透支（§9 警示色）。 */
  warn: boolean;
  reason?: string;
}

const MOVE_NAME: Record<string, string> = {
  0: '北', 1: '東北', 2: '東南', 3: '南', 4: '西南', 5: '西北', CRUISE: '巡航', BRAKE: '制動',
};

export interface PadHandlers {
  preview(key: string | null): void;
  accel(key: string): void;
  action(key: PadKey): void;
  refused(reason: string): void;
}

export class Pads {
  private moveButtons = new Map<string, HTMLButtonElement>();
  private funcButtons = new Map<PadKey, HTMLButtonElement>();
  private moveViews = new Map<string, MoveKeyView>();
  private funcViews = new Map<PadKey, FuncKeyView>();
  private moveActive = false;
  private funcActive = false;
  private funcLayout = '';

  constructor(
    private moveRoot: HTMLElement,
    private funcRoot: HTMLElement,
    private on: PadHandlers,
  ) {}

  /** 左盤佈局。同一列相鄰的相同代號合併成跨欄的一顆鍵。 */
  buildMove(layout: string[][]): void {
    this.moveRoot.replaceChildren(h('div', 'pad-title', '① 加速'));
    const grid = h('div', 'pad-grid');
    for (const row of layout) {
      for (let i = 0; i < row.length; i++) {
        const key = row[i];
        if (i > 0 && row[i - 1] === key) continue;
        let span = 1;
        while (row[i + span] === key) span++;
        const b = h('button', 'key move-key');
        b.type = 'button';
        b.dataset.key = key;
        if (span > 1) b.style.gridColumn = `span ${span}`;
        b.append(h('b', 'key-main'), h('small', 'key-sub'));
        this.bindMove(b, key);
        this.moveButtons.set(key, b);
        grid.append(b);
      }
    }
    this.moveRoot.append(grid);
  }

  /** 右盤佈局。換機型（換座艙）時重建；同一套佈局不重建，按鍵不會閃。 */
  buildFunc(layout: PadKey[][]): void {
    const sig = JSON.stringify(layout);
    if (sig === this.funcLayout) return;
    this.funcLayout = sig;
    this.funcButtons.clear();
    this.funcRoot.replaceChildren(h('div', 'pad-title', '② 行動'));
    const grid = h('div', 'pad-grid');
    for (const key of layout.flat()) {
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

  updateMove(views: MoveKeyView[], active: boolean): void {
    this.moveActive = active;
    this.moveRoot.classList.toggle('pad-active', active);
    for (const v of views) {
      this.moveViews.set(v.key, v);
      const b = this.moveButtons.get(v.key);
      if (!b) continue;
      const on = active && v.enabled;
      b.setAttribute('aria-disabled', String(!on));
      b.classList.toggle('key-collide', on && v.collision);
      const sub = !active || !v.enabled ? '' : v.speed + (v.heat > 0 ? ' · +' + v.heat : '');
      (b.children[0] as HTMLElement).textContent = v.glyph;
      (b.children[1] as HTMLElement).textContent = sub;
      b.setAttribute('aria-label', `${MOVE_NAME[v.key] ?? v.key}${sub ? '：速度 ' + sub : ''}`);
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

  private bindMove(b: HTMLButtonElement, key: string): void {
    let pressing = false;
    const inside = (e: PointerEvent): boolean => {
      const r = b.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    b.addEventListener('pointerdown', (e) => {
      if (!this.moveActive) {
        this.on.refused('行動階段：在右盤行動，或按「待機」結束這一回合');
        return;
      }
      const v = this.moveViews.get(key);
      if (!v?.enabled) {
        if (v?.reason) this.on.refused(v.reason);
        return;
      }
      pressing = true;
      b.setPointerCapture(e.pointerId);
      b.classList.add('key-down');
      this.on.preview(key);
    });
    b.addEventListener('pointermove', (e) => {
      if (!pressing) return;
      const inn = inside(e);
      b.classList.toggle('key-down', inn);
      this.on.preview(inn ? key : null);
    });
    b.addEventListener('pointerup', (e) => {
      if (!pressing) return;
      pressing = false;
      b.classList.remove('key-down');
      this.on.preview(null);
      if (inside(e)) this.on.accel(key);
    });
    b.addEventListener('pointercancel', () => {
      pressing = false;
      b.classList.remove('key-down');
      this.on.preview(null);
    });
    // 觸控長按不要跳出系統選單
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private pressFunc(key: PadKey): void {
    if (!this.funcActive) {
      this.on.refused('先在左盤宣告加速：行動在位移之後（§5）');
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
