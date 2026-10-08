/**
 * 主线程诊断（2026-10-08 CDS 卡顿复盘，药方第 1 步「先量后治」）。
 *
 * 背景：控制面事件循环 p99 从 09-09 起一直没达标（876 → 380 → 2894ms），而且卡顿
 * 不跟着宿主负载走（09-15 load5=71 时 380ms，10-08 load≈25 时 2.9s），指向 master
 * 主线程内部的同步大块工作。但历次优化都没有「一分钟里主线程有多少秒在干什么」这个数，
 * 只能看到「高负载」就猜一处改一处。本模块只做观测，不改任何行为：
 *
 *   1. 分段计时：已知会整份重做的同步工作（状态快照克隆、逐实体序列化、分支列表计算、
 *      SSE 快照与推送、探活历史落盘、同步 git）各自报一次耗时，按 60s 窗口聚合。
 *   2. 卡顿归因：50ms 一跳的自检计时器发现「这一跳迟到了 ≥200ms」就记一条卡顿，并把
 *      卡顿窗口内结束的分段与 GC 挂到这条记录上；对不上的部分记为「未标注」——
 *      未标注占比高，说明热点不在已埋点的位置，该去抓 CPU profile。
 *   3. GC：每次 GC 的类型与暂停时长。
 *   4. SSE：当前长连接数（按端点 × 来源 × 是否限定项目），以及每窗口写出的字节与次数。
 *      预览页挂件（带 x-cds-source-* 头）单独计数，它会随业务方打开的预览页数量增长。
 *
 * 只读、常驻、开销可忽略：一个 50ms 的 unref 计时器 + 每个埋点一次 Map 更新。
 */
import { PerformanceObserver, constants as perfConstants, performance } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAIN_THREAD_WINDOW_MS = 60_000;
export const STALL_TICK_MS = 50;
/** 一跳迟到达到这个数才算一次卡顿。与 control-plane-pressure 的 200ms 告警线同口径。 */
export const STALL_THRESHOLD_MS = 200;
const RECENT_LIMIT = 256;
const STALL_LIMIT = 50;

export interface SectionStat {
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
  /** 埋点能给出产物大小时的累计字节（例如序列化出的 JSON 长度），给不出为 0。 */
  bytes: number;
}

export interface GcStat {
  count: number;
  totalMs: number;
  maxMs: number;
  byKind: Record<string, { count: number; totalMs: number; maxMs: number }>;
}

export interface SseTraffic {
  writes: number;
  bytes: number;
}

export interface WindowSnapshot {
  startedAt: string;
  durationMs: number;
  sections: SectionStat[];
  gc: GcStat;
  sse: Record<string, SseTraffic>;
}

export interface StallPart {
  name: string;
  ms: number;
}

export interface StallRecord {
  at: string;
  ms: number;
  /** 卡顿窗口内结束的已知分段与 GC，按耗时降序。 */
  parts: StallPart[];
  /** ms 减去已归因部分；高说明热点在埋点之外。 */
  unattributedMs: number;
}

export interface MainThreadSnapshot {
  current: WindowSnapshot;
  previous: WindowSnapshot | null;
  stalls: StallRecord[];
  sseOpen: Record<string, number>;
}

interface MutableWindow {
  startedAtMs: number;
  startedAtWall: number;
  sections: Map<string, SectionStat>;
  gc: GcStat;
  sse: Map<string, SseTraffic>;
}

interface RecentEntry {
  name: string;
  endAt: number;
  ms: number;
}

interface PendingStall extends StallRecord {
  fromPerf: number;
  toPerf: number;
}

export interface MainThreadDiagnosticsClock {
  /** 单调时钟，毫秒（performance.now 口径）。 */
  now(): number;
  /** 墙钟，毫秒（Date.now 口径），只用于展示时间。 */
  wallNow(): number;
}

const defaultClock: MainThreadDiagnosticsClock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
};

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function emptyGc(): GcStat {
  return { count: 0, totalMs: 0, maxMs: 0, byKind: {} };
}

/**
 * 可注入时钟的诊断器。生产用模块级单例（见文末），测试直接 new 一个并手动推进时钟。
 */
