/**
 * 射擊（設計者 2026-09-11 的命中模型）。
 *
 *   命中率 = 火控適性                  火控 × 武器類別（不是武器本身的命中 —— 比較好平衡）
 *          + 有利射程加成              距離落在武器的有利射程內
 *          − 追蹤 × 相對速度          自己與目標的相對位移差（主因；追蹤係數是火控的）
 *          − 重量 × 自己的速度        越重的武器高速時越不準
 *          − 角度                      偏離機首越多越難打（每 30° 一格，現在全 0）
 *          − 掩體                      半掩體（視線上緊貼目標的那一格，例如地城的殘骸）；全掩體（牆、稜線）直接擋視線
 *          − 電戰                      還沒有電戰系統，先 0
 *   夾在 combat.minHit ～ combat.maxHit。
 *
 * 相對速度 = 目標的速度向量減自己的速度向量的長度（同一把 cube 尺）：
 * 同向同速互打最準、迎面或交錯最難打；自己停下來時只剩目標的速度。
 *
 * 射界看武器（arcDegrees，以機首為中心）；射程是 cube 距離。
 * 明細（terms）逐項列出來 —— 介面照著顯示，玩家才知道為什麼打不中。
 */
import type { Dir, Hex } from './hex';
import { DIR_VEC, hexDist, hexLen, hexLine, offAxisDegrees, scale, sub } from './hex';
import type { GameMap } from './map';
import { cellAt } from './map';
import type { FireControlDef, Rules, WeaponDef } from './rules';
import type { GameState, Unit } from './state';

export function velocity(u: Pick<Unit, 'heading' | 'speed'>): Hex {
  return scale(DIR_VEC[u.heading], u.speed);
}

/** 自己與目標的相對位移差（格/回合）。 */
export function relativeSpeed(a: Unit, b: Unit): number {
  return hexLen(sub(velocity(b), velocity(a)));
}

export function weaponOf(rules: Rules, u: Unit): WeaponDef | null {
  const id = rules.chassis[u.chassis].weapon;
  return id ? rules.weapons[id] : null;
}

export function fireControlOf(rules: Rules, u: Unit): FireControlDef | null {
  const id = rules.chassis[u.chassis].fireControl;
  return id ? rules.fireControls[id] : null;
}

/** 火控對這把武器的適性；表裡沒有這個類別 = 0（載入時會擋，這裡只防調參時改出來的組合）。 */
export function aptitude(fc: FireControlDef, w: WeaponDef): number {
  return fc.aptitude[w.category] ?? 0;
}

export function inOptimal(w: WeaponDef, distance: number): boolean {
  return distance >= w.optimal.min && distance <= w.optimal.max;
}

export type HitTermKey = 'APTITUDE' | 'OPTIMAL' | 'RELATIVE' | 'WEIGHT' | 'ARC' | 'COVER' | 'EW';

export interface HitTerm {
  key: HitTermKey;
  label: string;
  /** 對命中率的影響（點數；扣分是負數）。 */
  value: number;
}

export interface ShotCheck {
  ok: boolean;
  reason?: string;
  distance: number;
  /** 偏離機首幾度。 */
  offAxis: number;
  /** 命中率（點數，已夾在上下限內）。 */
  chance: number;
  terms: HitTerm[];
}

/** 偏離角度落在 arcPenalty 的哪一格（每 30° 一格；超出表格用最後一格）。 */
export function arcBand(offAxis: number, table: number[]): number {
  return table[Math.min(table.length - 1, Math.floor(offAxis / 30))];
}

/**
 * 視線：兩格之間（不含兩端）有擋視線的地形（稜線、牆）就看不到。其他機體不擋。
 * 直線剛好擦過格子交界時，A→B 與 B→A 取的格子可能不同 —— 兩條任一條通就算看得到，
 * 所以視線是對稱的：你看得到它，它就看得到你。
 */
export function lineOfSight(map: GameMap, a: Hex, b: Hex): boolean {
  const clear = (line: Hex[]) => line.every((h, i) => i === 0 || i === line.length - 1 || !cellAt(map, h)?.blocksLos);
  return clear(hexLine(a, b)) || clear(hexLine(b, a));
}

/** 半掩體：視線上緊貼目標的那一格（或目標自己站的格）有 cover → 扣最大的那個。 */
export function coverOf(map: GameMap, from: Hex, to: Hex): number {
  const line = hexLine(from, to);
  let best = cellAt(map, to)?.cover ?? 0;
  for (let i = 1; i < line.length - 1; i++) {
    if (hexDist(line[i], to) === 1) best = Math.max(best, cellAt(map, line[i])?.cover ?? 0);
  }
  return best;
}

