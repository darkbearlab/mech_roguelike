/**
 * 內容清單：目前有哪些地圖。
 *
 * 地圖要用規則的地形表才讀得進來（阻力修正是讀圖時烘進格子的），
 * 所以這裡只給原始資料，由呼叫端用手上那一份 Rules 去 loadMap()。
 */
import provingGround from '../data/maps/proving_ground.json';
import type { RawMap } from './map';

export const RAW_MAPS: readonly RawMap[] = [provingGround as RawMap];

export function rawMapById(id: string): RawMap | undefined {
  return RAW_MAPS.find((m) => m.id === id);
}
