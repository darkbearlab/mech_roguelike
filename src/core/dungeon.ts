/**
 * 地城產生器（設計者 2026-09-11：比傳統 nethack 寬敞的地城，測試機體從 A 點走到 B 點；
 * 敵人是軟很多的戰車 —— roguelike 的目的是玩家要過得了關，儘管有困難）。
 *
 * 純函式、只用種子亂數：同一個種子永遠同一張圖 —— bot 可以跑很多張算過關率。
 *   1. 整張填牆
 *   2. 放房間（矩形、互不重疊、之間留牆）
 *   3. 房間由左到右串起來，再多接幾條成迴圈；走廊寬 3 格（沿六角直線、半徑 1）
 *   4. 起點 = 最左邊的房間；出口 = 從起點走路最遠的房間
 *   5. 房間裡撒殘骸（半掩體），大房間立柱子（全掩體）；撒完確認起點走得到出口，走不到就全部收回
 *   6. 輕戰車（守衛：看到你才動）放在起點以外的房間；出口房間一定有一台
 * 產出的是一般的地圖檔（RawMap），跟手畫的地圖走同一條 loadMap 驗證。
 */
import type { Hex } from './hex';
import { DIR_VEC, add, dirToward, hexDist, hexLine } from './hex';
import type { RawMap, RawUnit } from './map';
import { hexToOffset, offsetToHex } from './map';
import { createRng, nextFloat } from './rng';

export interface DungeonOptions {
  /** 位移座標的欄數與列數。 */
  width?: number;
  height?: number;
  rooms?: number;
  tanks?: number;
  /** 敵方機體（chassis id）。 */
  enemy?: string;
  /** 建議的玩家機體。 */
  chassis?: string;
}

interface Room {
  col: number;
  row: number;
  w: number;
  h: number;
}

const WALL = 'X';
const FLOOR = '.';
const DEBRIS = 'o';

function overlaps(a: Room, b: Room, margin: number): boolean {
  return a.col - margin < b.col + b.w && b.col - margin < a.col + a.w
    && a.row - margin < b.row + b.h && b.row - margin < a.row + a.h;
}

