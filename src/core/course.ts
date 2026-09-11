/**
 * 跑道與檢查點（情境測試，之後的新手教學也用這個）。
 *
 * 一條跑道 = 依序的檢查點。檢查點是一個圓形區域（中心格 + 半徑，同一把 cube 尺）：
 *   PASS  這回合的位移路徑碰到區域內任何一格就算通過
 *   STOP  位移結束時停在區域內、而且速度是 0
 * 只有「下一個」檢查點算數 —— 先碰到後面的不會跳關。一次長距離位移可以連續通過好幾個。
 *
 * 每個檢查點帶一句提示（hint）：跑道拿來當新手教學時，就是那一步要教的東西。
 *
 * 每個檢查點也可以掛**事件鉤子**（hooks，設計者 2026-09-11：檢查點可以當事件的鉤子）。
 * core 只負責在對的時機把鉤子發出來（GameEvent 的 COURSE_HOOK），**不解讀內容** ——
 * 跟座艙 id 一樣，是誰訂閱誰解讀。目前介面認得 MESSAGE（跳一段訊息）；
 * 之後的新手教學、生敵、開放按鍵、換規則……都是新的 type，不必改這裡。
 */
import type { Hex } from './hex';
import { add, hexDist, vec } from './hex';

export type CheckpointType = 'PASS' | 'STOP';

/** 鉤子什麼時候觸發。 */
export type HookWhen =
  /** 通過／停住這個檢查點的那一刻（預設）。 */
  | 'REACH'
  /** 這個檢查點成為「下一個目標」的那一刻（開局時的第一個也算）。 */
  | 'ACTIVATE';

export interface CourseHook {
  when: HookWhen;
  /** 事件種類，由訂閱的系統解讀；core 不看。 */
  type: string;
  /** 其餘欄位原封不動帶著走（例如 MESSAGE 的 text）。 */
  [k: string]: unknown;
}

export interface Checkpoint {
  /** 給鉤子與日後的腳本指名用；地圖檔沒寫就是 cp1、cp2…。 */
  id: string;
  type: CheckpointType;
  at: Hex;
  radius: number;
  hint: string;
  hooks: CourseHook[];
}

export interface Course {
  name: string;
  checkpoints: Checkpoint[];
}

/** 跑到哪了。進 GameState，所以跟著存檔與可重現性走。 */
export interface CourseProgress {
  /** 下一個要過的檢查點（= 已經過了幾個）。 */
  next: number;
  /** 每個已通過的檢查點是在第幾回合通過的。 */
  reached: number[];
  /** 跑完的回合；還沒跑完是 null。 */
  done: number | null;
}

export function newProgress(): CourseProgress {
  return { next: 0, reached: [], done: null };
}

export function inCheckpoint(cp: Checkpoint, h: Hex): boolean {
  return hexDist(cp.at, h) <= cp.radius;
}

/** 區域內所有的格子（畫面用）。半徑 r 共 1 + 3r(r+1) 格。 */
export function checkpointHexes(cp: Checkpoint): Hex[] {
  const out: Hex[] = [];
  for (let dq = -cp.radius; dq <= cp.radius; dq++) {
    for (let dr = -cp.radius; dr <= cp.radius; dr++) {
      const h = add(cp.at, vec(dq, dr));
      if (inCheckpoint(cp, h)) out.push(h);
    }
  }
  return out;
}

/**
 * 一次位移之後的進度（純函式）。
 *
 * @param path     這回合走過的格子（含起點）
 * @param endSpeed 位移結束時的速度（STOP 要 0）
 * @returns 新的進度與這一次通過了哪些檢查點（索引）
 */
export function advanceCourse(
  course: Course, p: CourseProgress, path: Hex[], endSpeed: number, round: number,
): { progress: CourseProgress; passed: number[] } {
  const out: CourseProgress = { next: p.next, reached: [...p.reached], done: p.done };
  const passed: number[] = [];
  const cps = course.checkpoints;
  const hit = (i: number): void => {
    out.reached.push(round);
    passed.push(i);
    out.next = i + 1;
  };
  for (const h of path) {
    while (out.next < cps.length && cps[out.next].type === 'PASS' && inCheckpoint(cps[out.next], h)) hit(out.next);
  }
  // 停車框：看停下來的那一格；停住之後，同一格若剛好也在下一個通過區裡，一併算
  const last = path[path.length - 1];
  while (out.next < cps.length && inCheckpoint(cps[out.next], last)
    && (cps[out.next].type === 'PASS' || endSpeed === 0)) hit(out.next);
  if (out.next === cps.length && out.done === null) out.done = round;
  return { progress: out, passed };
}

/** 第 index 個檢查點在某個時機要發出的鉤子（超出範圍回傳空陣列）。 */
export function hooksOf(course: Course, index: number, when: HookWhen): CourseHook[] {
  return course.checkpoints[index]?.hooks.filter((h) => h.when === when) ?? [];
}
