/**
 * 內容清單：目前有哪些地圖。
 *
 * 地圖要用規則的地形表才讀得進來，所以這裡只給原始資料，由呼叫端用手上那一份 Rules 去 loadMap()。
 * 地城是產生的：同一個種子同一張圖（rawMapFor 帶種子）；清單裡放的是種子 1 那一張。
 */
import duel01 from '../data/maps/duel_01.json';
import provingGround from '../data/maps/proving_ground.json';
import range01 from '../data/maps/range_01.json';
import track01 from '../data/maps/track_01.json';
import { generateDungeon } from './dungeon';
import type { RawMap } from './map';

/** 產生的地圖的 id。 */
export const DUNGEON_ID = 'dungeon';

/** 第一張是預設地圖：跑道（情境測試，之後的新手教學）。射擊場、決鬥場、地城接在後面。 */
export const RAW_MAPS: readonly RawMap[] = [
  track01 as RawMap, range01 as RawMap, duel01 as RawMap, generateDungeon(1), provingGround as RawMap,
];

export function rawMapById(id: string): RawMap | undefined {
  return RAW_MAPS.find((m) => m.id === id);
}

/** 照 id 取地圖；地城照種子產生（同一個種子同一張圖）。 */
export function rawMapFor(id: string, seed: number): RawMap | undefined {
  return id === DUNGEON_ID ? generateDungeon(seed) : rawMapById(id);
}
