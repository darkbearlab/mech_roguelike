/**
 * 調參面板：手感測試時，設計者要能在手機上直接改數字、當場試。
 *
 * 改的是一份 RulesPatch（疊在 data/*.json 上），存在 localStorage，重新整理後還在。
 * 「複製調整值」把 patch 印成 JSON —— 貼回來，就能寫進 data/。
 * 面板本身不碰 core/ 的任何狀態；它只產生一份新的 Rules，由 Game 換上。
 */
import { RAW_MAPS } from '../core/content';
import { driveProfile } from '../core/movement';
import type { DriveProfile } from '../core/movement';
import type { Rules, RulesPatch } from '../core/rules';
import { pilotChassis } from '../core/rules';
import { BUILD_ID } from './build';
import { $, h } from './dom';

// v2：移動模型改成整數格之後，舊的調整值（thrust / drag…）已經沒有意義
const KEY = 'mech.tuning.v2';

export function loadPatch(): RulesPatch {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RulesPatch) : {};
  } catch {
    return {};
  }
}

function savePatch(p: RulesPatch): void {
  try {
    if (Object.keys(p).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // 私密瀏覽等情況存不了就算了：面板照樣能用，只是重新整理後會還原
  }
}

export interface TuningHost {
  rules(): Rules;
  base(): Rules;
  chassis(): string;
  map(): string;
  patch(): RulesPatch;
  setPatch(p: RulesPatch): void;
  setChassis(id: string): void;
  setMap(id: string): void;
  /** 決鬥場的對手機體；不是決鬥場 = null。 */
  rival(): string | null;
  setRival(id: string): void;
  restart(): void;
}

type Section = 'drives' | 'chassis' | 'weapons' | 'fireControls';

interface Field {
  section: Section;
  id: string;
  /** 欄位路徑，例如 ['taps', 'front']。 */
  path: string[];
  label: string;
  step: number;
  min: number;
}

type Tree = Record<string, unknown>;

function getIn(o: unknown, path: string[]): number {
  let cur = o as Tree;
  for (const k of path) cur = cur[k] as Tree;
  return cur as unknown as number;
}

/** 在 patch 樹上設值；等於預設值就刪掉，並把變空的層一路剪掉。 */
function setIn(root: Tree, path: string[], value: number | undefined): void {
  const [k, ...rest] = path;
  if (rest.length === 0) {
    if (value === undefined) delete root[k];
    else root[k] = value;
    return;
  }
  const child = (root[k] ??= {}) as Tree;
  setIn(child, rest, value);
  if (Object.keys(child).length === 0) delete root[k];
}

function turnsText(n: number | null, never: string): string {
  return n === null ? never : n + ' 回合';
}

function profileText(p: DriveProfile): string {
  return [
    `到極速 ${turnsText(p.turnsToMax, '到不了')}`,
    `滑行停 ${turnsText(p.coastTurns, '停不下來')}`,
    `煞車停 ${turnsText(p.brakeTurns, '不能反推')}`,
    `極速轉 60° 剩 ${p.veer60AtMax === null ? '—' : p.veer60AtMax} 速`,
    `推滿 +${p.heatFullPush} 熱`,
  ].join(' · ');
}

export class TuningPanel {
  private root = $('tune-panel');

  constructor(private host: TuningHost) {
    $('btn-tune').addEventListener('click', () => this.toggle());
  }

  toggle(): void {
    if (this.root.classList.contains('hidden')) this.open();
    else this.close();
  }

  open(): void {
    this.render();
    this.root.classList.remove('hidden');
  }

  close(): void {
    this.root.classList.add('hidden');
  }

  private set(f: Field, value: number): void {
    const p = structuredClone(this.host.patch()) as Tree;
    const base = getIn((this.host.base() as unknown as Tree)[f.section], [f.id, ...f.path]);
    setIn(p, [f.section, f.id, ...f.path], value === base ? undefined : value);
    savePatch(p as RulesPatch);
    this.host.setPatch(p as RulesPatch);
    this.render();
  }

  private render(): void {
    const rules = this.host.rules();
    const chassisId = this.host.chassis();
    const c = rules.chassis[chassisId];
    const body = h('div', 'tune-body');

    const head = h('div', 'tune-head');
    const title = h('div');
    // 畫面尺寸：地圖用的是畫布實際的大小；瀏覽器回報的 innerWidth 列在旁邊，兩個不一樣時截圖給我
    const cv = $('map');
    const screen = `畫面 ${cv.clientWidth}×${cv.clientHeight} @${window.devicePixelRatio || 1}x（innerWidth ${window.innerWidth}）`;
    title.append(h('b', '', '調參（手感測試）'), h('br'), h('small', '', `build ${BUILD_ID} · ${screen}`));
    head.append(title);
    const close = h('button', 'tune-x', '✕');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(close);
    body.append(head);

    // 地圖：跑道（情境測試）或試驗場（自由移動）
    const maps = h('div', 'tune-chassis');
    for (const m of RAW_MAPS) {
      const icon = m.course ? '🏁 ' : m.units?.some((u) => u.ai === 'DUEL') ? '⚔ ' : '';
      const b = h('button', m.id === this.host.map() ? 'on' : '', icon + m.name);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.host.setMap(m.id);
        this.render();
      });
      maps.append(b);
    }
    body.append(maps);

    // 決鬥場有兩排機體：你開的、對手
    const rival = this.host.rival();
    if (rival !== null) body.append(h('p', 'tune-profile', '你開的'));
    const pick = h('div', 'tune-chassis');
    for (const ch of pilotChassis(rules)) {
      const b = h('button', ch.id === chassisId ? 'on' : '', ch.name);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.host.setChassis(ch.id);
        this.render();
      });
      pick.append(b);
    }
    body.append(pick);

    // 決鬥場：對手也從四台試驗機裡挑
    if (rival !== null) {
      body.append(h('p', 'tune-profile', '對手'));
      const rv = h('div', 'tune-chassis');
      for (const ch of pilotChassis(rules)) {
        const b = h('button', ch.id === rival ? 'on' : '', ch.name);
        b.type = 'button';
        b.addEventListener('click', () => {
          this.host.setRival(ch.id);
          this.render();
        });
        rv.append(b);
      }
      body.append(rv);
    }

    for (const d of c.drives) {
      const drive = rules.drives[d];
      const box = h('section', 'tune-box');
      box.append(h('h3', '', `驅動：${drive.name}`));
      const f = (path: string[], label: string, min = 0): Field => ({ section: 'drives', id: d, path, label, step: 1, min });
      for (const field of [
        f(['maxSpeed'], '極速'),
        f(['taps', 'front'], '點數：前'),
        f(['taps', 'frontSide'], '點數：左右前'),
        f(['taps', 'rearSide'], '點數：左右後'),
        f(['taps', 'rear'], '點數：後'),
        f(['turnLoss', 'd60'], '轉 60° 折損'),
        f(['turnLoss', 'd120'], '轉 120° 折損'),
        f(['decay'], '不加速衰減'),
        f(['facingTurnSpeedLoss'], '右盤轉向扣速'),
        f(['heatPerTap'], '每點一下的熱'),
      ]) box.append(this.stepper(rules, field));
      box.append(h('p', 'tune-profile', profileText(driveProfile(rules, d))));
      body.append(box);
    }

    const box = h('section', 'tune-box');
    box.append(h('h3', '', `機體：${c.name}`));
    for (const field of [
      { section: 'chassis', id: chassisId, path: ['apQuota'], label: 'AP 配額', step: 1, min: 0 },
      { section: 'chassis', id: chassisId, path: ['heatPassive'], label: '被動散熱', step: 1, min: 0 },
    ] as Field[]) box.append(this.stepper(rules, field));
    body.append(box);

    // 射擊：命中率的基礎是火控 × 武器類別的適性（不是武器本身）
    const w = c.weapon ? rules.weapons[c.weapon] : null;
    const fc = c.fireControl ? rules.fireControls[c.fireControl] : null;
    if (w && fc) {
      const wbox = h('section', 'tune-box');
      wbox.append(h('h3', '', `射擊：${w.name} × ${fc.name}`));
      const fw = (path: string[], label: string, min = 0): Field => ({ section: 'weapons', id: w.id, path, label, step: 1, min });
      const ff = (path: string[], label: string, step = 1): Field => ({ section: 'fireControls', id: fc.id, path, label, step, min: 0 });
      for (const field of [
        ff(['aptitude', w.category], `火控適性（${w.category}）`, 5),
        fw(['optimal', 'min'], '有利射程：近'),
        fw(['optimal', 'max'], '有利射程：遠'),
        { ...fw(['optimal', 'bonus'], '有利射程加成'), step: 5 },
        ff(['tracking'], '追蹤（每 1 相對速度扣）'),
        fw(['weight'], '重量（每 1 自身速度扣）'),
        fw(['range'], '射程', 1),
        fw(['damage'], '傷害'),
        fw(['magazine'], '彈匣', 1),
      ]) wbox.append(this.stepper(rules, field));
      wbox.append(h('p', 'tune-profile',
        `停著打有利射程內的固定靶 ${Math.min(rules.combat.maxHit, fc.aptitude[w.category] + w.optimal.bonus)}%`
        + ` · 自己 3 速、靶靜止 ${Math.max(rules.combat.minHit, Math.min(rules.combat.maxHit, fc.aptitude[w.category] + w.optimal.bonus - 3 * fc.tracking - 3 * w.weight))}%`));
      body.append(wbox);
    }

    const patch = this.host.patch();
    const json = JSON.stringify(patch, null, 1);
    const out = h('section', 'tune-box');
    out.append(h('h3', '', '調整值（疊在 data/*.json 上）'));
    out.append(h('pre', 'tune-json', Object.keys(patch).length ? json : '（沒有調整，全部是預設值）'));
    const row = h('div', 'tune-actions');
    const copy = h('button', '', '複製調整值');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(json).then(
        () => { copy.textContent = '已複製 ✓'; },
        () => { copy.textContent = '複製失敗，請手動選取上面的文字'; },
      );
    });
    const reset = h('button', '', '還原預設');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      savePatch({});
      this.host.setPatch({});
      this.render();
    });
    const restart = h('button', '', '回到出生點重來');
    restart.type = 'button';
    restart.addEventListener('click', () => {
      this.host.restart();
      this.close();
    });
    row.append(copy, reset, restart);
    out.append(row);
    body.append(out);

    body.append(h('p', 'tune-foot',
      '操作：左盤是機動宣告 —— 最上排先轉向（⟲ ⟳，點幾下轉幾面，中間那格是轉完之後的機首，點它 = 不轉），'
      + '下面的方向鍵跟著轉完之後的機首排（上面那顆永遠是「前」）。往一個方向點幾下就加速幾，再按確認，轉向＋加速一起送出；什麼都不點直接確認 = 不轉、不加速。'
      + '點另一個方向 = 改選；同一方向點超過上限 = 歸零。地圖上機體周圍的數字是每個方向能點幾下。'
      + '確認後機體移動，換右盤行動（右盤不再轉向）；AP 用完或按「待機」就推進回合。'
      + '射擊：自動選命中率最高的目標；點地圖上的目標 = 改選（這一回合有效）並列出命中明細。亮的扇形是射界 × 射程，較亮那圈是有利射程。'
      + '決鬥場：你頭上的紅字「⚠」是對手打你的命中率（用它現在的位置與速度估）。'
      + '點地圖看地形與距離，拖曳平移，◎ 回中。'
      + '桌機：← → 轉向、W 前、E 右前、D 右後、S 後、A 左後、Q 左前、空白 確認；F 射擊、R 裝填、Tab 換目標、C 散熱、V 切換、Enter 待機。'));

    this.root.replaceChildren(body);
  }

  private stepper(rules: Rules, f: Field): HTMLElement {
    const tables = rules as unknown as Tree;
    const baseTables = this.host.base() as unknown as Tree;
    const value = getIn(tables[f.section], [f.id, ...f.path]);
    const base = getIn(baseTables[f.section], [f.id, ...f.path]);
    const row = h('div', 'tune-row');
    row.append(h('span', 'tune-label', f.label));
    const minus = h('button', '', '−');
    minus.type = 'button';
    minus.addEventListener('click', () => this.set(f, Math.max(f.min, value - f.step)));
    const plus = h('button', '', '+');
    plus.type = 'button';
    plus.addEventListener('click', () => this.set(f, value + f.step));
    row.append(minus, h('b', value === base ? 'tune-val' : 'tune-val changed', String(value)), plus);
    row.append(h('small', 'tune-note', value === base ? '' : `預設 ${base}`));
    return row;
  }
}
