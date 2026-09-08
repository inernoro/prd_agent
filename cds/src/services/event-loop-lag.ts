/**
 * 事件循环延迟观测（2026-09-08 宿主过载复盘）。
 *
 * master 是单事件循环：docker 命令排队、同步 git diff、Mongo 批量写都会让
 * 所有 HTTP / SSE / 代理一起变慢，而 HTTP 日志只记「跑完的请求」，卡住的那
 * 几十秒在日志里是盲区。这里用 perf_hooks 的直方图持续采样事件循环延迟，
 * healthz / perf-health 直接读 p50 / p99 / max，让「master 自己有没有被饿」
 * 变成一个能读到的数。
 *
 * 窗口：每 60s 归零一次，读到的是「最近一分钟」的分布（上一窗口也保留，避免
 * 刚归零时读到全 0）。
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

export interface EventLoopLagSnapshot {
  /** 采样是否已启动 */
  enabled: boolean;
  /** 当前窗口起点 */
  windowStartedAt: string | null;
  current: { p50Ms: number; p99Ms: number; maxMs: number; samples: number };
  previous: { p50Ms: number; p99Ms: number; maxMs: number; samples: number } | null;
}

const WINDOW_MS = 60_000;

let histogram: IntervalHistogram | null = null;
let windowStartedAt: number | null = null;
let previous: EventLoopLagSnapshot['previous'] = null;
let rotateTimer: ReturnType<typeof setInterval> | null = null;

function toMs(ns: number): number {
  return Number.isFinite(ns) && ns > 0 ? Number((ns / 1e6).toFixed(1)) : 0;
}

function summarize(h: IntervalHistogram): EventLoopLagSnapshot['current'] {
  return {
    p50Ms: toMs(h.percentile(50)),
    p99Ms: toMs(h.percentile(99)),
    maxMs: toMs(h.max),
    samples: h.count,
  };
}

export function startEventLoopLagMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  windowStartedAt = Date.now();
  rotateTimer = setInterval(() => {
    if (!histogram) return;
    previous = summarize(histogram);
    histogram.reset();
    windowStartedAt = Date.now();
  }, WINDOW_MS);
  rotateTimer.unref?.();
}

export function stopEventLoopLagMonitor(): void {
  if (rotateTimer) {
    clearInterval(rotateTimer);
    rotateTimer = null;
  }
  histogram?.disable();
  histogram = null;
  windowStartedAt = null;
  previous = null;
}

export function getEventLoopLag(): EventLoopLagSnapshot {
  if (!histogram) {
    return {
      enabled: false,
      windowStartedAt: null,
      current: { p50Ms: 0, p99Ms: 0, maxMs: 0, samples: 0 },
      previous: null,
    };
  }
  return {
    enabled: true,
    windowStartedAt: windowStartedAt === null ? null : new Date(windowStartedAt).toISOString(),
    current: summarize(histogram),
    previous,
  };
}
