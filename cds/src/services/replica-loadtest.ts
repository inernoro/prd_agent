/**
 * 复制集压测（Replica Load Test）—— design.cds.replica-loadtest（2026-07-27）。
 *
 * 复制集本来就是一台现成的 A/B 负载对比台：同一入口下并排跑多个版本，每个成员
 * 都能被 `__rs=<profileId>:<memberId>` 精确钉住。缺的只是「打流量 + 收指标 +
 * 出结论」这三件事，本模块补齐它们。
 *
 * 三条不可动摇的设计前提：
 *
 *   1. **不许打外网（防 SSRF）**：执行器永远只连本机 forwarder（127.0.0.1:port），
 *      被压的目标由 Host 头 + `__rs` 钉选决定，而 Host 必须落在「本分支已发布域名」
 *      白名单里（与分流探测同款归属规则）。调用方给不出一个能让 CDS 替它访问
 *      任意主机的入参。
 *   2. **不许把宿主打死**：这是生产 CDS。并发、时长、总请求数、同时在跑的压测
 *      任务数全部有硬上限；磁盘冻结档直接拒绝发起（对齐 disk-guard 的刹车语义）。
 *   3. **等待期必须有产物**：报告在跑的过程中就逐秒长出来（每秒一个 QPS / p95 /
 *      错误数的采样点），前端轮询即可画出生长中的曲线，而不是一个静止的 spinner。
 *
 * 并发闸纪律（.claude/rules/concurrency-gate-discipline.md 五件套）在这里的落法：
 *   - 等待可取消：本闸**不排队**（超出上限直接拒绝并说明谁在占用）。不排队是
 *     「等待可取消」的最强形式——压测是人在看着的即时动作，排到十分钟后自己
 *     跑起来只会吓人。
 *   - 持有者身份：`activeHolders()` 逐条给出 branchId/profileId/runId/发起时刻。
 *   - 只锁真实资源：占位从「开始打流量」到「收尾」，纯读报告不占位。
 *   - 周期收敛：`reapStale()` 收割心跳过期的僵尸 run（进程内 setInterval 由
 *     路由层驱动，也可被测试手动调用）。
 *   - 健康不变量：`health()` 断言「占位数 === running 记录数」且无过期心跳。
 */
import { Agent, request as nodeHttpRequest } from 'node:http';
import type { BranchEntry } from '../types.js';
import type { StateService } from './state.js';
import { resolveEffectiveProfile } from './container.js';
import { dnsSafeProfile } from './forwarder-route-publisher.js';
import { buildPreviewUrlForProject } from './comment-template.js';

/** 压测硬上限。改这里等于改「最多能把宿主压到什么程度」，请连同回归测试一起改。 */
export const LOADTEST_LIMITS = {
  /** 单个目标（单个副本）的并发连接数上限 */
  maxConcurrencyPerTarget: 20,
  /** 全部目标合计的并发上限——A/B 时目标数会乘上去，必须单独设闸 */
  maxTotalConcurrency: 60,
  /** 单次压测最长持续秒数 */
  maxDurationSec: 300,
  minDurationSec: 3,
  /** 预热秒数上限（预热期的样本不进指标） */
  maxWarmupSec: 30,
  /** 单次压测总请求数上限（时长没到也会停） */
  maxTotalRequests: 200_000,
  /** 一次最多并排压几个目标 */
  maxTargets: 6,
  /** 同时在跑的压测任务数上限 */
  maxRunning: 1,
  /** 每个分支保留的历史报告条数 */
  retentionRuns: 20,
  /** 心跳过期判定：超过这个时长没更新的 running 记录视为僵尸 */
  staleHeartbeatMs: 90_000,
  /** 单个请求超时 */
  requestTimeoutMs: 15_000,
  /** 自定义请求头数量与总长度上限 */
  maxHeaders: 12,
  maxHeaderBytes: 2048,
  /** 请求体长度上限 */
  maxBodyBytes: 16 * 1024,
} as const;

/** 禁止调用方覆写的请求头（Host 由我们钉选目标，其余是执行器自用的标记）。 */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'connection', 'x-cds-loadtest', 'x-cds-probe']);

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

export class LoadTestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'LoadTestError';
  }
}

export type LoadTestErrorKind = 'timeout' | 'connect' | 'http5xx' | 'http4xx' | 'cancelled' | 'other';
export type LoadTestStatus = 'running' | 'done' | 'cancelled' | 'error';

/** 一个被压的落点：同一入口 host，靠 `__rs` 钉住具体副本。 */
export interface LoadTestTarget {
  /** 'primary' 或成员 id（res-N） */
  memberId: string;
  label: string;
  host: string;
  path: string;
  /** 钉选值，写进 query `__rs` */
  pinned: string;
  /**
   * 期望的副本组标识 `${branchId}:${profileId}`（forwarder 回在 X-CDS-Replica-Group）。
   * 只核对成员 id 不够：不同 profile 的成员 id 会重名（primary / rs-1 都可能撞），
   * 压测路径若解析到了另一个启用复制集的 profile，光看成员 id 会误判为核对通过。
   */
  expectedGroup: string;
}

export interface LoadTestSeriesPoint {
  /** 相对开始的第几秒（预热期为负数，不进指标） */
  second: number;
  qps: number;
  p95: number;
  errors: number;
}

export interface LoadTestTargetMetrics {
  memberId: string;
  label: string;
  requests: number;
  success: number;
  failed: number;
  successRate: number;
  qps: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  errors: Record<LoadTestErrorKind, number>;
  /** 落点核对：响应头 X-CDS-Replica 的实际值分布（钉选是否真的生效） */
  servedBy: Record<string, number>;
  /** 落点核对：响应头 X-CDS-Replica-Group 的实际值分布（是否打到了同一个 profile 的组） */
  servedGroups: Record<string, number>;
  /** 期望的组标识，与 servedGroups 比对，防止跨 profile 的同名成员被误判为核对通过 */
  expectedGroup: string;
  series: LoadTestSeriesPoint[];
}

export interface LoadTestComparisonRow {
  memberId: string;
  label: string;
  /** 正数 = 比基线慢（p95 更高） */
  p95DeltaPct: number | null;
  /** 正数 = 比基线吞吐高 */
  qpsDeltaPct: number | null;
  /** 百分点差（正数 = 成功率更高） */
  successRateDeltaPoint: number | null;
  verdict: string;
}

export interface LoadTestComparison {
  baselineId: string;
  baselineLabel: string;
  rows: LoadTestComparisonRow[];
  summary: string;
  /**
   * 落点是否已核实。false = 观测到的 X-CDS-Replica 无法证明各落点真的打到了
   * 各自的版本，此时 rows 为空、summary 说明原因——绝不给出「谁更快」的结论。
   */
  routingVerified: boolean;
  /** 未通过核实时的人话原因 */
  routingIssue?: string;
}

