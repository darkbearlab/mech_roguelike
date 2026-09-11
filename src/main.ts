import './style.css';
import { RAW_MAPS, rawMapById } from './core/content';
import { RULES } from './core/rules';
import { Game } from './ui/game';
import { BUILD_ID } from './ui/build';
import { loadPrefs } from './ui/prefs';

/**
 * 網址參數（優先於上次的選擇）：
 *   ?seed=123        固定亂數種子（命中擲骰用）
 *   ?map=track_01    指定地圖（track_01 基礎跑道 / range_01 射擊場 / proving_ground 試驗場）
 *   ?chassis=jt1     指定機體（tk1 履帶 / wk1 步行 / jt1 噴射 / hy1 步行＋噴射）
 */
const params = new URLSearchParams(location.search);
const prefs = loadPrefs();

function readSeed(): number {
  const raw = params.get('seed');
  if (raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw) >>> 0;
  return Date.now() >>> 0;
}

/** 地圖：網址 → 上次選的 → 第一張（跑道）。 */
function readMap(): string {
  for (const id of [params.get('map'), prefs.map]) if (id && rawMapById(id)) return id;
  return RAW_MAPS[0].id;
}

/** 機體：網址 → 上次選的 → 跑道建議的 → 步行。 */
function readChassis(mapId: string): string {
  for (const id of [params.get('chassis'), prefs.chassis, rawMapById(mapId)?.course?.chassis]) {
    // 靶（role TARGET）不能開
    if (id && RULES.chassis[id]?.role === 'PILOT') return id;
  }
  return 'wk1';
}

const seed = readSeed();
const mapId = readMap();
const game = new Game({ seed, chassis: readChassis(mapId), mapId });
// index.html 的開機失敗說明：走到這裡就代表成功了
document.getElementById('boot-fail')?.remove();

Object.assign(window as unknown as Record<string, unknown>, { __game: game, __seed: seed, __build: BUILD_ID });
console.info('[mech] build =', BUILD_ID, '/ seed =', seed);