export class MainThreadDiagnostics {
  private readonly clock: MainThreadDiagnosticsClock;
  private current: MutableWindow;
  private previous: WindowSnapshot | null = null;
  private readonly recent: RecentEntry[] = [];
  private readonly stalls: PendingStall[] = [];
  private readonly sseOpen = new Map<string, number>();
  private lastTick: number;

  constructor(clock: MainThreadDiagnosticsClock = defaultClock) {
    this.clock = clock;
    this.current = this.newWindow();
    this.lastTick = clock.now();
  }

  private newWindow(): MutableWindow {
    return {
      startedAtMs: this.clock.now(),
      startedAtWall: this.clock.wallNow(),
      sections: new Map(),
      gc: emptyGc(),
      sse: new Map(),
    };
  }

  private freeze(win: MutableWindow, endMs: number): WindowSnapshot {
    const gc: GcStat = {
      count: win.gc.count,
      totalMs: round(win.gc.totalMs),
      maxMs: round(win.gc.maxMs),
      byKind: Object.fromEntries(Object.entries(win.gc.byKind).map(([kind, stat]) => [kind, {
        count: stat.count,
        totalMs: round(stat.totalMs),
        maxMs: round(stat.maxMs),
      }])),
    };
    return {
      startedAt: new Date(win.startedAtWall).toISOString(),
      durationMs: Math.max(0, Math.round(endMs - win.startedAtMs)),
      sections: [...win.sections.values()]
        .map((s) => ({ ...s, totalMs: round(s.totalMs), maxMs: round(s.maxMs) }))
        .sort((a, b) => b.totalMs - a.totalMs),
      gc,
      sse: Object.fromEntries([...win.sse.entries()].map(([k, v]) => [k, { ...v }])),
    };
  }

  private rotateIfDue(now: number): void {
    if (now - this.current.startedAtMs < MAIN_THREAD_WINDOW_MS) return;
    this.previous = this.freeze(this.current, now);
    this.current = this.newWindow();
  }