export interface LoadTestConfig {
  concurrency: number;
  durationSec: number;
  warmupSec: number;
  method: string;
  path: string;
  host: string;
  headers: Record<string, string>;
  body?: string;
  maxRequests: number;
}

export interface LoadTestReport {
  id: string;
  branchId: string;
  profileId: string;
  status: LoadTestStatus;
  config: LoadTestConfig;
  targets: LoadTestTargetMetrics[];
  comparison?: LoadTestComparison;
  startedAt: string;
  endedAt?: string;
  /** 已跑秒数（含预热） */
  elapsedSec: number;
  /** 0-100 */
  progressPct: number;
  /** 预计剩余秒数（结束后为 0） */
  etaSec: number;
  /** 阶段文案：用户任何时刻都知道现在在干嘛（预期管理） */
  phase: string;
  message?: string;
}

export interface LoadTestInput {
  memberIds?: string[];
  concurrency?: number;
  durationSec?: number;
  warmupSec?: number;
  method?: string;
  path?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string;
  maxRequests?: number;
}

/** 执行一个请求。默认实现走本机 forwarder；测试注入假实现即可脱离网络。 */
export type LoadTestRequestFn = (req: {
  port: number;
  host: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal: AbortSignal;
}) => Promise<{ status: number; errorKind?: LoadTestErrorKind; servedBy?: string; servedGroup?: string }>;

/* ────────────────────────── 纯函数（可单测，不碰 IO） ────────────────────────── */

/**
 * 分位数（nearest-rank）。空样本返回 0——压测报告里 0 表示「没有样本」，
 * 比 NaN 更适合直接渲染，调用方靠 requests===0 判定是否有数据。
 *
 * 注意：这是**小样本**工具（也是 LatencyDigest 分位数语义的参照实现）。压测
 * 执行器本身不再持有原始采样数组，指标一律走 LatencyDigest —— 20 万条采样的
 * 数组在 Math.min(...arr) / push(...arr) 这类展开调用下会直接抛 RangeError。
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return round2(sorted[0]);
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((clamped / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return round2(sorted[idx]);
}

/* ────────────── 延迟直方图（O(1) 记账，定长内存） ────────────── */

/**
 * 延迟摘要：count / sum / min / max 就地 O(1) 维护，分位数走**定长桶直方图**。
 *
 * 为什么不再留原始采样数组：单次压测的总请求数上限是 20 万（LOADTEST_LIMITS
 * .maxTotalRequests），而 V8 的展开实参上限约 12.5 万——`Math.min(...arr)` /
 * `arr.push(...other)` 在真实负载下必然抛 RangeError，报告端点从此持续 500，
 * 曲线当场断掉、结论永远出不来。改成直方图后，聚合与采样条数无关。
 *
 * 桶宽（精度代价，宁可报慢不报快：分位数取所在桶的上界，再按实测 max 收口）：
 *   - 0-99ms：1ms 一桶（100 桶）—— 延迟是整毫秒，这一段的分位数**完全精确**，
 *     而正常压测的绝大多数样本都落在这里；
 *   - 100-999ms：10ms 一桶（90 桶），分位数最多偏大 9ms；
 *   - 1000-14999ms：100ms 一桶（140 桶），分位数最多偏大 99ms；
 *   - >=15000ms（单请求超时上限）：1 个溢出桶，一律按 15000ms 计。
 * count / min / max / avg / qps / 成功率全部保持精确，只有分位数吃桶宽误差。
 *
 * 内存：每个直方图 331 槽 x 4 字节 = 1324 字节（Int32Array，首次记账才分配）。
 * 单次压测常驻上限 ≈ (1 全局 + 秒数) x 目标数 x 1324B，300 秒 x 6 目标 < 2.6MB；
 * 跑完冻结成报告快照后直方图即被释放（见 ReplicaLoadTestService.reportTargets）。
 */
export class LatencyDigest {
  /** 100 个 1ms 桶 + 90 个 10ms 桶 + 140 个 100ms 桶 + 1 个溢出桶 */
  static readonly SLOT_COUNT = 331;

  count = 0;
  sum = 0;
  min = 0;
  max = 0;
  private slots: Int32Array | null = null;

  /** 落桶：延迟按整毫秒归一（执行器给的延迟本就是整毫秒差值）。 */
  static slotOf(ms: number): number {
    if (ms < 100) return ms < 0 ? 0 : ms;
    if (ms < 1000) return 100 + Math.floor((ms - 100) / 10);
    if (ms < 15000) return 190 + Math.floor((ms - 1000) / 100);
    return 330;
  }

  /** 桶上界（分位数的保守取值）。 */
  static slotUpperBound(slot: number): number {
    if (slot < 100) return slot;
    if (slot < 190) return 100 + (slot - 100) * 10 + 9;
    if (slot < 330) return 1000 + (slot - 190) * 100 + 99;
    return 15000;
  }

  record(latency: number): void {
    const ms = latency > 0 ? Math.round(latency) : 0;
    if (this.count === 0) {
      this.min = ms;
      this.max = ms;
    } else {
      if (ms < this.min) this.min = ms;
      if (ms > this.max) this.max = ms;
    }
    this.count += 1;
    this.sum += ms;
    if (!this.slots) this.slots = new Int32Array(LatencyDigest.SLOT_COUNT);
    this.slots[LatencyDigest.slotOf(ms)] += 1;
  }

  /** nearest-rank 分位数，语义与 percentile() 一致，只是名次落在桶上。 */
  quantile(p: number): number {
    if (this.count === 0 || !this.slots) return 0;
    const clamped = Math.min(100, Math.max(0, p));
    const rank = Math.min(this.count, Math.max(1, Math.ceil((clamped / 100) * this.count)));
    let cumulative = 0;
    for (let i = 0; i < LatencyDigest.SLOT_COUNT; i += 1) {
      cumulative += this.slots[i];
      if (cumulative >= rank) return round2(Math.min(this.max, LatencyDigest.slotUpperBound(i)));
    }
    return round2(this.max);
  }

  get avg(): number {
    return this.count > 0 ? round2(this.sum / this.count) : 0;
  }

  /** 冻结成报告快照后释放直方图（保留 count/min/max/sum 便于事后自检）。 */
  release(): void {
    this.slots = null;
  }

  /** 内存占用估算（字节）：与采样条数无关，只与是否已分配桶数组有关。 */
  byteEstimate(): number {
    return this.slots ? LatencyDigest.SLOT_COUNT * 4 : 0;
  }
}

