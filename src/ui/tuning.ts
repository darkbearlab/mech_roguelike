/**
 * 調參面板：第 2 步是手感測試，設計者要能在手機上直接改數字、當場試。
 *
 * 改的是一份 RulesPatch（疊在 data/*.json 上），存在 localStorage，重新整理後還在。
 * 「複製調整值」把 patch 印成 JSON —— 貼回來給我，我再把它寫進 data/。
 * 面板本身不碰 core/ 的任何狀態；它只產生一份新的 Rules，由 Game 換上。
 */
import { driveProfile } from '../core/movement';
import type { DriveProfile } from '../core/movement';
import type { Rules, RulesPatch } from '../core/rules';
import { accelOf } from '../core/rules';
import { BUILD_ID } from './build';
import { $, h } from './dom';

const KEY = 'mech.tuning.v1';

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
  patch(): RulesPatch;
  setPatch(p: RulesPatch): void;
  setChassis(id: string): void;
  restart(): void;
}

type Section = 'drives' | 'chassis' | 'terrain';

interface Field {
  section: Section;
  id: string;
  key: string;
  label: string;
  step: number;
  min: number;
  /** 旁邊的註解（例如推力換算出的 accel）。 */
  note?: (r: Rules) => string;
}

function turnsText(n: number | null, never: string): string {
  return n === null ? never : n + ' 回合';
}

function profileText(p: DriveProfile): string {
  if (p.netPush === 0) return '⚠ 推不動：accel ≤ drag，淨推進為 0';
  return [
    `淨推 +${(p.netPush / 10).toFixed(1)} 格/回`,
    `到極速 ${turnsText(p.turnsToMax, '到不了')}`,
    `滑行停 ${turnsText(p.coastTurns, '停不下來')}`,
    `制動停 ${turnsText(p.brakeTurns, '停不下來')}`,
    `每推 +${p.heatPerPush} 熱`,
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

  private set(section: Section, id: string, key: string, value: number): void {
    const p = structuredClone(this.host.patch());
    const table = (p[section] ??= {}) as Record<string, Record<string, number>>;
    const row = (table[id] ??= {});
    const baseVal = (this.host.base()[section] as unknown as Record<string, Record<string, unknown>>)[id][key];
    if (value === baseVal) delete row[key];
    else row[key] = value;
    if (Object.keys(row).length === 0) delete table[id];
    if (Object.keys(table).length === 0) delete p[section];
    savePatch(p);
    this.host.setPatch(p);
    this.render();
  }

  private render(): void {
    const rules = this.host.rules();
    const chassisId = this.host.chassis();
    const c = rules.chassis[chassisId];
    const body = h('div', 'tune-body');

    const head = h('div', 'tune-head');
    const title = h('div');
    title.append(h('b', '', '調參（第 2 步：手感測試）'), h('br'), h('small', '', 'build ' + BUILD_ID));
    head.append(title);
    const close = h('button', 'tune-x', '✕');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(close);
    body.append(head);

    // 機體
    const pick = h('div', 'tune-chassis');
    for (const ch of Object.values(rules.chassis)) {
      const b = h('button', ch.id === chassisId ? 'on' : '', ch.name);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.host.setChassis(ch.id);
        this.render();
      });
      pick.append(b);
    }
    body.append(pick);

    // 驅動
    for (const d of c.drives) {
      const drive = rules.drives[d];
      const box = h('section', 'tune-box');
      box.append(h('h3', '', `驅動：${drive.name}`));
      const fields: Field[] = [
        { section: 'drives', id: d, key: 'thrust', label: '推力 thrust', step: 5, min: 0, note: (r) => `accel ${accelOf(r, chassisId, d)}` },
        { section: 'drives', id: d, key: 'drag', label: '阻力 drag', step: 1, min: 0 },
        { section: 'drives', id: d, key: 'maxSpeed', label: '極速 maxSpeed', step: 1, min: 0 },
        { section: 'drives', id: d, key: 'heatPerAccel', label: '產熱 /10sub', step: 1, min: 0 },
      ];
      for (const f of fields) box.append(this.stepper(rules, f));
      box.append(h('p', 'tune-profile', profileText(driveProfile(rules, chassisId, d))));
      body.append(box);
    }

    // 機體與地形
    const box = h('section', 'tune-box');
    box.append(h('h3', '', `機體：${c.name}`));
    for (const f of [
      { section: 'chassis', id: chassisId, key: 'mass', label: '質量 mass', step: 5, min: 5 },
      { section: 'chassis', id: chassisId, key: 'apQuota', label: 'AP 配額', step: 1, min: 0 },
      { section: 'chassis', id: chassisId, key: 'heatPassive', label: '被動散熱', step: 1, min: 0 },
      { section: 'terrain', id: 'rubble', key: 'dragModifier', label: '碎石阻力 +', step: 1, min: 0 },
    ] as Field[]) box.append(this.stepper(rules, f));
    body.append(box);

    // 匯出
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
      '操作：左盤按住看路徑、放開送出，滑出按鍵再放開 = 取消。每回合先加速（左盤）、再行動（右盤），按「待機」結束回合。'
      + '地面驅動只能往機首前方三面推進，轉向在行動階段做 —— 所以這回合轉的向，決定下回合能往哪推。'
      + '點地圖看地形與距離，拖曳平移，◎ 回中。桌機：QWE/ASD 六向、空白 巡航、X 制動、←→ 轉向、C 散熱、V 切換、Enter 待機。'));

    this.root.replaceChildren(body);
  }

  private stepper(rules: Rules, f: Field): HTMLElement {
    const table = rules[f.section] as unknown as Record<string, Record<string, number>>;
    const base = (this.host.base()[f.section] as unknown as Record<string, Record<string, number>>)[f.id][f.key];
    const value = table[f.id][f.key];
    const row = h('div', 'tune-row');
    row.append(h('span', 'tune-label', f.label));
    const minus = h('button', '', '−');
    minus.type = 'button';
    minus.addEventListener('click', () => this.set(f.section, f.id, f.key, Math.max(f.min, value - f.step)));
    const plus = h('button', '', '+');
    plus.type = 'button';
    plus.addEventListener('click', () => this.set(f.section, f.id, f.key, value + f.step));
    const val = h('b', value === base ? 'tune-val' : 'tune-val changed', String(value));
    row.append(minus, val, plus);
    const notes = [f.note ? f.note(rules) : '', value === base ? '' : `預設 ${base}`].filter(Boolean);
    row.append(h('small', 'tune-note', notes.join(' · ')));
    return row;
  }
}