  private pushRecent(entry: RecentEntry): void {
    this.recent.push(entry);
    if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT);
  }

  /** 已知同步工作报一次耗时。ms 为这段同步代码自己的耗时，不含 await。 */
  recordSection(name: string, ms: number, bytes = 0): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const now = this.clock.now();
    this.rotateIfDue(now);
    const stat = this.current.sections.get(name) ?? { name, count: 0, totalMs: 0, maxMs: 0, bytes: 0 };
    stat.count += 1;
    stat.totalMs += ms;
    stat.maxMs = Math.max(stat.maxMs, ms);
    if (Number.isFinite(bytes) && bytes > 0) stat.bytes += bytes;
    this.current.sections.set(name, stat);
    this.pushRecent({ name, endAt: now, ms });
  }

  /** 包一段同步代码计时；bytesOf 可从返回值算出产物大小。 */
  time<T>(name: string, fn: () => T, bytesOf?: (result: T) => number): T {
    const startedAt = this.clock.now();
    const result = fn();
    const ms = this.clock.now() - startedAt;
    let bytes = 0;
    if (bytesOf) {
      try { bytes = bytesOf(result); } catch { bytes = 0; }
    }
    this.recordSection(name, ms, bytes);
    return result;
  }

  /**
   * GC 条目由 PerformanceObserver 在卡顿之后才异步送达，所以除了累计，还要回头
   * 把它补挂到时间上重叠的卡顿记录里。
   */
  recordGc(kind: string, startTime: number, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const now = this.clock.now();
    this.rotateIfDue(now);
    const gc = this.current.gc;
    gc.count += 1;
    gc.totalMs += durationMs;
    gc.maxMs = Math.max(gc.maxMs, durationMs);
    const byKind = gc.byKind[kind] ?? { count: 0, totalMs: 0, maxMs: 0 };
    byKind.count += 1;
    byKind.totalMs += durationMs;
    byKind.maxMs = Math.max(byKind.maxMs, durationMs);
    gc.byKind[kind] = byKind;
    const name = `gc.${kind}`;
    const endAt = startTime + durationMs;
    this.pushRecent({ name, endAt, ms: durationMs });
    for (let i = this.stalls.length - 1; i >= 0 && i >= this.stalls.length - 5; i -= 1) {
      const stall = this.stalls[i];
      if (endAt > stall.fromPerf && startTime < stall.toPerf) {
        this.attach(stall, { name, ms: durationMs });
        break;
      }
    }
  }

  private attach(stall: PendingStall, part: StallPart): void {
    stall.parts.push({ name: part.name, ms: round(part.ms) });
    stall.parts.sort((a, b) => b.ms - a.ms);
    const attributed = stall.parts.reduce((sum, p) => sum + p.ms, 0);
    stall.unattributedMs = round(Math.max(0, stall.ms - attributed));
  }

  /**
   * 自检计时器每一跳调用一次。本跳与上一跳的间隔超出计划间隔 STALL_THRESHOLD_MS
   * 以上，即视为主线程在这段时间里被一段同步工作（或 GC）独占。
   */
  tick(): void {
    const now = this.clock.now();
    const lag = now - this.lastTick - STALL_TICK_MS;
    if (lag >= STALL_THRESHOLD_MS) {
      const stall: PendingStall = {
        at: new Date(this.clock.wallNow()).toISOString(),
        ms: round(lag),
        parts: [],
        unattributedMs: round(lag),
        fromPerf: this.lastTick,
        toPerf: now,
      };
      for (const entry of this.recent) {
        if (entry.endAt > this.lastTick && entry.endAt <= now) this.attach(stall, entry);
      }
      this.stalls.push(stall);
      if (this.stalls.length > STALL_LIMIT) this.stalls.splice(0, this.stalls.length - STALL_LIMIT);
    }
    this.lastTick = now;
    this.rotateIfDue(now);
  }

  sseOpened(kind: string): void {
    this.sseOpen.set(kind, (this.sseOpen.get(kind) ?? 0) + 1);
  }

  sseClosed(kind: string): void {
    const next = (this.sseOpen.get(kind) ?? 0) - 1;
    if (next > 0) this.sseOpen.set(kind, next);
    else this.sseOpen.delete(kind);
  }

  sseWrote(kind: string, bytes: number): void {
    const now = this.clock.now();
    this.rotateIfDue(now);
    const traffic = this.current.sse.get(kind) ?? { writes: 0, bytes: 0 };
    traffic.writes += 1;
    traffic.bytes += Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    this.current.sse.set(kind, traffic);
  }

  snapshot(): MainThreadSnapshot {
    const now = this.clock.now();
    this.rotateIfDue(now);
    return {
      current: this.freeze(this.current, now),
      previous: this.previous,
      stalls: this.stalls
        .slice()
        .reverse()
        .map(({ at, ms, parts, unattributedMs }) => ({ at, ms, parts: parts.slice(), unattributedMs })),
      sseOpen: Object.fromEntries(this.sseOpen.entries()),
    };
  }
}

// ── 生产单例 ──────────────────────────────────────────────────────────────

const singleton = new MainThreadDiagnostics();
let tickTimer: ReturnType<typeof setInterval> | null = null;
let gcObserver: PerformanceObserver | null = null;

const GC_KIND_NAMES: Record<number, string> = {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};

export function gcKindName(kind: unknown): string {
  return typeof kind === 'number' ? (GC_KIND_NAMES[kind] ?? `kind-${kind}`) : 'unknown';
}

export function startMainThreadDiagnostics(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => singleton.tick(), STALL_TICK_MS);
  tickTimer.unref?.();
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const detail = (entry as unknown as { detail?: { kind?: number } }).detail;
        singleton.recordGc(gcKindName(detail?.kind), entry.startTime, entry.duration);
      }
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch {
    // 运行时不支持 gc 条目时只少一项数据，不影响其他观测。
    gcObserver = null;
  }
}

export function stopMainThreadDiagnostics(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  gcObserver?.disconnect();
  gcObserver = null;
}

export function recordMainThreadSection(name: string, ms: number, bytes = 0): void {
  singleton.recordSection(name, ms, bytes);
}

export function timeMainThreadSection<T>(name: string, fn: () => T, bytesOf?: (result: T) => number): T {
  return singleton.time(name, fn, bytesOf);
}

export function getMainThreadDiagnostics(): MainThreadSnapshot {
  return singleton.snapshot();
}

// ── SSE 连接计数 ──────────────────────────────────────────────────────────