export function generateDungeon(seed: number, o: DungeonOptions = {}): RawMap {
  const W = o.width ?? 46;
  const H = o.height ?? 34;
  const rng = createRng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(nextFloat(rng) * (hi - lo + 1));
  const g: string[][] = Array.from({ length: H }, () => Array<string>(W).fill(WALL));
  const inner = (h: Hex) => {
    const { col, row } = hexToOffset(h);
    return col >= 1 && col < W - 1 && row >= 1 && row < H - 1;
  };
  const get = (h: Hex) => {
    const { col, row } = hexToOffset(h);
    return inner(h) ? g[row][col] : WALL;
  };
  const set = (h: Hex, c: string) => {
    const { col, row } = hexToOffset(h);
    if (inner(h)) g[row][col] = c;
  };

  // 2. 房間
  const rooms: Room[] = [];
  for (let tries = 0; tries < 600 && rooms.length < (o.rooms ?? 7); tries++) {
    const w = int(7, 11);
    const h = int(6, 9);
    const r = { col: int(1, W - w - 1), row: int(1, H - h - 1), w, h };
    if (!rooms.some((x) => overlaps(x, r, 2))) rooms.push(r);
  }
  for (const r of rooms) for (let y = r.row; y < r.row + r.h; y++) for (let x = r.col; x < r.col + r.w; x++) g[y][x] = FLOOR;
  const center = (r: Room) => offsetToHex(r.col + Math.floor(r.w / 2), r.row + Math.floor(r.h / 2));
  const cells = (r: Room) => {
    const out: Hex[] = [];
    for (let y = r.row + 1; y < r.row + r.h - 1; y++) for (let x = r.col + 1; x < r.col + r.w - 1; x++) out.push(offsetToHex(x, y));
    return out;
  };

  // 3. 走廊
  const order = [...rooms].sort((a, b) => a.col - b.col);
  const links: [Room, Room][] = [];
  for (let i = 0; i + 1 < order.length; i++) links.push([order[i], order[i + 1]]);
  for (let k = 0; k < 2; k++) {
    const a = int(0, order.length - 1);
    const b = int(0, order.length - 1);
    if (Math.abs(a - b) > 1) links.push([order[a], order[b]]);
  }
  for (const [a, b] of links) {
    for (const h of hexLine(center(a), center(b))) {
      set(h, FLOOR);
      for (const v of DIR_VEC) set(add(h, v), FLOOR);
    }
  }

  // 4. 起點與出口（走路距離）
  const walk = (from: Hex): Map<string, number> => {
    const d = new Map<string, number>([[`${from.q},${from.r}`, 0]]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const h = queue[i];
      for (const v of DIR_VEC) {
        const n = add(h, v);
        const k = `${n.q},${n.r}`;
        if (d.has(k) || get(n) !== FLOOR) continue;
        d.set(k, d.get(`${h.q},${h.r}`)! + 1);
        queue.push(n);
      }
    }
    return d;
  };
  const startRoom = order[0];
  const start = center(startRoom);
  const reach = walk(start);
  const far = (r: Room) => reach.get(`${center(r).q},${center(r).r}`) ?? -1;
  const exitRoom = order.slice(1).reduce((best, r) => (far(r) > far(best) ? r : best), order[order.length - 1]);
  const exit = center(exitRoom);

  // 5. 殘骸與柱子（離房間中心至少 2 格：出口區與出生點保持空曠）；擋住出口就全部收回
  const placed: Hex[] = [];
  for (const r of order.slice(1)) {
    const spots = cells(r).filter((h) => hexDist(h, center(r)) >= 2);
    for (let k = int(2, 4); k > 0 && spots.length > 0; k--) {
      const h = spots.splice(int(0, spots.length - 1), 1)[0];
      set(h, DEBRIS);
      placed.push(h);
    }
    if (r.w >= 9 && r.h >= 8) {
      const pillar = add(center(r), DIR_VEC[int(0, 5)]);
      const p2 = add(pillar, DIR_VEC[int(0, 5)]);
      if (hexDist(p2, center(r)) >= 2) {
        set(p2, WALL);
        placed.push(p2);
      }
    }
  }
  if (!walk(start).has(`${exit.q},${exit.r}`)) for (const h of placed) set(h, FLOOR);

  // 6. 輕戰車：出口房間一台，其他房間（起點以外）各一台，多的放出口房間
  const enemy = o.enemy ?? 'tank';
  const units: RawUnit[] = [];
  const taken = new Set<string>();
  const dropTank = (r: Room): void => {
    const spots = cells(r).filter((h) => get(h) === FLOOR && hexDist(h, center(r)) >= 2 && !taken.has(`${h.q},${h.r}`));
    if (spots.length === 0) return;
    const h = spots[int(0, spots.length - 1)];
    taken.add(`${h.q},${h.r}`);
    const { col, row } = hexToOffset(h);
    units.push({ id: `tank${units.length + 1}`, chassis: enemy, col, row, facing: dirToward(h, center(r)), ai: 'GUARD' });
  };
  const others = order.slice(1).filter((r) => r !== exitRoom);
  for (let i = others.length - 1; i > 0; i--) {
    const j = int(0, i);
    [others[i], others[j]] = [others[j], others[i]];
  }
  const tanks = o.tanks ?? 5;
  dropTank(exitRoom);
  for (let i = 0; units.length < tanks && i < tanks * 2; i++) dropTank(i < others.length ? others[i] : exitRoom);

  const s = hexToOffset(start);
  const e = hexToOffset(exit);
  return {
    id: 'dungeon',
    name: '地城',
    width: W,
    height: H,
    rows: g.map((row) => row.join('')),
    spawns: { player: { col: s.col, row: s.row, facing: dirToward(start, center(order[1] ?? startRoom)) } },
    units,
    course: {
      name: '地城',
      chassis: o.chassis ?? 'wk1',
      checkpoints: [{
        id: 'exit',
        type: 'PASS',
        col: e.col,
        row: e.row,
        radius: 1,
        hint: '出口：衝進綠色區域就過關。戰車看到你（或被打）才會動 —— 可以繞、可以躲、可以打。',
        hooks: [{ when: 'ACTIVATE', type: 'MESSAGE', text: '地城：從這裡走到出口（畫面外的綠色箭頭）。路上有幾台輕戰車，發現你之前不會動。牆擋路也擋子彈；殘骸是半掩體。' }],
      }],
    },
  };
}
