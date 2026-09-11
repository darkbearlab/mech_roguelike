import './style.css';
import { RULES } from './core/rules';
import { Game } from './ui/game';
import { BUILD_ID } from './ui/build';

/**
 * 網址參數：
 *   ?seed=123      固定亂數種子（第 2 步還沒有東西會抽亂數，先把管線接好）
 *   ?chassis=jt1   指定機體（tk1 履帶 / wk1 步行 / jt1 噴射 / hy1 步行＋噴射）
 *   ?map=<id>      指定地圖
 */
const params = new URLSearchParams(location.search);

function readSeed(): number {
  const raw = params.get('seed');
  if (raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw) >>> 0;
  return Date.now() >>> 0;
}

function readChassis(): string {
  const raw = params.get('chassis');
  if (raw && RULES.chassis[raw]) return raw;
  return 'wk1';
}

const seed = readSeed();
const game = new Game({ seed, chassis: readChassis(), mapId: params.get('map') ?? 'proving_ground' });

Object.assign(window as unknown as Record<string, unknown>, { __game: game, __seed: seed, __build: BUILD_ID });
console.info('[mech] build =', BUILD_ID, '/ seed =', seed);
