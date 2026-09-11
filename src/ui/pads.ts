/**
 * 兩個觸控盤。
 *
 * 左盤 = 加速（設計者 2026-09-11）：**跟著機首排**，上面那顆永遠是「前」。
 * 往某個方向點幾下就是這回合在那個方向加速幾；中間是確認鍵（roguelike 的「空過」鍵），
 * 什麼都不點直接確認 = 這回合不加速。點另一個方向 = 改選；同一個方向點超過上限 = 歸零。
 * 選擇的狀態由 Game 持有，這裡只負責畫與回報點了哪顆。
 *
 * 右盤 = 功能盤，也就是座艙：佈局由機型的座艙定義（ui.json 的 cockpits），
 * 每一鍵顯示 AP 成本與產熱，會造成透支的以警示色標示。
 *
 * 不能按的鍵不用 `disabled` —— 那樣點下去什麼都不會發生。改用 aria-disabled，
 * 點了之後把理由告訴玩家（例如「噴射往左後方推不動」）。
 */
import type { PadKey } from './config';
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
  confirm(): void;
  action(key: PadKey): void;
  refused(reason: string): void;
}

export class Pads {
  private moveButtons = new Map<number, HTMLButtonElement>();
  private confirmButton: HTMLButtonElement | null = null;
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

  /** 左盤佈局：方向編號字串、'OK'、''（空格）。同一列相鄰的相同代號合併成跨欄的一顆鍵。 */
  buildMove(layout: string[][]): void {
    this.moveRoot.replaceChildren(h('div', 'pad-title', '① 加速（跟著機首）'));
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
      const b = h('button', key === 'OK' ? 'key confirm-key' : 'key move-key');
      b.type = 'button';
      b.dataset.key = key;
      if (span > 1) b.style.gridColumn = `span ${span}`;
      b.append(h('b', 'key-main'), h('small', 'key-sub'));
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      if (key === 'OK') {
        b.addEventListener('click', () => {
          if (!this.moveActive) return this.on.refused('行動階段：在右盤行動，或按「待機」結束這一回合');
          this.on.confirm();
        });
        this.confirmButton = b;
      } else {
        const rel = Number(key);
        b.addEventListener('click', () => {
          if (!this.moveActive) return this.on.refused('行動階段：在右盤行動，或按「待機」結束這一回合');
          this.on.tap(rel);
        });
        this.moveButtons.set(rel, b);
      }
      grid.append(b);
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

  updateMove(views: MoveKeyView[], confirm: ConfirmView, active: boolean): void {
    this.moveActive = active;
    this.moveRoot.classList.toggle('pad-active', active);
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
      this.on.refused('先在左盤確認加速：行動在位移之後');
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