/**
 * 给压测路径钉上 `__rs=<member>`，**替换**掉调用方路径里已有的 `__rs`。
 *
 * 为什么必须替换而不是追加：forwarder（forwarder-main.ts）用
 * `URLSearchParams.get('__rs')` 取值，只认**第一个**。用户如果直接粘了一条
 * 已经钉过副本的预览 URL 当压测路径，追加写法会让所有 A/B 落点实际全打到
 * 用户钉的那一个副本上，而报告仍按不同成员分别标注、给出「谁更快」的结论——
 * 得到一份看起来正常、实则完全错误的对比（Codex PR #1273 P1）。
 */
export function withReplicaPin(rawPath: string, member: string): string {
  const hashAt = rawPath.indexOf('#');
  const hash = hashAt >= 0 ? rawPath.slice(hashAt) : '';
  const noHash = hashAt >= 0 ? rawPath.slice(0, hashAt) : rawPath;
  const queryAt = noHash.indexOf('?');
  const pathname = queryAt >= 0 ? noHash.slice(0, queryAt) : noHash;
  const params = new URLSearchParams(queryAt >= 0 ? noHash.slice(queryAt + 1) : '');
  params.delete('__rs');
  params.append('__rs', member);
  return `${pathname}?${params.toString()}${hash}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** HTTP 状态 / 传输异常归类。5xx 与 4xx 分开：前者是被压垮，后者多半是打错了路径。 */
export function classifyStatus(status: number): LoadTestErrorKind | null {
  if (status >= 500) return 'http5xx';
  if (status >= 400) return 'http4xx';
  return null;
}

/**
 * 入参归一化 + 硬闸校验。任何越界一律抛 LoadTestError（400），不做「悄悄截断」——
 * 用户填了 500 并发却按 20 跑，报告上的结论就是假的。
 *
 * @param targetCount 目标数量，用于合计并发上限校验（A/B 时目标数会把并发乘上去）
 */
export function normalizeLoadTestConfig(
  raw: LoadTestInput | undefined,
  targetCount: number,
  host: string,
  defaultPath: string,
): LoadTestConfig {
  const input = raw || {};
  const concurrency = intOr(input.concurrency, 5);
  if (concurrency < 1 || concurrency > LOADTEST_LIMITS.maxConcurrencyPerTarget) {
    throw new LoadTestError(400, `并发数需在 1-${LOADTEST_LIMITS.maxConcurrencyPerTarget} 之间（当前 ${concurrency}）`);
  }
  const total = concurrency * Math.max(1, targetCount);
  if (total > LOADTEST_LIMITS.maxTotalConcurrency) {
    throw new LoadTestError(
      400,
      `${targetCount} 个目标 × 并发 ${concurrency} = 合计 ${total} 条并发，超过上限 ${LOADTEST_LIMITS.maxTotalConcurrency}`
      + '——这是生产宿主，请调低并发或减少对比目标',
    );
  }
  const durationSec = intOr(input.durationSec, 20);
  if (durationSec < LOADTEST_LIMITS.minDurationSec || durationSec > LOADTEST_LIMITS.maxDurationSec) {
    throw new LoadTestError(400, `持续时长需在 ${LOADTEST_LIMITS.minDurationSec}-${LOADTEST_LIMITS.maxDurationSec} 秒之间（当前 ${durationSec}）`);
  }
  const warmupSec = intOr(input.warmupSec, 0);
  if (warmupSec < 0 || warmupSec > LOADTEST_LIMITS.maxWarmupSec) {
    throw new LoadTestError(400, `预热时长需在 0-${LOADTEST_LIMITS.maxWarmupSec} 秒之间（当前 ${warmupSec}）`);
  }
  const maxRequests = intOr(input.maxRequests, LOADTEST_LIMITS.maxTotalRequests);
  if (maxRequests < 1 || maxRequests > LOADTEST_LIMITS.maxTotalRequests) {
    throw new LoadTestError(400, `总请求数上限需在 1-${LOADTEST_LIMITS.maxTotalRequests} 之间（当前 ${maxRequests}）`);
  }
  const method = String(input.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new LoadTestError(400, `不支持的方法 ${method}（允许：${[...ALLOWED_METHODS].join(' / ')}）`);
  }
  const path = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : defaultPath;
  // path 强校验（与分流探测同款）：控制字符/空白/非 ASCII 会让 http.request 同步抛
  // ERR_UNESCAPED_CHARACTERS，在几千个并发请求里冒出来能把进程拖垮。
  if (!/^\/[\x21-\x7e]*$/.test(path)) {
    throw new LoadTestError(400, '请求路径必须以 / 开头且仅含可打印 ASCII（不能有空白或控制字符）');
  }
  const headers = normalizeHeaders(input.headers);
  const body = typeof input.body === 'string' && input.body.length > 0 ? input.body : undefined;
  if (body && Buffer.byteLength(body) > LOADTEST_LIMITS.maxBodyBytes) {
    throw new LoadTestError(400, `请求体超过 ${LOADTEST_LIMITS.maxBodyBytes} 字节上限`);
  }
  if (body && (method === 'GET' || method === 'HEAD')) {
    throw new LoadTestError(400, `${method} 请求不能携带请求体`);
  }
  return { concurrency, durationSec, warmupSec, method, path, host, headers, body, maxRequests };
}

function intOr(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function normalizeHeaders(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue;
    const name = key.trim();
    if (!name) continue;
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new LoadTestError(400, `请求头 ${name} 由压测执行器自己设置，不能覆写（覆写 Host 等于换一个被压目标）`);
    }
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      throw new LoadTestError(400, `非法请求头名 ${name}（仅允许字母、数字、连字符）`);
    }
    if (!/^[\x20-\x7e]*$/.test(value)) {
      throw new LoadTestError(400, `请求头 ${name} 的值含非法字符（仅允许可打印 ASCII）`);
    }
    out[name] = value;
    bytes += name.length + value.length;
    if (Object.keys(out).length > LOADTEST_LIMITS.maxHeaders) {
      throw new LoadTestError(400, `自定义请求头不能超过 ${LOADTEST_LIMITS.maxHeaders} 条`);
    }
    if (bytes > LOADTEST_LIMITS.maxHeaderBytes) {
      throw new LoadTestError(400, `自定义请求头总长度超过 ${LOADTEST_LIMITS.maxHeaderBytes} 字节`);
    }
  }
  return out;
}

/** 本分支已发布域名白名单（SSRF 闸门的数据面）。 */
export interface BranchHostAllowlist {
  /** 允许出现在根域之下的首标签（主入口 / 命名子域 / 成员直达） */
  labels: Set<string>;
  /** 全串精确匹配的自定义域 */
  customDomains: Set<string>;
  /** CDS 公网根域清单 */
  roots: string[];
}

/**
 * Host 归属校验（防 SSRF 的唯一判据）。
 *
 * 执行器只连 127.0.0.1 的 forwarder，但 Host 头决定 forwarder 把流量转给谁——
 * 不校验就等于「拿本分支的授权，让 CDS 替我压别的项目」。规则与分流探测一致：
 * 域名后缀必须命中根域清单，余下部分必须是**单个标签**且在白名单里；自定义域
 * 走全串精确匹配。根域没配置（纯本地 dev）时退回首标签语义，保持可用。
 */
export function isHostAllowedForBranch(host: string, allow: BranchHostAllowlist): boolean {
  const normalized = String(host || '').trim().toLowerCase();
  if (!normalized || !/^[a-z0-9.-]+$/.test(normalized)) return false;
  if (allow.customDomains.has(normalized)) return true;
  let label = '';
  for (const root of allow.roots) {
    const r = root.toLowerCase();
    if (!r) continue;
    if (normalized.endsWith(`.${r}`)) {
      const rest = normalized.slice(0, normalized.length - r.length - 1);
      if (rest && !rest.includes('.')) { label = rest; break; }
    }
  }
  if (!label && allow.roots.filter(Boolean).length === 0) label = normalized.split('.')[0] || '';
  if (!label) return false;
  return allow.labels.has(label);
}

/**
 * A/B 结论。基线优先取 primary（主实例是「现在线上的样子」，拿它当参照最符合
 * 直觉）；没有 primary 时取第一个目标。只有两个及以上目标才产出结论。
 */
export function buildComparison(targets: LoadTestTargetMetrics[]): LoadTestComparison | undefined {
  const usable = targets.filter((t) => t.requests > 0);
  if (usable.length < 2) return undefined;
  const baseline = usable.find((t) => t.memberId === 'primary') || usable[0];

  // 出结论之前先核实落点：forwarder 在 profile 级钉选不生效时（path 解析到了
  // 别的服务、目标副本被摘除而回退到默认路由等）会把多个「名义上不同」的落点
  // 全服务成同一份，而我们照样能收到 200 与延迟数据。这时若直接出「谁更快」的
  // 对比，等于拿同一个版本跟自己比还煞有介事地贴标签——比不给结论更糟。
  // 只用**有证据**的落点做判定：forwarder 仅在命中副本路由时才回 X-CDS-Replica，
  // 主实例与部分部署形态本就没有这个头。没有证据不能当成有问题（那会让整个功能
  // 在这些形态下永远出不了结论），但也不能当成没问题——分两档处理。
  const identityOf = (t: LoadTestTargetMetrics): string | null => {
    const entries = Object.entries(t.servedBy || {});
    if (entries.length === 0) return null;
    return entries.sort((a, b) => b[1] - a[1])[0]![0];
  };
  const seen = new Map<string, string>();
  let routingIssue: string | null = null;
  let anyEvidence = false;
  const groupOf = (t: LoadTestTargetMetrics): string | null => {
    const entries = Object.entries(t.servedGroups || {});
    if (entries.length === 0) return null;
    return entries.sort((a, b) => b[1] - a[1])[0]![0];
  };
  for (const t of usable) {
    const observed = identityOf(t);
    // 组先于成员核对：成员 id 在不同 profile 之间会重名（primary / rs-1 都可能撞），
    // 压测路径若解析到了另一个启用复制集的 profile，只看成员 id 会误判为核对通过。
    const observedGroup = groupOf(t);
    if (observedGroup !== null && t.expectedGroup && observedGroup !== t.expectedGroup) {
      routingIssue = `落点核对失败：${t.label} 期望由副本组 ${t.expectedGroup} 服务，实际观测到 ${observedGroup}（压测路径可能解析到了别的服务）`;
      anyEvidence = true;
      break;
    }
    if (observed === null) continue;
    anyEvidence = true;
    // 副本成员自报了家门就必须对得上。
    if (t.memberId !== 'primary' && observed !== t.memberId) {
      routingIssue = `落点核对失败：${t.label} 期望由副本 ${t.memberId} 服务，实际观测到 ${observed}`;
      break;
    }
    const dup = seen.get(observed);
    if (dup) {
      routingIssue = `落点核对失败：${dup} 与 ${t.label} 被同一个实例（${observed}）服务，无法区分两者`;
      break;
    }
    seen.set(observed, t.label);
  }
  // 硬失败：有证据且证据自相矛盾 —— 拿同一个版本跟自己比还贴标签，比不给结论更糟。
  if (routingIssue) {
    return {
      baselineId: baseline.memberId,
      baselineLabel: baseline.label,
      rows: [],
      routingVerified: false,
      routingIssue,
      summary: `${routingIssue}。本次不给出版本对比结论——请检查压测路径是否指向本服务、目标副本是否仍在运行。`,
    };
  }
  const rows: LoadTestComparisonRow[] = [];
  for (const t of usable) {
    if (t.memberId === baseline.memberId) continue;
    const p95Delta = baseline.p95 > 0 ? round2(((t.p95 - baseline.p95) / baseline.p95) * 100) : null;
    const qpsDelta = baseline.qps > 0 ? round2(((t.qps - baseline.qps) / baseline.qps) * 100) : null;
    const successDelta = round2((t.successRate - baseline.successRate) * 100);
    rows.push({
      memberId: t.memberId,
      label: t.label,
      p95DeltaPct: p95Delta,
      qpsDeltaPct: qpsDelta,
      successRateDeltaPoint: successDelta,
      verdict: describeRow(p95Delta, qpsDelta, successDelta),
    });
  }
  // 最快 = p95 最低；最稳 = 成功率最高（并列时取 p95 更低者）
  const fastest = [...usable].sort((a, b) => a.p95 - b.p95)[0];
  const steadiest = [...usable].sort((a, b) => (b.successRate - a.successRate) || (a.p95 - b.p95))[0];
  const summary = fastest.memberId === steadiest.memberId
    ? `${fastest.label} 综合最优：p95 最低（${fastest.p95}ms）且成功率最高（${pct(fastest.successRate)}）。基线为 ${baseline.label}。`
    : `${fastest.label} 最快（p95 ${fastest.p95}ms），${steadiest.label} 最稳（成功率 ${pct(steadiest.successRate)}）。基线为 ${baseline.label}。`;
  // 软档：一条副本标识都没观测到，无法证明各落点真打到了不同版本。数据照给
  // （它本身是真实测到的），但明确标注未核实，不让 UI 把它当成可信的 A/B 判定。
  if (!anyEvidence) {
    return {
      baselineId: baseline.memberId,
      baselineLabel: baseline.label,
      rows,
      routingVerified: false,
      routingIssue: '未观测到任何副本标识（X-CDS-Replica），无法确认各落点真的打到了不同版本',
      summary: `${summary}（注意：未观测到副本标识，无法确认各落点分别打到了不同版本，请谨慎解读该对比）`,
    };
  }
  return { baselineId: baseline.memberId, baselineLabel: baseline.label, rows, summary, routingVerified: true };
}

function pct(rate: number): string {
  return `${round2(rate * 100)}%`;
}

function describeRow(p95Delta: number | null, qpsDelta: number | null, successDelta: number): string {
  const parts: string[] = [];
  if (p95Delta === null) parts.push('基线无有效延迟样本，无法比较延迟');
  else if (Math.abs(p95Delta) < 5) parts.push('延迟与基线基本持平');
  else parts.push(p95Delta > 0 ? `p95 比基线高 ${p95Delta}%（更慢）` : `p95 比基线低 ${Math.abs(p95Delta)}%（更快）`);
  if (qpsDelta !== null && Math.abs(qpsDelta) >= 5) {
    parts.push(qpsDelta > 0 ? `吞吐高 ${qpsDelta}%` : `吞吐低 ${Math.abs(qpsDelta)}%`);
  }
  if (Math.abs(successDelta) >= 0.5) {
    parts.push(successDelta > 0 ? `成功率高 ${successDelta} 个百分点` : `成功率低 ${Math.abs(successDelta)} 个百分点`);
  }
  return parts.join('，');
}

/* ────────────────────────── 运行时 ────────────────────────── */

interface Bucket {
  /** 该秒的样本条数（= 这一秒的 QPS） */
  count: number;
  /** 该秒的延迟直方图（定长内存，供曲线上的 p95 用） */
  latency: LatencyDigest;
  errors: number;
}

interface TargetRuntime {
  target: LoadTestTarget;
  /** 秒桶：key = 相对秒（预热期为负） */
  buckets: Map<number, Bucket>;
  /** 计入指标的延迟摘要（预热期样本不进来），O(1) 记账 */
  latency: LatencyDigest;
  requests: number;
  success: number;
  failed: number;
  errorCounts: Record<LoadTestErrorKind, number>;
  servedBy: Record<string, number>;
  servedGroups: Record<string, number>;
}

interface LoadTestRun {
  id: string;
  branchId: string;
  projectId: string;
  profileId: string;
  status: LoadTestStatus;
  config: LoadTestConfig;
  targets: TargetRuntime[];
  startedAtMs: number;
  startedAt: string;
  endedAt?: string;
  message?: string;
  abort: AbortController;
  /** 心跳（周期收敛判据） */
  heartbeatMs: number;
  /** 是否持有并发闸位（只在真正打流量期间为 true） */
  holdsSlot: boolean;
  /** 全部 worker 已落地（fan-out 收尾完成），此后不会再有新样本进来 */
  workersSettled: boolean;
  /** 收尾后冻结的指标快照：算一次就把直方图释放掉，历史报告不再常驻内存 */
  frozenTargets?: LoadTestTargetMetrics[];
}

export interface LoadTestHolder {
  runId: string;
  branchId: string;
  profileId: string;
  startedAt: string;
  elapsedSec: number;
}

export interface ReplicaLoadTestServiceOptions {
  state: StateService;
  /** 本机 forwarder 端口（默认 CDS_FORWARDER_PORT 或 9090） */
  forwarderPort?: number;
  /** CDS 公网根域清单（config.rootDomains） */
  rootDomains?: string[];
  /** 磁盘刹车：返回非空即拒绝发起（freeze 档） */
  diskBlockReason?: () => string | null;
  /** 测试注入点：替换真实 HTTP 执行 */
  requestFn?: LoadTestRequestFn;
  now?: () => number;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

export class ReplicaLoadTestService {
  /** runId → run。按分支保留最近 N 条（含已结束的报告）。 */
  private readonly runs = new Map<string, LoadTestRun>();
  private readonly requestFn: LoadTestRequestFn;
  private seq = 0;

  constructor(private readonly opts: ReplicaLoadTestServiceOptions) {
    this.requestFn = opts.requestFn ?? defaultRequestFn();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /* ── 并发闸（不排队，超限即拒；持有者身份可查；周期收敛靠 reapStale） ── */

  /** 当前占位者明细：运维/用户能回答「谁在压测、压了多久」。 */
  activeHolders(): LoadTestHolder[] {
    const now = this.now();
    return [...this.runs.values()]
      .filter((r) => r.holdsSlot)
      .map((r) => ({
        runId: r.id,
        branchId: r.branchId,
        profileId: r.profileId,
        startedAt: r.startedAt,
        elapsedSec: Math.max(0, Math.round((now - r.startedAtMs) / 1000)),
      }));
  }

  /**
   * 收割心跳过期的僵尸 run：进程被打断、异常路径漏掉 finally 时，占位不能永久
   * 泄漏（否则压测入口从此再也点不动，且没人知道为什么）。
   */
  reapStale(): number {
    const now = this.now();
    let reaped = 0;
    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue;
      if (now - run.heartbeatMs <= LOADTEST_LIMITS.staleHeartbeatMs) continue;
      run.status = 'error';
      run.message = '压测心跳超时，已判定为异常中断并释放并发闸位';
      run.endedAt = new Date(now).toISOString();
      run.holdsSlot = false;
      run.abort.abort();
      reaped += 1;
      this.opts.logger?.warn?.(`[replica-loadtest] 收割僵尸压测 ${run.id}（${run.branchId}/${run.profileId}）`);
    }
    return reaped;
  }

  /**
   * 健康不变量。选的是**真不变**的两条：
   *   - 占位数 === 状态为 running 的记录数（计数器/状态漂移会当场现形）；
   *   - 占位数不超过上限；
   *   - 没有心跳过期却仍在 running 的记录。
   */
  health(): { ok: boolean; active: number; running: number; stale: number; issues: string[] } {
    const now = this.now();
    const running = [...this.runs.values()].filter((r) => r.status === 'running');
    const active = [...this.runs.values()].filter((r) => r.holdsSlot);
    const stale = running.filter((r) => now - r.heartbeatMs > LOADTEST_LIMITS.staleHeartbeatMs);
    const issues: string[] = [];
    if (active.length !== running.length) {
      issues.push(`占位数 ${active.length} 与 running 记录数 ${running.length} 不一致（闸位泄漏或状态漂移）`);
    }
    if (active.length > LOADTEST_LIMITS.maxRunning) {
      issues.push(`同时在跑的压测 ${active.length} 超过上限 ${LOADTEST_LIMITS.maxRunning}`);
    }
    if (stale.length > 0) issues.push(`${stale.length} 个压测心跳过期未被收割`);
    return { ok: issues.length === 0, active: active.length, running: running.length, stale: stale.length, issues };
  }

  /* ── 目标解析 ── */

  /** 该分支已发布域名白名单（SSRF 闸门数据面）。 */
  buildAllowlist(branch: BranchEntry): BranchHostAllowlist {
    const project = this.opts.state.getProjects().find((p) => p.id === branch.projectId);
    const previewSlug = buildPreviewUrlForProject('', branch.branch, project, branch.projectId).previewSlug || '';
    const labels = new Set<string>();
    if (previewSlug) {
      labels.add(previewSlug);
      for (const p of this.opts.state.getEffectiveProfilesForBranch(branch)) {
        const sub = resolveEffectiveProfile(p, branch).subdomain;
        if (sub) labels.add(`${previewSlug}-${String(sub).toLowerCase()}`);
      }
      for (const [profileId, rs] of Object.entries(branch.replicaSets ?? {})) {
        for (const m of rs.members) {
          labels.add(`${previewSlug}-${dnsSafeProfile(profileId)}-${m.id}`.toLowerCase());
        }
      }
    }
    for (const alias of branch.subdomainAliases ?? []) {
      if (alias) labels.add(String(alias).toLowerCase());
    }
    return {
      labels,
      customDomains: new Set((branch.customDomains ?? []).map((d) => String(d).toLowerCase())),
      roots: (this.opts.rootDomains ?? []).map((r) => String(r).toLowerCase()).filter(Boolean),
    };
  }

  /** 默认入口 host：主预览域名。根域未配置时返回空串（此时必须由调用方给 host）。 */
  private defaultHost(branch: BranchEntry): string {
    const project = this.opts.state.getProjects().find((p) => p.id === branch.projectId);
    const slug = buildPreviewUrlForProject('', branch.branch, project, branch.projectId).previewSlug || '';
    const root = (this.opts.rootDomains ?? []).filter(Boolean)[0];
    return slug && root ? `${slug}.${root}`.toLowerCase() : '';
  }

  /** 该 profile 的默认探测路径（与分流探测同口径：走 profile 的第一条 pathPrefix）。 */
  private defaultPath(branch: BranchEntry, profileId: string): string {
    const base = this.opts.state.getEffectiveProfilesForBranch(branch).find((p) => p.id === profileId);
    const profile = base ? resolveEffectiveProfile(base, branch) : undefined;
    return profile?.pathPrefixes?.[0]
      || (profileId.includes('api') || profileId.includes('backend') ? '/api/' : '/');
  }

  /**
   * 解析被压目标。默认「全部在跑的成员 + 主实例各自钉选分别打」——这正是复制集
   * 天生适合压测的地方：同一入口、同一路径、同一时刻，唯一变量是版本。
   */
  resolveTargets(branchId: string, profileId: string, memberIds: string[] | undefined, host: string, path: string): LoadTestTarget[] {
    const branch = this.requireBranch(branchId);
    const rs = branch.replicaSets?.[profileId];
    const wanted = memberIds && memberIds.length > 0 ? new Set(memberIds) : null;
    const targets: LoadTestTarget[] = [];
    const primaryRunning = branch.services?.[profileId]?.status === 'running';
    if ((!wanted || wanted.has('primary')) && primaryRunning) {
      targets.push({ memberId: 'primary', label: '主实例', host, path, pinned: `${profileId}:primary`, expectedGroup: `${branchId}:${profileId}` });
    }
    for (const m of rs?.members ?? []) {
      if (wanted && !wanted.has(m.id)) continue;
      if (m.status !== 'running') continue;
      targets.push({
        memberId: m.id,
        label: m.label || m.id,
        host,
        path,
        pinned: `${profileId}:${m.id}`,
        expectedGroup: `${branchId}:${profileId}`,
      });
    }
    if (targets.length === 0) {
      throw new LoadTestError(409, `没有可压测的运行中实例：${profileId} 的主实例与副本都不在 running 状态（先把服务跑起来再压）`);
    }
    if (targets.length > LOADTEST_LIMITS.maxTargets) {
      throw new LoadTestError(400, `一次最多并排压 ${LOADTEST_LIMITS.maxTargets} 个目标（当前 ${targets.length}），请指定 memberIds 缩小范围`);
    }
    return targets;
  }

  /* ── 发起 / 查询 / 取消 ── */

  start(branchId: string, profileId: string, input: LoadTestInput | undefined): LoadTestReport {
    const branch = this.requireBranch(branchId);
    if (!this.opts.state.getEffectiveProfilesForBranch(branch).some((p) => p.id === profileId)) {
      throw new LoadTestError(404, `服务不存在: ${profileId}`);
    }
    // 磁盘冻结档拒绝发起：压测会把上游日志、容器可写层撑起来，恢复期不能再添乱
    const diskBlocked = this.opts.diskBlockReason?.();
    if (diskBlocked) {
      throw new LoadTestError(507, `磁盘压力过大，暂不接受压测：${diskBlocked}`);
    }
    this.reapStale();
    const holders = this.activeHolders();
    if (holders.length >= LOADTEST_LIMITS.maxRunning) {
      const h = holders[0];
      throw new LoadTestError(
        409,
        `已有压测在进行中（${h.branchId}/${h.profileId}，已跑 ${h.elapsedSec}s，任务 ${h.runId}）。`
        + '同时只允许一个压测任务，请等它结束或先取消——并发压测会互相污染结果，也会把宿主压垮。',
      );
    }
    const host = (typeof input?.host === 'string' && input.host.trim() ? input.host.trim() : this.defaultHost(branch)).toLowerCase();
    if (!host) {
      throw new LoadTestError(409, '该分支还没有可用的预览入口域名（CDS 根域未配置），无法压测');
    }
    // SSRF 闸门：Host 决定 forwarder 把流量转给谁，必须落在本分支已发布域名内
    if (!isHostAllowedForBranch(host, this.buildAllowlist(branch))) {
      throw new LoadTestError(403, `入口 host ${host} 不属于该分支的已发布域名，拒绝压测（压测只能打自己分支的入口）`);
    }
    const path = typeof input?.path === 'string' && input.path.trim() ? input.path.trim() : this.defaultPath(branch, profileId);
    const targets = this.resolveTargets(branchId, profileId, input?.memberIds, host, path);
    const config = normalizeLoadTestConfig(input, targets.length, host, path);
    const startedAtMs = this.now();
    this.seq += 1;
    const run: LoadTestRun = {
      id: `lt-${startedAtMs.toString(36)}-${this.seq.toString(36)}`,
      branchId,
      projectId: branch.projectId,
      profileId,
      status: 'running',
      config,
      targets: targets.map((t) => ({
        target: { ...t, path: config.path },
        buckets: new Map(),
        latency: new LatencyDigest(),
        requests: 0,
        success: 0,
        failed: 0,
        errorCounts: { timeout: 0, connect: 0, http5xx: 0, http4xx: 0, cancelled: 0, other: 0 },
        servedBy: {},
        servedGroups: {},
      })),
      startedAtMs,
      startedAt: new Date(startedAtMs).toISOString(),
      abort: new AbortController(),
      heartbeatMs: startedAtMs,
      holdsSlot: true,
      workersSettled: false,
    };
    this.runs.set(run.id, run);
    this.trim(branchId);
    void this.execute(run).catch((err) => {
      run.status = 'error';
      run.message = (err as Error).message;
      run.endedAt = new Date(this.now()).toISOString();
      run.holdsSlot = false;
      run.workersSettled = true;
      this.opts.logger?.error?.(`[replica-loadtest] 压测异常 ${run.id}: ${(err as Error).message}`);
    });
    return this.toReport(run);
  }

  get(branchId: string, runId: string): LoadTestReport {
    const run = this.runs.get(runId);
    if (!run || run.branchId !== branchId) throw new LoadTestError(404, `压测任务不存在: ${runId}`);
    return this.toReport(run);
  }

  list(branchId: string): LoadTestReport[] {
    return [...this.runs.values()]
      .filter((r) => r.branchId === branchId)
      .sort((a, b) => b.startedAtMs - a.startedAtMs)
      .map((r) => this.toReport(r));
  }

  /**
   * 取消：置 abort 后，每个 worker 在**下一个请求边界**（≤ 一个请求周期）退出，
   * 在途请求也会被 destroy。控制面状态同步翻转，UI 立刻看到「已取消」。
   */
  cancel(branchId: string, runId: string): LoadTestReport {
    const run = this.runs.get(runId);
    if (!run || run.branchId !== branchId) throw new LoadTestError(404, `压测任务不存在: ${runId}`);
    if (run.status !== 'running') return this.toReport(run);
    run.abort.abort();
    run.status = 'cancelled';
    run.message = '已由用户取消（已跑出的样本仍保留在报告里）';
    run.endedAt = new Date(this.now()).toISOString();
    run.holdsSlot = false;
    return this.toReport(run);
  }

  private trim(branchId: string): void {
    const mine = [...this.runs.values()].filter((r) => r.branchId === branchId).sort((a, b) => b.startedAtMs - a.startedAtMs);
    for (const stale of mine.slice(LOADTEST_LIMITS.retentionRuns)) {
      if (stale.status === 'running') continue;
      this.runs.delete(stale.id);
    }
  }

  private requireBranch(branchId: string): BranchEntry {
    const branch = this.opts.state.getBranch(branchId);
    if (!branch) throw new LoadTestError(404, `分支不存在: ${branchId}`);
    return branch;
  }

  /* ── 执行器 ── */

  private async execute(run: LoadTestRun): Promise<void> {
    const { config } = run;
    const totalMs = (config.warmupSec + config.durationSec) * 1000;
    const deadline = run.startedAtMs + totalMs;
    const port = this.opts.forwarderPort || Number(process.env.CDS_FORWARDER_PORT) || 9090;
    const budget = { remaining: config.maxRequests };
    const workers: Array<Promise<void>> = [];
    for (const rt of run.targets) {
      for (let i = 0; i < config.concurrency; i += 1) {
        workers.push(this.worker(run, rt, port, deadline, budget));
      }
    }
    // 全体落地才收尾（fan-out 纪律）：任何一个 worker 脱管都会让占位提前释放，
    // 而它还在继续打流量——那正是「并发上限形同虚设」的经典成因。
    try {
      await Promise.allSettled(workers);
      if (run.status === 'running') {
        run.status = 'done';
        run.endedAt = new Date(this.now()).toISOString();
      }
      run.heartbeatMs = this.now();
      run.holdsSlot = false;
    } finally {
      // 无论走哪条路径，都得宣告「不会再有新样本」，否则报告永远冻结不了、
      // 直方图跟着历史记录一直常驻。
      run.workersSettled = true;
    }
  }

  private async worker(run: LoadTestRun, rt: TargetRuntime, port: number, deadline: number, budget: { remaining: number }): Promise<void> {
    const { config } = run;
    const signal = run.abort.signal;
    const pinnedPath = withReplicaPin(config.path, rt.target.pinned);
    for (;;) {
      if (signal.aborted) return;
      const now = this.now();
      if (now >= deadline) return;
      if (budget.remaining <= 0) return;
      budget.remaining -= 1;
      const startedAt = now;
      let result: { status: number; errorKind?: LoadTestErrorKind; servedBy?: string; servedGroup?: string };
      try {
        result = await this.requestFn({
          port,
          host: rt.target.host,
          path: pinnedPath,
          method: config.method,
          headers: config.headers,
          body: config.body,
          timeoutMs: LOADTEST_LIMITS.requestTimeoutMs,
          signal,
        });
      } catch {
        result = { status: 0, errorKind: 'other' };
      }
      const latency = Math.max(0, this.now() - startedAt);
      // 取消后到达的响应不记账：它属于「被打断的那一次」，混进指标会拉低 p99
      if (signal.aborted && result.errorKind === 'cancelled') return;
      this.record(run, rt, latency, result);
      run.heartbeatMs = this.now();
    }
  }

  private record(
    run: LoadTestRun,
    rt: TargetRuntime,
    latency: number,
    result: { status: number; errorKind?: LoadTestErrorKind; servedBy?: string; servedGroup?: string },
  ): void {
    const second = Math.floor((this.now() - run.startedAtMs) / 1000) - run.config.warmupSec;
    let bucket = rt.buckets.get(second);
    if (!bucket) {
      bucket = { count: 0, latency: new LatencyDigest(), errors: 0 };
      rt.buckets.set(second, bucket);
    }
    const kind = result.errorKind ?? classifyStatus(result.status) ?? null;
    const ok = !kind && result.status > 0;
    // 预热期的样本不进指标，只进时间序列（负秒），让曲线从预热就开始动
    if (second >= 0) {
      rt.requests += 1;
      if (ok) rt.success += 1;
      else {
        rt.failed += 1;
        rt.errorCounts[kind ?? 'other'] += 1;
      }
      if (result.servedBy) rt.servedBy[result.servedBy] = (rt.servedBy[result.servedBy] || 0) + 1;
      if (result.servedGroup) rt.servedGroups[result.servedGroup] = (rt.servedGroups[result.servedGroup] || 0) + 1;
      // 就地 O(1) 记账：不留原始采样数组，聚合成本与请求条数无关
      rt.latency.record(latency);
    }
    bucket.count += 1;
    bucket.latency.record(latency);
    if (!ok) bucket.errors += 1;
  }

  /* ── 报告 ── */

  private toReport(run: LoadTestRun): LoadTestReport {
    const now = this.now();
    const endMs = run.endedAt ? Date.parse(run.endedAt) : now;
    const elapsedSec = Math.max(0, Math.round((endMs - run.startedAtMs) / 1000));
    const totalSec = run.config.warmupSec + run.config.durationSec;
    const progressPct = run.status === 'running'
      ? Math.min(99, Math.round((elapsedSec / Math.max(1, totalSec)) * 100))
      : 100;
    const etaSec = run.status === 'running' ? Math.max(0, totalSec - elapsedSec) : 0;
    const targets = this.reportTargets(run);
    const comparison = run.status === 'running' ? undefined : buildComparison(targets);
    return {
      id: run.id,
      branchId: run.branchId,
      profileId: run.profileId,
      status: run.status,
      config: run.config,
      targets,
      comparison,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      elapsedSec,
      progressPct,
      etaSec,
      phase: describePhase(run.status, elapsedSec, run.config.warmupSec, etaSec),
      message: run.message,
    };
  }

  /**
   * 报告的指标来源。跑完并且全部 worker 落地之后**只算一次**并冻结成快照，
   * 顺手释放直方图——历史报告在 retentionRuns 窗口里最多留 20 条，不能让每条
   * 都拖着一整套秒级直方图常驻内存。
   */
  private reportTargets(run: LoadTestRun): LoadTestTargetMetrics[] {
    if (run.frozenTargets) return run.frozenTargets;
    const targets = run.targets.map((rt) => this.targetMetrics(rt, run));
    if (run.status !== 'running' && run.workersSettled) {
      run.frozenTargets = targets;
      for (const rt of run.targets) {
        for (const bucket of rt.buckets.values()) bucket.latency.release();
        rt.buckets.clear();
        rt.latency.release();
      }
    }
    return targets;
  }

  private targetMetrics(rt: TargetRuntime, run: LoadTestRun): LoadTestTargetMetrics {
    const series: LoadTestSeriesPoint[] = [];
    const entries = Array.from(rt.buckets.entries()).sort((a, b) => a[0] - b[0]);
    for (const [second, bucket] of entries) {
      series.push({
        second,
        qps: bucket.count,
        p95: bucket.latency.quantile(95),
        errors: bucket.errors,
      });
    }
    const endMs = run.endedAt ? Date.parse(run.endedAt) : this.now();
    const measuredSec = Math.max(1, Math.round((endMs - run.startedAtMs) / 1000) - run.config.warmupSec);
    const stats = rt.latency;
    return {
      memberId: rt.target.memberId,
      label: rt.target.label,
      requests: rt.requests,
      success: rt.success,
      failed: rt.failed,
      successRate: rt.requests > 0 ? rt.success / rt.requests : 0,
      qps: round2(rt.requests / measuredSec),
      avg: stats.avg,
      min: stats.count > 0 ? round2(stats.min) : 0,
      max: stats.count > 0 ? round2(stats.max) : 0,
      p50: stats.quantile(50),
      p90: stats.quantile(90),
      p95: stats.quantile(95),
      p99: stats.quantile(99),
      errors: { ...rt.errorCounts },
      servedBy: { ...rt.servedBy },
      servedGroups: { ...rt.servedGroups },
      expectedGroup: rt.target.expectedGroup,
      series,
    };
  }
}

/** 阶段文案（预期管理：任何时刻都说得清「在干嘛、还要多久」）。 */
export function describePhase(status: LoadTestStatus, elapsedSec: number, warmupSec: number, etaSec: number): string {
  if (status === 'cancelled') return '已取消';
  if (status === 'error') return '异常中断';
  if (status === 'done') return '已完成，正在给出对比结论';
  if (elapsedSec < warmupSec) return `预热中（${elapsedSec}/${warmupSec}s，预热样本不计入指标）`;
  return `加压中，预计还需 ${etaSec}s`;
}

/**
 * 默认执行器：只连本机 forwarder，Host 头钉选分支入口。
 * keepAlive 复用连接，避免几千个短连接把宿主的临时端口耗光（那会误伤别的服务）。
 */
function defaultRequestFn(): LoadTestRequestFn {
  const agent = new Agent({ keepAlive: true, maxSockets: LOADTEST_LIMITS.maxTotalConcurrency + 8 });
  return ({ port, host, path, method, headers, body, timeoutMs, signal }) => new Promise((resolve) => {
    let settled = false;
    // 独立的挂钟死线。http.request 的 timeout 是**socket 空闲**超时：压到一个
    // SSE / 持续分块输出的端点上时，对端每隔几秒发一个字节就能让它永不触发，
    // 而 resp.on('end') 也永远不来 —— 这个 Promise 于是永久挂起，worker 卡在
    // 这里不再检查 run 死线，整个压测占着全局唯一的槽位直到有人手动取消
    // （Codex PR #1273 P2）。挂钟死线与活动无关，到点就拆连接。
    let wallClock: NodeJS.Timeout | null = null;
    const done = (r: { status: number; errorKind?: LoadTestErrorKind; servedBy?: string; servedGroup?: string }): void => {
      if (settled) return;
      settled = true;
      if (wallClock) clearTimeout(wallClock);
      signal.removeEventListener('abort', onAbort);
      resolve(r);
    };
    let req: ReturnType<typeof nodeHttpRequest> | null = null;
    const onAbort = (): void => {
      req?.destroy();
      done({ status: 0, errorKind: 'cancelled' });
    };
    try {
      req = nodeHttpRequest({
        host: '127.0.0.1',
        port,
        method,
        path,
        agent,
        timeout: timeoutMs,
        headers: {
          ...headers,
          Host: host,
          'X-CDS-Loadtest': '1',
          ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
        },
      }, (resp) => {
        const servedBy = resp.headers['x-cds-replica'] ? String(resp.headers['x-cds-replica']) : undefined;
        const servedGroup = resp.headers['x-cds-replica-group'] ? String(resp.headers['x-cds-replica-group']) : undefined;
        resp.resume();
        resp.on('end', () => done({ status: resp.statusCode || 0, servedBy, servedGroup }));
        resp.on('error', () => done({ status: resp.statusCode || 0, errorKind: 'other', servedBy, servedGroup }));
      });
      signal.addEventListener('abort', onAbort, { once: true });
      wallClock = setTimeout(() => { req?.destroy(); done({ status: 0, errorKind: 'timeout' }); }, timeoutMs);
      req.on('timeout', () => { req?.destroy(); done({ status: 0, errorKind: 'timeout' }); });
      req.on('error', (err: NodeJS.ErrnoException) => {
        const kind: LoadTestErrorKind = err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET' || err?.code === 'EHOSTUNREACH'
          ? 'connect'
          : 'other';
        done({ status: 0, errorKind: kind });
      });
      if (body) req.write(body);
      req.end();
    } catch {
      // http.request 同步抛（非法 path 等）不许逃出 executor 变成未处理拒绝
      done({ status: 0, errorKind: 'other' });
    }
  });
}
