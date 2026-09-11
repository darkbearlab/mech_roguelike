/**
 * 無介面自動對局：跑 N 場、輸出基線數據。之後每次改平衡都拿它比對。
 *
 *   npm run bot                         每台機體 30 場隨機行程 + 每條跑道各跑一次
 *   npm run bot -- --runs 100 --seed 7  場數與起始種子
 *   npm run bot -- --chassis jt1        只跑一台
 *   npm run bot -- --json               另存 bot/out/baseline-<時間>.json
 *
 * 試驗場只量移動（勝率先印 —，有敵人 AI 之後由同一支程式填上）；有靶的跑道（射擊場）量命中率與擊毀數，
 * 每台跑 --runs 個種子取總和。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { RAW_MAPS, rawMapById } from '../src/core/content';
import { loadMap } from '../src/core/map';
import { driveProfile } from '../src/core/movement';
import { RULES, pilotChassis } from '../src/core/rules';
import { runCourse } from './course';
import type { CourseResult } from './course';
import { MAX_DIST, MIN_DIST, runOne } from './match';
import type { RunResult } from './match';

function avg<T>(rows: T[], f: (r: T) => number): number {
  return rows.length ? rows.reduce((a, r) => a + f(r), 0) / rows.length : 0;
}

function pad(s: string | number, n: number): string {
  return String(s).padStart(n);
}

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '30' },
    seed: { type: 'string', default: '1' },
    chassis: { type: 'string', default: 'all' },
    map: { type: 'string', default: 'proving_ground' },
    'max-turns': { type: 'string', default: '60' },
    json: { type: 'boolean', default: false },
  },
});
const runs = Number(values.runs);
const seed0 = Number(values.seed);
const maxTurns = Number(values['max-turns']);
const raw = rawMapById(values.map!);
if (!raw) throw new Error('沒有這張地圖：' + values.map);
const map = loadMap(RULES, raw);
const ids = values.chassis === 'all' ? pilotChassis(RULES).map((c) => c.id) : [values.chassis!];

console.log(`\n地圖 ${map.name}（${map.id}）· 每台 ${runs} 場 · 種子 ${seed0}..${seed0 + runs - 1} · 上限 ${maxTurns} 回合`);
console.log(`一場 = 從隨機起點開到 ${MIN_DIST}～${MAX_DIST} 格外的隨機目標（抵達 = 佔格離目標 ≤ 1）\n`);

console.log('驅動輪廓（空地；單位：回合）');
console.log('驅動  極速  點數 前/前側/後側/後  折損60/120  衰減  到極速  滑行停  煞車停  極速轉60°  推滿熱');
const pilotDrives = new Set(pilotChassis(RULES).flatMap((c) => c.drives));
for (const d of Object.values(RULES.drives).filter((x) => pilotDrives.has(x.id))) {
  const p = driveProfile(RULES, d.id);
  const n = (x: number | null): string => (x === null ? '—' : String(x));
  const t = d.taps;
  console.log(
    d.name.padEnd(4), pad(d.maxSpeed, 3),
    pad(`${t.front}/${t.frontSide}/${t.rearSide}/${t.rear}`, 17),
    pad(`${d.turnLoss.d60}/${d.turnLoss.d120}`, 11), pad(d.decay, 5),
    pad(n(p.turnsToMax), 7), pad(n(p.coastTurns), 7), pad(n(p.brakeTurns), 7),
    pad(n(p.veer60AtMax), 10), pad(p.heatFullPush, 7),
  );
}

const all: RunResult[] = [];
console.log('\n機體       抵達率  平均回合  格/回合  熱量峰值  撞擊/場  過熱/場  最高速  勝率  命中率');
for (const id of ids) {
  const rows: RunResult[] = [];
  for (let i = 0; i < runs; i++) rows.push(runOne(RULES, map, id, seed0 + i, maxTurns));
  all.push(...rows);
  const ok = rows.filter((r) => r.arrived);
  console.log(
    `${RULES.chassis[id].name.padEnd(9)}`,
    pad(((ok.length / rows.length) * 100).toFixed(0) + '%', 6),
    pad(avg(ok, (r) => r.turns).toFixed(1), 8),
    pad(avg(ok, (r) => r.distance / r.turns).toFixed(2), 8),
    pad(avg(rows, (r) => r.heatPeak).toFixed(1), 8),
    pad(avg(rows, (r) => r.collisions).toFixed(2), 8),
    pad(avg(rows, (r) => r.shutdowns).toFixed(2), 8),
    pad(avg(rows, (r) => r.topSpeed).toFixed(1), 7),
    pad('—', 5), pad('—', 6),
  );
}
console.log('\n（平均回合與格/回合只算抵達的場次；複合機的自動駕駛不切換驅動；試驗場沒有靶，命中率看下面的射擊場。）');

// ---------------------------------------------------------------- 情境：跑道

const courses: { map: string; results: CourseResult[] }[] = [];
for (const rawCourse of RAW_MAPS.filter((m) => m.course)) {
  const cmap = loadMap(RULES, rawCourse);
  // 有靶的跑道（射擊場）命中率會隨擲骰變：跑 runs 個種子取總和；純跑道一個種子就夠
  const hasTargets = cmap.units.length > 0 || cmap.course!.checkpoints.some((c) => c.hooks.some((h) => h.type === 'SPAWN'));
  const seeds = hasTargets ? Math.max(1, runs) : 1;
  const results = ids.map((id) => {
    const rs = Array.from({ length: seeds }, (_, i) => runCourse(RULES, cmap, id, 120, seed0 + i));
    const first = rs[0];
    const sum = (f: (r: CourseResult) => number) => rs.reduce((a, r) => a + f(r), 0);
    return { ...first, shots: sum((r) => r.shots), hits: sum((r) => r.hits), kills: sum((r) => r.kills), targets: sum((r) => r.targets), all: rs };
  });
  courses.push({ map: cmap.id, results });
  console.log(`\n情境：${cmap.name}（${cmap.id}，${cmap.course!.checkpoints.length} 個檢查點${hasTargets ? `，${seeds} 個種子` : ''}）`);
  console.log(hasTargets
    ? '機體       完賽率  平均回合  熱量峰值  命中率        擊毀'
    : '機體       完賽  回合  熱量峰值  撞擊  各檢查點通過的回合');
  for (const r of results) {
    if (hasTargets) {
      const done = r.all.filter((x) => x.finished);
      console.log(
        `${RULES.chassis[r.chassis].name.padEnd(9)}`,
        pad(`${done.length}/${r.all.length}`, 6),
        pad(done.length ? avg(done, (x) => x.turns).toFixed(1) : '—', 8),
        pad(Math.max(...r.all.map((x) => x.heatPeak)), 8),
        pad(r.shots ? `${((r.hits / r.shots) * 100).toFixed(0)}%（${r.hits}/${r.shots}）` : '—', 12),
        pad(`${r.kills}/${r.targets}`, 8),
      );
    } else {
      console.log(
        `${RULES.chassis[r.chassis].name.padEnd(9)}`,
        pad(r.finished ? '✓' : '✗', 4), pad(r.finished ? r.turns : '—', 5),
        pad(r.heatPeak, 8), pad(r.collisions, 5), ' ', r.splits.join(' '),
      );
    }
  }
}
console.log('\n（跑道固定、自動駕駛只用玩家能用的指令、擲骰用固定種子 —— 同一份規則永遠跑出同一個結果。）');

if (values.json) {
  mkdirSync('bot/out', { recursive: true });
  const path = `bot/out/baseline-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(path, JSON.stringify({ map: map.id, runs, seed: seed0, maxTurns, results: all, courses }, null, 1));
  console.log('已寫入 ' + path);
}