/**
 * 把 SSE 请求归成一个稳定的类别键：`<端点>|<来源>|<范围>`。
 * - 端点：去掉 /api 或 /_cds/api 前缀，把看起来像 id 的段换成 :id；
 * - 来源：带 x-cds-source-* 头的是预览页挂件（widget），其余是控制台（dashboard）；
 * - 范围：带 ?project= 的是 project，否则 all（会收到全平台所有分支的事件）。
 */
export function classifySseRequest(req: Pick<IncomingMessage, 'headers' | 'url'>): string {
  const rawUrl = req.url || '/';
  const qIndex = rawUrl.indexOf('?');
  const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
  const query = qIndex >= 0 ? new URLSearchParams(rawUrl.slice(qIndex + 1)) : new URLSearchParams();
  const endpoint = pathname
    .replace(/^\/_cds/, '')
    .replace(/^\/api/, '')
    .split('/')
    .map((seg) => (/^[0-9a-f]{8,}$/i.test(seg) || /^\d+$/.test(seg) || /^(run|op|rel|dr)[_-]/i.test(seg) || seg.length > 40 ? ':id' : seg))
    .join('/') || '/';
  const headers = req.headers || {};
  const widget = Boolean(headers['x-cds-source-host'] || headers['x-cds-source-project-id'] || headers['x-cds-source-branch-id']);
  const scope = query.get('project') ? 'project' : 'all';
  return `${endpoint}|${widget ? 'widget' : 'dashboard'}|${scope}`;
}

function isEventStream(contentType: unknown): boolean {
  if (Array.isArray(contentType)) return contentType.some(isEventStream);
  return typeof contentType === 'string' && contentType.toLowerCase().includes('text/event-stream');
}

function headerFromWriteHeadArgs(args: unknown[]): unknown {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') continue;
    if (Array.isArray(arg)) {
      for (let i = 0; i + 1 < arg.length; i += 2) {
        if (String(arg[i]).toLowerCase() === 'content-type') return arg[i + 1];
      }
      continue;
    }
    for (const [key, value] of Object.entries(arg as Record<string, unknown>)) {
      if (key.toLowerCase() === 'content-type') return value;
    }
  }
  return undefined;
}

/**
 * 给一次响应挂上 SSE 计数：响应头声明 text/event-stream 时登记一条连接，之后每次
 * write 计字节，连接关闭时注销。不是 SSE 的响应只多两个闭包，不计任何东西。
 * diagnostics 可注入，测试不用碰生产单例。
 */
export function trackSseResponse(
  req: Pick<IncomingMessage, 'headers' | 'url' | 'method'>,
  res: ServerResponse,
  diagnostics: MainThreadDiagnostics = singleton,
): void {
  if (req.method && req.method.toUpperCase() !== 'GET') return;
  let kind: string | null = null;
  const register = (contentType: unknown) => {
    if (kind || !isEventStream(contentType)) return;
    kind = classifySseRequest(req);
    diagnostics.sseOpened(kind);
    res.once('close', () => {
      if (kind) diagnostics.sseClosed(kind);
    });
  };
  const originalWriteHead = res.writeHead;
  res.writeHead = function patchedWriteHead(this: ServerResponse, ...args: unknown[]) {
    register(headerFromWriteHeadArgs(args) ?? res.getHeader('content-type'));
    return (originalWriteHead as (...a: unknown[]) => ServerResponse).apply(this, args);
  } as ServerResponse['writeHead'];
  const originalWrite = res.write;
  res.write = function patchedWrite(this: ServerResponse, ...args: unknown[]) {
    if (!kind) register(res.getHeader('content-type'));
    if (kind) {
      const chunk = args[0];
      const bytes = typeof chunk === 'string' ? chunk.length : (chunk && typeof (chunk as { length?: number }).length === 'number' ? (chunk as { length: number }).length : 0);
      diagnostics.sseWrote(kind, bytes);
    }
    return (originalWrite as (...a: unknown[]) => boolean).apply(this, args);
  } as ServerResponse['write'];
}

/** Express 中间件形态：挂在所有路由之前，一处覆盖全部 SSE 端点。 */
export function sseConnectionTrackerMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  trackSseResponse(req, res);
  next();
}
