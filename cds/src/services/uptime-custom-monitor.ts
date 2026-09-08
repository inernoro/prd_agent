/**
 * uptime-custom-monitor — 监控中心「自定义探测目标」的校验、派生与探测实现。
 *
 * 分支预览服务与生产发布目标都是**系统替你盯**：目标从台账推导，用户不用填。
 * 这一类相反，是**你让系统盯**：第三方依赖、上游网关、还没接进 CDS 的旧服务。
 * 所以它有三件前两类没有的事——
 *
 *   1. 输入要校验（地址合法、端口范围、间隔上下限），且按最小输入原则派生
 *      能派生的字段（名称留空取主机名，状态码规则缺省 200-399）；
 *   2. 探测方式由用户选（HTTP 状态码 / 关键字 / TCP 端口），不是「打根路径看 < 500」；
 *   3. 可以手动暂停、可以改间隔与超时——但间隔只能比全局慢，不能更快：
 *      探测轮次仍由 uptime-monitor 的单一定时器驱动，这里只在轮次里判「到没到点」。
 *
 * 纯函数（校验 / 派生 / 状态码规则 / 目标推导）与副作用（真的发探测）分开放，
 * 前者全部有单测，后者只在轮次里被调用。
 */

import net from 'node:net';
import type { UptimeCustomMonitor, UptimeCustomMonitorKind } from '../types.js';
import type { UptimeSample } from './uptime-metrics.js';
import { probeRequestHeaders } from './probe-marker.js';

/**
 * 探测记录的命名空间前缀。与 release-probe-target 的 `release@` 同理：分支键
 * 必含 `::`、分支 id 不含 `@`，三类键在结构上永不相撞。
 */
export const CUSTOM_PROBE_ID_PREFIX = 'monitor@';

export function customProbeTargetId(monitor: Pick<UptimeCustomMonitor, 'id'>): string {
  return `${CUSTOM_PROBE_ID_PREFIX}${monitor.id}`;
}

export const DEFAULT_EXPECTED_STATUS = '200-399';
/** 自定义间隔的上下限（秒）。下限再小也没意义——轮次本身按全局间隔跑。 */
export const MIN_MONITOR_INTERVAL_SECONDS = 20;
export const MAX_MONITOR_INTERVAL_SECONDS = 24 * 3600;
export const MIN_MONITOR_TIMEOUT_MS = 1_000;
export const MAX_MONITOR_TIMEOUT_MS = 60_000;
/** 关键字探测最多读多少响应体：够找关键字，又不会被一个无限流吃光内存。 */
const KEYWORD_BODY_LIMIT_BYTES = 512 * 1024;
const MAX_NAME_LENGTH = 80;
const MAX_TAGS = 10;

export const MONITOR_KINDS: ReadonlyArray<UptimeCustomMonitorKind> = ['http', 'keyword', 'tcp'];

/** 用户可提交的原始输入（全部可选，由 normalize 决定哪些必填）。 */
export interface UptimeMonitorInput {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  url?: unknown;
  method?: unknown;
  expectedStatus?: unknown;
  keyword?: unknown;
  host?: unknown;
  port?: unknown;
  intervalSeconds?: unknown;
  timeoutMs?: unknown;
  projectId?: unknown;
  tags?: unknown;
  enabled?: unknown;
}

export type NormalizeResult =
  | { ok: true; monitor: UptimeCustomMonitor }
  | { ok: false; error: string; field?: string };

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : Number.NaN;
}

/**
 * 解析状态码规则：`200-299,301,404`。返回 null 表示写法不合法。
 * 每段要么是单个 100-599 的码，要么是 `a-b` 区间（a ≤ b）。
 */
export function parseStatusSpec(spec: string | undefined | null): Array<[number, number]> | null {
  const raw = (spec || '').trim() || DEFAULT_EXPECTED_STATUS;
  const ranges: Array<[number, number]> = [];
  for (const piece of raw.split(/[,，\s]+/).filter(Boolean)) {
    const m = /^(\d{3})(?:-(\d{3}))?$/.exec(piece);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    if (lo < 100 || hi > 599 || lo > hi) return null;
    ranges.push([lo, hi]);
  }
  return ranges.length > 0 ? ranges : null;
}

