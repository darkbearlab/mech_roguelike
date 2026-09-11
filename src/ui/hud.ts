/**
 * 儀表（§9）：速度（含方向）、朝向、熱量條、AP 與債務、彈藥。
 *
 * 左上角的姿態儀同時畫朝向（機首）與速度向量（箭頭）——
 * 兩者分離是本作動態感的核心（§3.3），所以要放在同一個小圓裡一眼看得出夾角。
 * 顯示精度由座艙的資訊層決定（Readouts），v0.1 全開。
 */
import type { Dir, SubVec } from '../core/hex';
import { DIR_NAME, SUB, hexLen } from '../core/hex';
import { DIR_GLYPH, dirAngle, vecAngle } from '../render/geometry';
import type { Readouts } from './config';
import { $ } from './dom';

export interface HudView {
  chassisName: string;
  driveName: string;
  velSub: SubVec;
  maxSpeed: number;
  facing: Dir;
  heat: number;
  heatCap: number;
  /** 熱量懲罰門檻（0..1）。 */
  hotAbove: number;
  shutdown: boolean;
  ap: number;
  quota: number;
  debt: number;
  debtCap: number;
  round: number;
  readouts: Readouts;
}

function speedBand(v: number, max: number): string {
  if (v === 0) return '靜止';
  const k = v / max;
  return k < 0.34 ? '慢' : k < 0.67 ? '中' : '快';
}

export class Hud {
  private dial = $('dial') as HTMLCanvasElement;
  private toastTimer = 0;

  update(v: HudView): void {
    const speed = hexLen(v.velSub);
    $('hud-speed').textContent = v.readouts.speed === 'NUMERIC'
      ? (speed / SUB).toFixed(1) + ' 格/回'
      : speedBand(speed, v.maxSpeed);
    $('hud-facing').textContent = '朝向 ' + DIR_GLYPH[v.facing] + DIR_NAME[v.facing];
    $('hud-drive').textContent = v.driveName;
    $('hud-round').textContent = '第 ' + v.round + ' 回合';
    $('hud-chassis').textContent = v.chassisName;

    // 熱量
    const ratio = v.heat / v.heatCap;
    const hot = ratio > v.hotAbove;
    const bar = $('hud-heat');
    bar.classList.toggle('hot', hot);
    bar.classList.toggle('dead', v.shutdown);
    bar.classList.toggle('light-only', v.readouts.heat === 'LIGHT');
    ($('hud-heat-fill') as HTMLElement).style.width = (ratio * 100).toFixed(1) + '%';
    ($('hud-heat-mark') as HTMLElement).style.left = (v.hotAbove * 100).toFixed(1) + '%';
    $('hud-heat-num').textContent = v.shutdown
      ? '停機'
      : v.readouts.heat === 'NUMERIC' ? '熱 ' + Math.round(v.heat) : hot ? '過熱警告' : '熱';

    // AP：實心 = 手上的，空心 = 已用掉的配額，紅色 = 債務
    const pips: string[] = [];
    for (let i = 0; i < v.quota; i++) pips.push(i < v.ap ? '●' : '○');
    const debt = '▮'.repeat(v.debt) + '▯'.repeat(Math.max(0, v.debtCap - v.debt));
    $('hud-ap').innerHTML = `<span class="ap-pips">AP ${pips.join('')}</span>`
      + `<span class="debt${v.debt > 0 ? ' on' : ''}">債 ${debt}</span>`;
    $('hud-ammo').textContent = '彈 —';

    this.drawDial(v);
  }

  toast(msg: string, kind: 'info' | 'warn' | 'bad' = 'info'): void {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show ' + kind;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), 2400);
  }

  private drawDial(v: HudView): void {
    const c = this.dial;
    const dpr = window.devicePixelRatio || 1;
    const css = c.clientWidth || 56;
    if (c.width !== Math.round(css * dpr)) {
      c.width = Math.round(css * dpr);
      c.height = Math.round(css * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const R = css / 2;
    ctx.clearRect(0, 0, css, css);
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.fillStyle = '#0f141a';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // 六個方向的刻度
    for (let d = 0 as Dir; d < 6; d = (d + 1) as Dir) {
      const a = dirAngle(d);
      ctx.beginPath();
      ctx.moveTo(R + Math.cos(a) * (R - 6), R + Math.sin(a) * (R - 6));
      ctx.lineTo(R + Math.cos(a) * (R - 2), R + Math.sin(a) * (R - 2));
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.stroke();
    }
    // 朝向：機首
    const f = dirAngle(v.facing);
    ctx.beginPath();
    ctx.moveTo(R + Math.cos(f) * R * 0.62, R + Math.sin(f) * R * 0.62);
    ctx.lineTo(R + Math.cos(f + 2.5) * R * 0.34, R + Math.sin(f + 2.5) * R * 0.34);
    ctx.lineTo(R + Math.cos(f - 2.5) * R * 0.34, R + Math.sin(f - 2.5) * R * 0.34);
    ctx.closePath();
    ctx.fillStyle = v.shutdown ? '#ff5a5a' : '#4fd6ff';
    ctx.fill();
    // 速度向量：長度 ∝ 速度 / 極速
    const a = vecAngle(v.velSub);
    if (a !== null) {
      const len = Math.min(1, hexLen(v.velSub) / Math.max(1, v.maxSpeed)) * (R - 4);
      const tx = R + Math.cos(a) * len;
      const ty = R + Math.sin(a) * len;
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(R, R);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tx, ty, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd166';
      ctx.fill();
    }
  }
}
