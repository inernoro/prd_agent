/**
 * 按需 CPU 采样（2026-10-08 CDS 卡顿复盘，药方第 1 步）。
 *
 * 主线程诊断里的分段计时只能回答「已埋点的那几处花了多少」；卡顿记录里「未标注」
 * 占比高时，热点在埋点之外，需要一份真实的 CPU profile 才能定案。这里在进程内用
 * inspector 采样指定秒数，返回两种形态：
 *   - summary：按函数聚合的自身耗时排行（不用任何工具就能读）；
 *   - cpuprofile：原始 profile，可直接拖进 Chrome DevTools 的 Performance 面板。
 *
 * 同一时刻只允许一次采样；采样本身会给主线程增加少量开销（1ms 采样间隔），
 * 所以只在需要定案时由运维手动触发，不常驻。
 */
import { Session } from 'node:inspector/promises';

export const CPU_PROFILE_MIN_SECONDS = 5;
/** nginx 默认 proxy_read_timeout 为 60s，留出余量。 */
export const CPU_PROFILE_MAX_SECONDS = 50;
export const CPU_PROFILE_DEFAULT_SECONDS = 30;
const SAMPLING_INTERVAL_US = 1000;

export interface CpuProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber?: number;
  };
  children?: number[];
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

export interface CpuProfileSummaryRow {
  functionName: string;
  location: string;
  selfMs: number;
  selfPercent: number;
}

export interface CpuProfileSummary {
  durationMs: number;
  sampleCount: number;
  /** V8 特殊节点：(idle) 空闲、(program) 原生代码、(garbage collector) GC。 */
  idleMs: number;
  programMs: number;
  gcMs: number;
  /** 非空闲时间里 JS 自身耗时的排行。 */
  top: CpuProfileSummaryRow[];
}

export function clampProfileSeconds(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return CPU_PROFILE_DEFAULT_SECONDS;
  return Math.min(CPU_PROFILE_MAX_SECONDS, Math.max(CPU_PROFILE_MIN_SECONDS, Math.round(n)));
}

function shortLocation(url: string, line: number): string {
  if (!url) return '(native)';
  const trimmed = url.replace(/^file:\/\//, '');
  const marker = trimmed.lastIndexOf('/dist/');
  const nodeModules = trimmed.lastIndexOf('/node_modules/');
  const base = marker >= 0 ? trimmed.slice(marker + 1) : nodeModules >= 0 ? trimmed.slice(nodeModules + 1) : trimmed;
  return `${base}:${line + 1}`;
}

/**
 * 按「函数名 + 位置」聚合每个采样点的自身耗时。timeDeltas[i] 是第 i 个采样与上一个
 * 采样之间的微秒数，归给第 i 个采样命中的节点。
 */
export function summarizeCpuProfile(profile: CpuProfile, topN = 30): CpuProfileSummary {
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  const nodeById = new Map<number, CpuProfileNode>();
  for (const node of profile.nodes || []) nodeById.set(node.id, node);
  const selfUs = new Map<number, number>();
  for (let i = 0; i < samples.length; i += 1) {
    const delta = Math.max(0, deltas[i] ?? 0);
    selfUs.set(samples[i], (selfUs.get(samples[i]) ?? 0) + delta);
  }
  let idleUs = 0;
  let programUs = 0;
  let gcUs = 0;
  let busyUs = 0;
  const byFunction = new Map<string, { functionName: string; location: string; us: number }>();
  for (const [nodeId, us] of selfUs) {
    const node = nodeById.get(nodeId);
    const name = node?.callFrame.functionName || '(anonymous)';
    if (name === '(idle)') { idleUs += us; continue; }
    busyUs += us;
    if (name === '(program)') { programUs += us; continue; }
    if (name === '(garbage collector)') { gcUs += us; continue; }
    const location = shortLocation(node?.callFrame.url || '', node?.callFrame.lineNumber ?? 0);
    const key = `${name}@${location}`;
    const row = byFunction.get(key) ?? { functionName: name, location, us: 0 };
    row.us += us;
    byFunction.set(key, row);
  }
  const busy = Math.max(1, busyUs);
  const top = [...byFunction.values()]
    .sort((a, b) => b.us - a.us)
    .slice(0, topN)
    .map((row) => ({
      functionName: row.functionName,
      location: row.location,
      selfMs: Math.round(row.us / 100) / 10,
      selfPercent: Math.round((row.us / busy) * 1000) / 10,
    }));
  return {
    durationMs: Math.round(Math.max(0, profile.endTime - profile.startTime) / 1000),
    sampleCount: samples.length,
    idleMs: Math.round(idleUs / 1000),
    programMs: Math.round(programUs / 1000),
    gcMs: Math.round(gcUs / 1000),
    top,
  };
}

let inFlight = false;

export function isCpuProfileInFlight(): boolean {
  return inFlight;
}

export class CpuProfileBusyError extends Error {
  constructor() {
    super('已有一次 CPU 采样正在进行，请等它结束后再试');
    this.name = 'CpuProfileBusyError';
  }
}

/** 在本进程内采样 seconds 秒。并发调用直接拒绝，不排队。 */
export async function captureCpuProfile(seconds: number): Promise<CpuProfile> {
  if (inFlight) throw new CpuProfileBusyError();
  inFlight = true;
  const session = new Session();
  try {
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
    await session.post('Profiler.start');
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const { profile } = await session.post('Profiler.stop') as { profile: CpuProfile };
    return profile;
  } finally {
    try { await session.post('Profiler.disable'); } catch { /* session may already be gone */ }
    try { session.disconnect(); } catch { /* noop */ }
    inFlight = false;
  }
}