export function statusMatches(code: number, spec: string | undefined | null): boolean {
  const ranges = parseStatusSpec(spec);
  if (!ranges) return false;
  return ranges.some(([lo, hi]) => code >= lo && code <= hi);
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 名称留空时的派生规则：http/keyword 取主机名（带非默认端口），tcp 取 host:port。 */
export function deriveMonitorName(input: {
  kind: UptimeCustomMonitorKind;
  url?: string;
  host?: string;
  port?: number;
}): string {
  if (input.kind === 'tcp') {
    return input.host && input.port ? `${input.host}:${input.port}` : (input.host || '');
  }
  const parsed = input.url ? parseHttpUrl(input.url) : null;
  if (!parsed) return '';
  return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
}

function newMonitorId(): string {
  return `mon-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把用户输入收敛成可落库的监控定义。返回的 error 是给人看的中文，field 指明
 * 哪个输入框该标红。
 */
export function normalizeUptimeMonitorInput(
  input: UptimeMonitorInput,
  options: { existing?: UptimeCustomMonitor; now?: () => number } = {},
): NormalizeResult {
  const kind = str(input.kind || options.existing?.kind) as UptimeCustomMonitorKind;
  if (!MONITOR_KINDS.includes(kind)) {
    return { ok: false, error: '探测方式必须是 http（状态码）、keyword（关键字）或 tcp（端口）之一', field: 'kind' };
  }

  const monitor: UptimeCustomMonitor = {
    id: str(input.id) || options.existing?.id || newMonitorId(),
    name: '',
    kind,
    enabled: input.enabled === undefined ? (options.existing?.enabled ?? true) : Boolean(input.enabled),
    createdAt: options.existing?.createdAt || new Date(options.now ? options.now() : Date.now()).toISOString(),
    updatedAt: new Date(options.now ? options.now() : Date.now()).toISOString(),
  };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(monitor.id)) {
    return { ok: false, error: '监控 id 只能包含字母、数字、下划线与连字符，且不超过 64 位', field: 'id' };
  }

  if (kind === 'tcp') {
    const host = str(input.host) || options.existing?.host || '';
    const port = input.port === undefined ? options.existing?.port : optionalInt(input.port);
    if (!host) return { ok: false, error: 'TCP 探测必须填写主机名或 IP', field: 'host' };
    if (/[\s/]/.test(host)) return { ok: false, error: '主机名不能包含空格或斜杠', field: 'host' };
    if (port === undefined || Number.isNaN(port) || port < 1 || port > 65535) {
      return { ok: false, error: '端口必须是 1-65535 之间的整数', field: 'port' };
    }
    monitor.host = host;
    monitor.port = port;
  } else {
    const url = str(input.url) || options.existing?.url || '';
    if (!url) return { ok: false, error: '请填写要探测的地址（http:// 或 https:// 开头）', field: 'url' };
    if (!parseHttpUrl(url)) return { ok: false, error: '地址必须是合法的 http:// 或 https:// 网址', field: 'url' };
    monitor.url = url;
    const method = str(input.method).toUpperCase() || options.existing?.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      return { ok: false, error: '请求方法只支持 GET 或 HEAD', field: 'method' };
    }
    // 关键字要读响应体，HEAD 没有响应体——写了也是永远失败，直接拒掉。
    if (kind === 'keyword' && method === 'HEAD') {
      return { ok: false, error: '关键字探测需要读取响应体，请求方法只能用 GET', field: 'method' };
    }
    monitor.method = method;
    // 状态码规则三种输入：没传 = 沿用旧值；传 null = 清掉自定义、回到默认；传字符串 = 用它。
    // 编辑弹窗把清空的输入框发成 null——发成「不传」的话永远改不回默认（Codex PR #1514 P2）。
    const expectedStatus = input.expectedStatus === null
      ? DEFAULT_EXPECTED_STATUS
      : (str(input.expectedStatus) || options.existing?.expectedStatus || DEFAULT_EXPECTED_STATUS);
    if (!parseStatusSpec(expectedStatus)) {
      return { ok: false, error: '状态码规则写法不合法，示例：200-299 或 200-399,401', field: 'expectedStatus' };
    }
    monitor.expectedStatus = expectedStatus;
    if (kind === 'keyword') {
      const keyword = typeof input.keyword === 'string' ? input.keyword : (options.existing?.keyword || '');
      if (!keyword.trim()) return { ok: false, error: '关键字探测必须填写要匹配的文本', field: 'keyword' };
      if (keyword.length > 200) return { ok: false, error: '关键字不能超过 200 个字符', field: 'keyword' };
      monitor.keyword = keyword;
    }
  }

  // 名称：显式传了就用（传空串 = 要求重新派生）；没传则沿用旧名；都没有才派生。
  const name = (input.name === undefined ? (options.existing?.name || '') : str(input.name)).slice(0, MAX_NAME_LENGTH);
  monitor.name = name || deriveMonitorName(monitor);
  if (!monitor.name) return { ok: false, error: '请填写监控名称', field: 'name' };

  // 间隔 / 超时同上：null = 回到全局默认（optionalInt 把 null 收成 undefined，而下面的
  // 「沿用旧值」分支只认真正没传的 undefined）。
  const interval = optionalInt(input.intervalSeconds);
  if (interval !== undefined) {
    if (Number.isNaN(interval) || interval < MIN_MONITOR_INTERVAL_SECONDS || interval > MAX_MONITOR_INTERVAL_SECONDS) {
      return {
        ok: false,
        error: `探测间隔必须在 ${MIN_MONITOR_INTERVAL_SECONDS}-${MAX_MONITOR_INTERVAL_SECONDS} 秒之间`,
        field: 'intervalSeconds',
      };
    }
    monitor.intervalSeconds = interval;
  } else if (options.existing?.intervalSeconds && input.intervalSeconds === undefined) {
    monitor.intervalSeconds = options.existing.intervalSeconds;
  }

  const timeout = optionalInt(input.timeoutMs);
  if (timeout !== undefined) {
    if (Number.isNaN(timeout) || timeout < MIN_MONITOR_TIMEOUT_MS || timeout > MAX_MONITOR_TIMEOUT_MS) {
      return {
        ok: false,
        error: `超时必须在 ${MIN_MONITOR_TIMEOUT_MS}-${MAX_MONITOR_TIMEOUT_MS} 毫秒之间`,
        field: 'timeoutMs',
      };
    }
    monitor.timeoutMs = timeout;
  } else if (options.existing?.timeoutMs && input.timeoutMs === undefined) {
    monitor.timeoutMs = options.existing.timeoutMs;
  }

  const projectId = input.projectId === undefined ? (options.existing?.projectId ?? null) : (str(input.projectId) || null);
  monitor.projectId = projectId;

  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) return { ok: false, error: '标签必须是字符串数组', field: 'tags' };
    const tags = [...new Set(input.tags.map((t) => str(t)).filter(Boolean))].slice(0, MAX_TAGS);
    monitor.tags = tags;
  } else if (options.existing?.tags) {
    monitor.tags = options.existing.tags;
  }
  if (options.existing?.createdBy) monitor.createdBy = options.existing.createdBy;

  return { ok: true, monitor };
}

/** 一句人话描述探测方式，列表与详情页直接展示。 */
export function describeMonitorProbe(monitor: Pick<UptimeCustomMonitor, 'kind' | 'url' | 'method' | 'expectedStatus' | 'keyword' | 'host' | 'port'>): string {
  if (monitor.kind === 'tcp') return `TCP 连接 ${monitor.host}:${monitor.port}`;
  const method = monitor.method || 'GET';
  const status = monitor.expectedStatus || DEFAULT_EXPECTED_STATUS;
  if (monitor.kind === 'keyword') return `${method} ${monitor.url} · 状态 ${status} 且响应含「${monitor.keyword}」`;
  return `${method} ${monitor.url} · 状态 ${status}`;
}

// ── 探测实现（副作用） ──

export type CustomProbeOutcome = Omit<UptimeSample, 't'>;

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<CustomProbeOutcome> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CustomProbeOutcome): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ up: true, ms: Date.now() - startedAt }));
    socket.once('timeout', () => finish({ up: false, ms: Date.now() - startedAt, err: `连接超时（${timeoutMs}ms）` }));
    socket.once('error', (err) => finish({ up: false, ms: Date.now() - startedAt, err: (err as Error).message }));
  });
}

async function readBodyPrefix(res: Response, limitBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  try {
    while (received < limitBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

async function httpProbe(
  monitor: Pick<UptimeCustomMonitor, 'kind' | 'url' | 'method' | 'expectedStatus' | 'keyword'>,
  timeoutMs: number,
): Promise<CustomProbeOutcome> {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(monitor.url || '', {
      method: monitor.method || 'GET',
      signal: ctrl.signal,
      redirect: 'manual',
      headers: { 'user-agent': 'cds-uptime-monitor', ...probeRequestHeaders() },
    });
    const code = res.status;
    if (!statusMatches(code, monitor.expectedStatus)) {
      await res.body?.cancel().catch(() => undefined);
      return { up: false, ms: Date.now() - startedAt, code, err: `HTTP ${code}，不在期望范围 ${monitor.expectedStatus || DEFAULT_EXPECTED_STATUS}` };
    }
    if (monitor.kind === 'keyword') {
      const body = await readBodyPrefix(res, KEYWORD_BODY_LIMIT_BYTES);
      if (!body.includes(monitor.keyword || '')) {
        return { up: false, ms: Date.now() - startedAt, code, err: `响应中未找到关键字「${monitor.keyword}」` };
      }
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
    return { up: true, ms: Date.now() - startedAt, code };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    return {
      up: false,
      ms: Date.now() - startedAt,
      err: aborted ? `探测超时（${timeoutMs}ms）` : ((err as Error & { cause?: Error }).cause?.message || (err as Error).message),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 按监控定义发一次探测。timeoutMs 由调用方结算（监控自身 > 全局）。 */
export async function probeCustomMonitor(
  monitor: Pick<UptimeCustomMonitor, 'kind' | 'url' | 'method' | 'expectedStatus' | 'keyword' | 'host' | 'port'>,
  timeoutMs: number,
): Promise<CustomProbeOutcome> {
  if (monitor.kind === 'tcp') {
    if (!monitor.host || !monitor.port) return { up: false, ms: 0, err: 'TCP 目标缺少主机或端口' };
    return await tcpProbe(monitor.host, monitor.port, timeoutMs);
  }
  if (!monitor.url) return { up: false, ms: 0, err: '未配置探测地址' };
  return await httpProbe(monitor, timeoutMs);
}
