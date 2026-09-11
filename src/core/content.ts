/**
 * 內容清單：目前有哪些地圖。
 *
 * 地圖要用規則的地形表才讀得進來，所以這裡只給原始資料，由呼叫端用手上那一份 Rules 去 loadMap()。
 */
import provingGround from '../data/maps/proving_ground.json';
import range01 from '../data/maps/range_01.json';
import track01 from '../data/maps/track_01.json';
import type { RawMap } from './map';

/** 第一張是預設地圖：跑道（情境測試，之後的新手教學）。射擊場接在後面。 */
export const RAW_MAPS: readonly RawMap[] = [track01 as RawMap, range01 as RawMap, provingGround as RawMap];

export function rawMapById(id: string): RawMap | undefined {
  return RAW_MAPS.find((m) => m.id === id);
}
