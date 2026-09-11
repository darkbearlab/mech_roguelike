/**
 * 介面的便利設定：上次選的地圖、機體與決鬥對手，每張圖每台機體的最佳紀錄。
 * 只存在這支手機的 localStorage；存不了（私密瀏覽等）就當作沒有，遊戲照常。
 */

const PREFS = 'mech.ui.v1';
const BEST = 'mech.best.v1';

export interface Prefs {
  map?: string;
  chassis?: string;
  /** 決鬥場的對手機體。 */
  rival?: string;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不了就算了
  }
}

export function loadPrefs(): Prefs {
  return read<Prefs>(PREFS, {});
}

export function savePrefs(p: Prefs): void {
  write(PREFS, p);
}

type Best = Record<string, Record<string, number>>;

export function bestOf(mapId: string, chassis: string): number | null {
  return read<Best>(BEST, {})[mapId]?.[chassis] ?? null;
}

/** 記錄一次完賽。回傳這次是不是新紀錄。 */
export function recordFinish(mapId: string, chassis: string, turns: number): boolean {
  const all = read<Best>(BEST, {});
  const prev = all[mapId]?.[chassis];
  if (prev !== undefined && prev <= turns) return false;
  (all[mapId] ??= {})[chassis] = turns;
  write(BEST, all);
  return true;
}