/** 命中率與明細。不檢查射程、射界、視線（那是 shotCheck 的事）；cover = 目標的半掩體扣幾點。 */
export function hitChance(
  rules: Rules, fc: FireControlDef, w: WeaponDef, shooter: Unit, target: Unit, cover = 0,
): { chance: number; terms: HitTerm[] } {
  const rel = relativeSpeed(shooter, target);
  const off = offAxisDegrees(shooter.pos, shooter.facing, target.pos);
  const d = hexDist(shooter.pos, target.pos);
  const o = w.optimal;
  const terms: HitTerm[] = [
    { key: 'APTITUDE', label: `火控適性（${fc.name} × ${w.name}）`, value: aptitude(fc, w) },
    { key: 'OPTIMAL', label: `距離 ${d}（有利射程 ${o.min}–${o.max}）`, value: inOptimal(w, d) ? o.bonus : 0 },
    { key: 'RELATIVE', label: `相對速度 ${rel} × 追蹤 ${fc.tracking}`, value: -fc.tracking * rel },
    { key: 'WEIGHT', label: `自身速度 ${shooter.speed} × 重量 ${w.weight}`, value: -w.weight * shooter.speed },
    { key: 'ARC', label: `偏離機首 ${Math.round(off)}°`, value: -arcBand(off, w.arcPenalty) },
    { key: 'COVER', label: cover > 0 ? '目標在半掩體後' : '沒有掩體', value: cover > 0 ? -cover : 0 },
    { key: 'EW', label: '電戰（尚無系統）', value: 0 },
  ];
  const raw = terms.reduce((a, t) => a + t.value, 0);
  const chance = Math.min(rules.combat.maxHit, Math.max(rules.combat.minHit, raw));
  return { chance, terms };
}

/** 偏離機首這麼多度還在不在射界內。邊界上的也算（180° 時，正側面那一排打得到）。 */
export function inArc(w: WeaponDef, offAxis: number): boolean {
  return offAxis <= w.arcDegrees / 2 + 1e-6;
}

/**
 * 射界 × 射程涵蓋的每一格（不含自己那格）。介面照這個畫扇形 ——
 * 與 shotCheck 用同一條規則，畫面上亮的格子就是打得到的格子。
 * 給了 map 就只留地圖上、站得了人、看得到的格子（牆後面的不亮）。
 */
export function arcHexes(w: WeaponDef, pos: Hex, facing: Dir, map?: GameMap): Hex[] {
  const out: Hex[] = [];
  for (let dq = -w.range; dq <= w.range; dq++) {
    for (let dr = Math.max(-w.range, -dq - w.range); dr <= Math.min(w.range, -dq + w.range); dr++) {
      if (dq === 0 && dr === 0) continue;
      const h = { q: pos.q + dq, r: pos.r + dr };
      if (!inArc(w, offAxisDegrees(pos, facing, h))) continue;
      if (map && !(cellAt(map, h)?.passable && lineOfSight(map, pos, h))) continue;
      out.push(h);
    }
  }
  return out;
}

/** 能不能打這個目標、打得中的機率多少。 */
export function shotCheck(s: GameState, shooter: Unit, target: Unit): ShotCheck {
  const w = weaponOf(s.rules, shooter);
  const fc = fireControlOf(s.rules, shooter);
  const distance = hexDist(shooter.pos, target.pos);
  const offAxis = offAxisDegrees(shooter.pos, shooter.facing, target.pos);
  const fail = (reason: string): ShotCheck => ({ ok: false, reason, distance, offAxis, chance: 0, terms: [] });
  if (!w) return fail('沒有武器');
  if (!fc) return fail('沒有火控');
  if (!target.alive) return fail('目標已經擊毀');
  if (target.side === shooter.side) return fail('不能打自己人');
  if (distance > w.range) return fail(`超出射程（${distance} 格 > ${w.range}）`);
  if (!inArc(w, offAxis)) return fail(`不在射界內（偏離機首 ${Math.round(offAxis)}°，射界 ±${w.arcDegrees / 2}°）`);
  if (!lineOfSight(s.map, shooter.pos, target.pos)) return fail('視線被擋住了');
  if (shooter.ammo <= 0) return fail('沒子彈了：先裝填');
  return { ok: true, distance, offAxis, ...hitChance(s.rules, fc, w, shooter, target, coverOf(s.map, shooter.pos, target.pos)) };
}

/** 這個射手現在打得到的目標，命中率高的在前。 */
export function targetsFor(s: GameState, shooter: Unit): { unit: Unit; check: ShotCheck }[] {
  return s.units
    .filter((u) => u.alive && u.side !== shooter.side)
    .map((u) => ({ unit: u, check: shotCheck(s, shooter, u) }))
    .filter((t) => t.check.ok)
    .sort((a, b) => b.check.chance - a.check.chance || a.check.distance - b.check.distance);
}
