/**
 * 构建活动追踪器（2026-06-23）。
 *
 * 用户痛点：「一个不怎么用的项目在作死地反复构建——分支很少但很频繁」。
 * 光看实时 docker stats 抓不到这种「此刻没在构建、但一小时内构建了 40 次」的
 * 抖动型 CPU 杀手。本追踪器在内存里记录每一次 deploy 的发生时间（按项目），
 * 资源面板据此算出「近 1h / 近 24h 构建次数」，把频繁构建的项目排到前面。
 *
 * 设计取舍：
 *   - 纯内存 ring buffer，进程重启清空。这没关系——风暴是「正在进行时」，
 *     重启后几分钟内就会重新填满；我们要的是实时信号不是历史账本。
 *   - 写入路径（deploy 端点）零额外 I/O，只 push 一个对象 + 偶尔裁剪。
 *   - 读取路径按时间窗聚合，O(n)，n 被 24h 裁剪 + 上限封住。
 */

export interface BuildActivityEvent {
  projectId: string;
  branchId: string;
  at: number;
  trigger: string;
}

export interface BuildActivitySummary {
  recentBuilds1h: number;
  recentBuilds24h: number;
  lastBuildAt: number | null;
}

const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
const WINDOW_1H_MS = 60 * 60 * 1000;
/** ring buffer 上限：单实例几十个项目、最坏每分钟几十次构建，5000 足够覆盖 24h。 */
const RING_MAX = 5000;

let ring: BuildActivityEvent[] = [];

function prune(nowMs: number): void {
  const cutoff = nowMs - WINDOW_24H_MS;
  // 先按时间窗裁掉过期事件
  if (ring.length && ring[0].at < cutoff) {
    let firstFresh = 0;
    while (firstFresh < ring.length && ring[firstFresh].at < cutoff) firstFresh++;
    if (firstFresh > 0) ring = ring.slice(firstFresh);
  }
  // 再按硬上限裁掉最旧的（防御性，正常不会触发）
  if (ring.length > RING_MAX) ring = ring.slice(ring.length - RING_MAX);
}

/** 记录一次构建/部署发生（deploy 端点在通过全部前置校验后调用）。 */
export function recordBuild(projectId: string, branchId: string, trigger = 'unknown'): void {
  const at = Date.now();
  ring.push({ projectId: projectId || 'default', branchId, at, trigger });
  prune(at);
}

/** 单项目在 sinceMs 之后的构建次数。 */
export function countBuildsSince(projectId: string, sinceMs: number): number {
  let count = 0;
  for (const ev of ring) {
    if (ev.projectId === projectId && ev.at >= sinceMs) count++;
  }
  return count;
}

/** 聚合所有项目的近 1h / 24h 构建次数 + 最近一次构建时间。 */
export function summarizeBuildActivity(nowMs = Date.now()): Map<string, BuildActivitySummary> {
  const since1h = nowMs - WINDOW_1H_MS;
  const since24h = nowMs - WINDOW_24H_MS;
  const out = new Map<string, BuildActivitySummary>();
  for (const ev of ring) {
    if (ev.at < since24h) continue;
    let entry = out.get(ev.projectId);
    if (!entry) {
      entry = { recentBuilds1h: 0, recentBuilds24h: 0, lastBuildAt: null };
      out.set(ev.projectId, entry);
    }
    entry.recentBuilds24h++;
    if (ev.at >= since1h) entry.recentBuilds1h++;
    if (entry.lastBuildAt === null || ev.at > entry.lastBuildAt) entry.lastBuildAt = ev.at;
  }
  return out;
}

/** 测试隔离用：清空 ring。 */
export function __resetBuildActivityForTests(): void {
  ring = [];
}
