/**
 * uptime-monitor — CDS 自建存活监控（Uptime Kuma 风格）的探测器。
 *
 * 背景：用户诉求「生命周期存活功能」——CDS 已经有 auto-lifecycle（运行 N 分钟
 * 后切发布版）和 scheduler（idleTTL 降温）在管分支的**热度**，但没有任何东西
 * 在管分支对外服务的**存活**：服务 502 了、容器起来但端口不通了，面板上仍然
 * 是绿色 running。本服务补上这块：周期探测 + 时序留痕 + 故障事件 + 状态页。
 *
 * 三条必须守住的纪律：
 *
 * 1. **探测绝不能刷新 scheduler 的 lastAccessedAt**。
 *    探测直连 `http://127.0.0.1:<hostPort>`（容器发布到宿主机的端口），
 *    **完全绕开 ProxyService / forwarder**——proxy 每转发一次就会调
 *    `scheduler.touch(slug)`，若探测走预览域名，分支就永远不会被降温，
 *    等于把 idleTTL 废掉。本服务因此**不持有** SchedulerService 引用，
 *    也不写 BranchEntry 的任何字段。回归见
 *    tests/services/uptime-monitor-cycle.test.ts 的「探测不刷新 lastAccessedAt」。
 *
 * 2. **不无限增长**。每个 target 的原始采样是环形缓冲（上限 1440 条 ≈ 24h），
 *    更长的历史靠按天聚合（上限 30 天），故障事件上限 50 条；分支删除后其
 *    target 会在下一轮被清理。落盘走独立文件 `.cds/uptime-monitor.json`，
 *    不进 state.json（避免把控制面状态撑爆）。
 *
 * 3. **可关闭，且能单独关**。`CDS_UPTIME_ENABLED=0` 一刀关停整套；
 *    `CDS_UPTIME_EXCLUDE` 可以只排除个别目标（gRPC / 纯 worker / 只发布 TCP
 *    端口的服务），命中者标「未纳入监控」而不是「故障」。此外，端口开着但
 *    不说 HTTP 的目标会在连续拿到协议层错误后**自动降级**为容器状态判定，
 *    不再永久标红。两条合起来治「非 HTTP 服务被永久误报」，
 *    见 doc/debt.cds.uptime-monitor.md。
 *
 * 纯计算（可用率 / 去抖 / 降采样 / 事件合成）全在 services/uptime-metrics.ts，
 * 本文件只做「发探测 + 编排 + 落盘」。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { BranchEntry, Project } from '../types.js';
import { isTrunkBranch } from './branch-protection.js';
import {
  DEFAULT_BAR_SEGMENTS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_RECOVERY_THRESHOLD,
  MAX_DAILY_ROLLUPS,
  MAX_INCIDENTS_PER_TARGET,
  MAX_SAMPLES_PER_TARGET,
  appendCapped,
  applyDailyRollup,
  applyIncidentTransition,
  availabilityOverRange,
  bucketizeSamples,
  incidentDurationMs,
  nextDebounceState,
  type UptimeDailyRollup,
  type UptimeIncident,
  type UptimeSample,
  type UptimeBucket,
  type UptimeStatus,
} from './uptime-metrics.js';

/** 探测目标：一个分支的一个对外服务。 */
export interface ProbeTarget {
  /** `${branchId}::${profileId}`，URL 里需 encodeURIComponent */
  id: string;
  branchId: string;
  projectId: string;
  profileId: string;
  /** 展示名，如 `feature-x / api` */
  name: string;
  /** 容器发布到宿主机的端口；0 表示没有可探测端口 */
  hostPort: number;
  /** http = 直连宿主机端口；container = 退化为容器状态判定 */
  probeKind: 'http' | 'container';
  /**
   * 本轮是否应该探测。false = 分支被降温 / 未运行 / 正在构建，
   * 这不是故障，记 paused 且不产采样（时间桶留空，前端显示灰段）。
   */
  active: boolean;
  /**
   * 容器是否跑在远端 executor 上。true = 协调端探不到（hostPort 属于那台机器），
   * 一律不纳入监控，避免误判 down 或撞上本机同端口的无关容器报出假绿。
   */
  remoteExecutor?: boolean;
  /** 分支当前状态，供 paused 原因展示 */
  branchStatus: string;
  /** 服务当前状态 */
  serviceStatus: string;
  /** 是否命中排除名单（逃生阀）。true = 不探测、不计故障 */
  excluded: boolean;
  /** 命中的那条排除规则，用于展示「为什么这条没被监控」 */
  excludedBy?: string;
}

/** 单个 target 的持久化状态。 */
export interface UptimeTargetRecord {
  id: string;
  branchId: string;
  projectId: string;
  profileId: string;
  name: string;
  probeKind: 'http' | 'container';
  status: UptimeStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  samples: UptimeSample[];
  daily: UptimeDailyRollup[];
  incidents: UptimeIncident[];
  lastSample: UptimeSample | null;
  /** 最近一次被跳过探测的原因（paused 时展示） */
  pausedReason?: string;
  /** 命中排除名单（逃生阀）：状态页标「未纳入监控」，不进故障统计 */
  excluded?: boolean;
  /** 已自动降级为容器状态判定（端口开着但不说 HTTP） */
  degraded?: boolean;
  /** 降级原因文案，状态页直接展示 */
  degradeReason?: string;
  /** 降级发生时的宿主机端口；重新部署换端口后解除降级、回到 HTTP 探测 */
  degradedHostPort?: number;
  /** 该目标是否曾经成功答过一次 HTTP（答过就说明它本来就是 HTTP 服务，不降级） */
  httpEverUp?: boolean;
  /** 连续协议层失败次数（非 HTTP 响应），达阈值触发降级 */
  protocolFailures?: number;
  firstSeenAt: number;
}

interface UptimeStoreFile {
  version: 1;
  savedAt: number;
  targets: UptimeTargetRecord[];
}

export interface UptimeMonitorConfig {
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  maxSamples: number;
  /**
   * 排除名单（逃生阀）。命中的目标不探测、不计故障，状态页标「未纳入监控」。
   * 每条规则支持 `*` 通配，按下列任一维度匹配（大小写不敏感）：
   *   - 完整目标 id：`proj-feat-a::grpc`
   *   - profile id：`grpc`
   *   - 项目/服务：`proj/grpc`
   *   - 分支 id：`proj-feat-a`
   *   - 展示名：`feat/a / grpc`
   */
  excludePatterns: string[];
  /**
   * 监控范围。默认 `trunk` —— 只盯各项目的主干分支。
   *
   * 为什么默认只看主干：特性分支是「今天开、明天删」的临时物，天然大量处于
   * 降温/构建/已停止态，全量纳入会让状态页变成一屏噪声（生产实测 139 个目标里
   * 103 个是暂停态），真故障反而被淹没。状态页要回答的是「我的服务好不好」，
   * 不是「今天开了多少条分支」。需要全量时设 CDS_UPTIME_SCOPE=all。
   */
  scope: 'trunk' | 'all';
  /** 落盘路径；空串表示只在内存里跑（测试用） */
  storePath: string;
}

/** 监控只需要读分支台账，不需要整个 StateService（也就无从写回 state）。 */
export interface UptimeStateSource {
  getAllBranches(): BranchEntry[];
  /**
   * 查项目（只为判主干：gitDefaultBranch）。可选——不传时 isTrunkBranch
   * 退化为 main/master 字面量兜底，行为仍正确，只是认不出自定义默认分支名。
   */
  getProject?(projectId: string): Project | null | undefined;
}

export type ProbeFn = (target: ProbeTarget, timeoutMs: number) => Promise<Omit<UptimeSample, 't'>>;

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 5_000;
/** 单轮并发探测上限，避免一次 fan-out 打爆 socket。 */
const PROBE_CONCURRENCY = 8;
/** 「应该活着」的服务状态：只有 running 才算承诺对外可用。 */
const LIVE_SERVICE_STATUSES = new Set(['running']);
/** 「应该活着」的分支状态。building / starting / stopping / idle 都算 paused。 */
const LIVE_BRANCH_STATUSES = new Set(['running']);

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

/**
 * 解析排除名单。逗号 / 分号 / 空白 / 换行都算分隔符，空项丢弃。
 * 单独抽出来是为了 CLI 与测试能复用同一份口径。
 */
export function parseExcludePatterns(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 通配规则 → 正则。只支持 `*`，其余字符按字面量转义。 */
function patternToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, (ch) => `\\${ch}`))
    .join('.*');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * 判断一个目标是否命中排除名单，命中则返回那条规则（便于展示原因）。
 * 纯函数，供 selectProbeTargets 与测试共用。
 */
export function matchExcludePattern(
  candidate: { id: string; branchId: string; projectId: string; profileId: string; name: string },
  patterns: ReadonlyArray<string>,
): string | null {
  if (!patterns || patterns.length === 0) return null;
  const fields = [
    candidate.id,
    candidate.profileId,
    candidate.branchId,
    `${candidate.projectId}/${candidate.profileId}`,
    candidate.name,
  ];
  for (const pattern of patterns) {
    const re = patternToRegExp(pattern);
    if (fields.some((field) => re.test(field))) return pattern;
  }
  return null;
}

/** 从环境变量解析配置。所有项都有安全默认，未配置即按默认跑。 */
export function uptimeConfigFromEnv(repoRoot: string): UptimeMonitorConfig {
  return {
    enabled: envFlag('CDS_UPTIME_ENABLED', true),
    excludePatterns: parseExcludePatterns(process.env.CDS_UPTIME_EXCLUDE),
    intervalMs: envInt('CDS_UPTIME_INTERVAL_SECONDS', DEFAULT_INTERVAL_SECONDS, 10, 3600) * 1000,
    timeoutMs: envInt('CDS_UPTIME_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 500, 30_000),
    failureThreshold: envInt('CDS_UPTIME_FAILURE_THRESHOLD', DEFAULT_FAILURE_THRESHOLD, 1, 20),
    recoveryThreshold: envInt('CDS_UPTIME_RECOVERY_THRESHOLD', DEFAULT_RECOVERY_THRESHOLD, 1, 20),
    maxSamples: envInt('CDS_UPTIME_MAX_SAMPLES', MAX_SAMPLES_PER_TARGET, 60, MAX_SAMPLES_PER_TARGET),
    // 默认只监控主干；CDS_UPTIME_SCOPE=all 才纳入全部分支。
    scope: (process.env.CDS_UPTIME_SCOPE || '').trim().toLowerCase() === 'all' ? 'all' : 'trunk',
    storePath: path.join(repoRoot, '.cds', 'uptime-monitor.json'),
  };
}

/**
 * 从分支台账推导本轮探测目标（纯函数，便于测试）。
 *
 * 规则：
 *   - 删除中的分支整个跳过（连 target 都不产，下一轮会被清理）；
 *   - 分支 running + 服务 running + 有 hostPort → active 的 HTTP 探测；
 *   - 分支 running + 服务 running 但没 hostPort → 退化为容器状态探测；
 *   - 命中排除名单 → active=false 且 excluded=true（未纳入监控，不是故障）；
 *   - 其余（降温 / 构建中 / 已停止）→ active=false，记 paused 不记故障。
 */
export function selectProbeTargets(
  branches: ReadonlyArray<BranchEntry>,
  excludePatterns: ReadonlyArray<string> = [],
  options: {
    scope?: 'trunk' | 'all';
    getProject?: (projectId: string) => Project | null | undefined;
  } = {},
): ProbeTarget[] {
  const scope = options.scope ?? 'trunk';
  const targets: ProbeTarget[] = [];
  for (const branch of branches) {
    if (!branch || branch.deleting) continue;
    // 非主干分支在 trunk 范围下**根本不产 target**（而不是产一个 paused 的），
    // 否则状态页仍要滚过上百条灰条才看得到主干——那等于没收窄。
    if (scope === 'trunk' && !isTrunkBranch(branch, options.getProject?.(branch.projectId))) continue;
    const services = branch.services || {};
    for (const profileId of Object.keys(services).sort()) {
      const svc = services[profileId];
      if (!svc) continue;
      const branchLive = LIVE_BRANCH_STATUSES.has(branch.status);
      const serviceLive = LIVE_SERVICE_STATUSES.has(svc.status);
      const hostPort = typeof svc.hostPort === 'number' && svc.hostPort > 0 ? svc.hostPort : 0;
      const id = `${branch.id}::${profileId}`;
      const name = `${branch.branch || branch.id} / ${profileId}`;
      const excludedBy = matchExcludePattern(
        { id, branchId: branch.id, projectId: branch.projectId, profileId, name },
        excludePatterns,
      );
      // 集群：分支容器跑在远端 executor 上时，hostPort 是**那台机器**的端口，
      // 协调端的 127.0.0.1:<hostPort> 根本不是同一个服务。轻则常年误判 down，
      // 重则撞上协调端某个复用同一端口的无关容器、把它的健康当成本服务的健康
      // （假绿比假红更危险）。在补上分布式探测之前，远端 executor 拥有的分支
      // 一律不纳入监控，而不是用错误的地址去探（Codex PR #1273 P1）。
      const remoteExecutor = Boolean(branch.executorId && branch.executorId !== 'embedded');
      const active = branchLive && serviceLive && !excludedBy && !remoteExecutor;
      targets.push({
        id,
        branchId: branch.id,
        projectId: branch.projectId,
        profileId,
        name,
        hostPort,
        probeKind: hostPort > 0 ? 'http' : 'container',
        active,
        branchStatus: branch.status,
        serviceStatus: svc.status,
        excluded: Boolean(excludedBy),
        excludedBy: excludedBy || undefined,
        remoteExecutor: remoteExecutor || undefined,
      });
    }
  }
  return targets;
}

/** paused 原因的人话文案（前端直接展示）。 */
export function pausedReasonOf(target: ProbeTarget): string {
  if (target.excluded) {
    return `未纳入监控（命中排除规则 ${target.excludedBy}，可在 CDS_UPTIME_EXCLUDE 里移除）`;
  }
  if (target.remoteExecutor) {
    return '未纳入监控（容器在远端 executor，协调端探不到其宿主端口）';
  }
  if (!LIVE_BRANCH_STATUSES.has(target.branchStatus)) {
    if (target.branchStatus === 'idle') return '分支已降温（调度器空闲回收），不计入故障';
    return `分支状态 ${target.branchStatus}，暂不探测`;
  }
  return `服务状态 ${target.serviceStatus}，暂不探测`;
}

/**
 * 默认 HTTP 探测：直连 `127.0.0.1:<hostPort>`。
 *
 * 判定口径：拿到任何 < 500 的响应都算存活（401/404 说明进程在应答，
 * 只是没有那个路由）；5xx / 连接失败 / 超时算故障。
 */
export const defaultHttpProbe: ProbeFn = async (target, timeoutMs) => {
  if (target.hostPort <= 0) {
    // 退化路径：没有宿主机端口时，只能用调用方给的容器状态判定。
    const up = target.serviceStatus === 'running';
    return { up, ms: 0, err: up ? undefined : `容器状态 ${target.serviceStatus}` };
  }
  const startedAt = Date.now();
  return await new Promise<Omit<UptimeSample, 't'>>((resolve) => {
    let settled = false;
    const finish = (result: Omit<UptimeSample, 't'>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port: target.hostPort,
        path: '/',
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'user-agent': 'cds-uptime-monitor', 'x-cds-poll': 'true' },
      },
      (res) => {
        const code = res.statusCode || 0;
        // 拿到响应头就够了——存活判定只看状态码。**绝不能等 'end'**：
        // 若被探服务的根路径是 SSE / 持续分块输出，body 永远不结束，而
        // req 的 timeout 是 socket 空闲超时，对端定期发块就让它永不触发。
        // 那样这个 Promise 永久挂起，runCycle 的 cycleRunning 重入锁再也不解开，
        // **此后所有监控轮次全部被跳过**——整个存活监控静默死掉
        // （Codex PR #1273 P2）。所以拿到头立刻结算并拆连接。
        finish({
          up: code > 0 && code < 500,
          ms: Date.now() - startedAt,
          code,
          err: code >= 500 ? `HTTP ${code}` : undefined,
        });
        res.destroy();
      },
    );
    req.on('timeout', () => {
      req.destroy();
      finish({ up: false, ms: Date.now() - startedAt, err: `探测超时（${timeoutMs}ms）` });
    });
    req.on('error', (err) => {
      finish({ up: false, ms: Date.now() - startedAt, err: (err as Error).message });
    });
    req.end();
  });
};


/** 一天的毫秒数（按天聚合与 range 判定共用）。 */
const DAY_MS = 24 * 3600 * 1000;

/**
 * 用按天聚合铺出跨天时序：一天一个桶，覆盖整个 range，缺的那天给 status='none'。
 * 与 bucketizeSamples 返回同一种 UptimeBucket，前端无需分支。
 */
function dailyRollupPoints(record: UptimeTargetRecord, fromMs: number, toMs: number): UptimeBucket[] {
  const byDay = new Map(record.daily.map((d) => [d.day, d]));
  const points: UptimeBucket[] = [];
  const startDay = Math.floor(fromMs / DAY_MS);
  const endDay = Math.floor(toMs / DAY_MS);
  for (let d = startDay; d <= endDay; d++) {
    const from = d * DAY_MS;
    const to = Math.min(toMs, from + DAY_MS);
    const key = new Date(from).toISOString().slice(0, 10);
    const roll = byDay.get(key);
    if (!roll || (roll.up === 0 && roll.down === 0)) {
      points.push({ from, to, up: 0, down: 0, avgLatencyMs: null, status: 'none' });
      continue;
    }
    points.push({
      from,
      to,
      up: roll.up,
      down: roll.down,
      avgLatencyMs: roll.msCount > 0 ? Math.round(roll.sumMs / roll.msCount) : null,
      status: roll.down === 0 ? 'up' : roll.up === 0 ? 'down' : 'partial',
    });
  }
  return points;
}

/** 探测失败的分类。降级只认 protocol，unreachable 是真故障不许吞。 */
export type ProbeFailureKind = 'none' | 'http-status' | 'protocol' | 'unreachable';

/** 命中即认定「对面开着端口但不说 HTTP」（gRPC / 裸 TCP / TLS-only）。 */
const PROTOCOL_ERROR_PATTERNS = [
  /parse error/i,
  /hpe_/i,
  /socket hang up/i,
  /econnreset/i,
  /epipe/i,
  /invalid (http|response)/i,
  /wrong version number/i,
  /eproto/i,
];

/**
 * 判定一次失败采样属于哪一层错误（纯函数）。
 *
 *   - 拿到 HTTP 状态码 → 对面在说 HTTP，只是这次 5xx，属于真故障；
 *   - 连接被重置 / 响应解析失败 / 非 HTTP 响应 → 协议层，可能压根不是 HTTP 服务；
 *   - 连接被拒 / 超时 / 主机不可达 → 端口没人听，是真故障，绝不降级。
 */
export function classifyProbeFailure(sample: Pick<UptimeSample, 'up' | 'code' | 'err'>): ProbeFailureKind {
  if (sample.up) return 'none';
  if (typeof sample.code === 'number' && sample.code > 0) return 'http-status';
  const err = sample.err || '';
  if (PROTOCOL_ERROR_PATTERNS.some((re) => re.test(err))) return 'protocol';
  return 'unreachable';
}

/**
 * 状态页的展示优先级：故障 > 待确认 > 正常 > 已暂停 > 已排除。
 *
 * 为什么不按名字排：生产上 145 个目标里有 100+ 是「分支已降温 / error，暂不探测」的
 * 暂停态（柱条全空、可用率无数据）。纯字母序会让这批空行霸占首屏（chore/archive-* 打头），
 * 用户要滚过几十条空条才看得到真正在跑的服务——首屏必须留给「值得看的东西」
 * （content-fills-canvas：主产物占视觉主导）。同档内仍按名字排，保证顺序稳定可预期。
 */
const DISPLAY_RANK: Record<string, number> = { down: 0, unknown: 1, up: 2, paused: 3 };

export function compareTargetsForDisplay(
  a: Pick<UptimeTargetRecord, 'name' | 'status' | 'excluded'>,
  b: Pick<UptimeTargetRecord, 'name' | 'status' | 'excluded'>,
): number {
  // 已排除的目标不参与故障判定，一律沉底。
  const rank = (t: Pick<UptimeTargetRecord, 'status' | 'excluded'>) =>
    t.excluded ? 4 : (DISPLAY_RANK[t.status] ?? 1);
  const diff = rank(a) - rank(b);
  return diff !== 0 ? diff : a.name.localeCompare(b.name);
}

function emptyRecord(target: ProbeTarget, now: number): UptimeTargetRecord {
  return {
    id: target.id,
    branchId: target.branchId,
    projectId: target.projectId,
    profileId: target.profileId,
    name: target.name,
    probeKind: target.probeKind,
    status: 'unknown',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    samples: [],
    daily: [],
    incidents: [],
    lastSample: null,
    firstSeenAt: now,
  };
}

/** 对外摘要里的单个 target。 */
export interface UptimeTargetSummary {
  id: string;
  name: string;
  branchId: string;
  projectId: string;
  profileId: string;
  probeKind: 'http' | 'container';
  status: UptimeStatus;
  pausedReason?: string;
  /** 命中排除名单：状态页标「未纳入监控」，不参与故障统计 */
  excluded: boolean;
  /** 已自动降级为容器状态判定 */
  degraded: boolean;
  /** 降级原因（degraded=true 时有） */
  degradeReason?: string;
  lastSample: UptimeSample | null;
  availability24h: number | null;
  availability7d: number | null;
  avgLatencyMs24h: number | null;
  sampleCount24h: number;
  buckets: ReturnType<typeof bucketizeSamples>;
  openIncidentSince: number | null;
}

export interface UptimeSummary {
  enabled: boolean;
  generatedAt: number;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  /** 首批数据预计出现的等待秒数（= 一个探测间隔），给空状态文案用 */
  firstDataEtaSeconds: number;
  lastCycleAt: number | null;
  /** 当前生效的排除规则（逃生阀），状态页据此说明「为什么少了几条」 */
  excludePatterns: string[];
  overall: {
    total: number;
    up: number;
    down: number;
    paused: number;
    unknown: number;
    /** 未纳入监控的目标数（命中排除名单），与 paused 分开计 */
    excluded: number;
    ok: boolean;
  };
  targets: UptimeTargetSummary[];
}

export interface UptimeIncidentView extends UptimeIncident {
  targetName: string;
  branchId: string;
  projectId: string;
  durationMs: number;
  ongoing: boolean;
}

export class UptimeMonitorService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private records = new Map<string, UptimeTargetRecord>();
  private lastCycleAt: number | null = null;
  private cycleRunning = false;

  constructor(
    private readonly deps: {
      state: UptimeStateSource;
      config: UptimeMonitorConfig;
      probe?: ProbeFn;
      now?: () => number;
      logger?: { warn?: (m: string) => void; info?: (m: string) => void };
    },
  ) {
    this.load();
  }

  get config(): UptimeMonitorConfig {
    return this.deps.config;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** 启动周期探测。配置关闭时是 no-op（可关闭是硬要求）。 */
  start(): void {
    if (!this.deps.config.enabled) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runCycle().catch((err) => {
        this.deps.logger?.warn?.(`[uptime] 探测轮次失败: ${(err as Error).message}`);
      });
    }, this.deps.config.intervalMs);
    this.timer.unref?.();
    // 立即跑一轮，避免刚启动的前 60s 完全没有数据。
    void this.runCycle().catch((err) => {
      this.deps.logger?.warn?.(`[uptime] 首轮探测失败: ${(err as Error).message}`);
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.persist();
  }

  /**
   * 跑一轮探测。重入保护：上一轮没结束就直接跳过本轮（超时 5s × 并发 8，
   * 正常远快于 60s 间隔；真堵住时也不能叠加 fan-out）。
   */
  async runCycle(): Promise<void> {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    try {
      const now = this.now();
      const targets = selectProbeTargets(
        this.deps.state.getAllBranches(),
        this.deps.config.excludePatterns || [],
        {
          scope: this.deps.config.scope ?? 'trunk',
          getProject: this.deps.state.getProject?.bind(this.deps.state),
        },
      );
      const liveIds = new Set(targets.map((t) => t.id));

      // 分支删除 / profile 移除后清掉台账，防止 records 无限增长。
      for (const id of [...this.records.keys()]) {
        if (!liveIds.has(id)) this.records.delete(id);
      }

      const activeTargets: ProbeTarget[] = [];
      for (const rawTarget of targets) {
        const record = this.records.get(rawTarget.id) || emptyRecord(rawTarget, now);
        // 已降级的目标改按容器状态判定：hostPort 归零让默认探测走退化路径。
        // 分支重新部署换了端口 → 视为新容器，解除降级重新试 HTTP。
        if (record.degraded && record.degradedHostPort !== rawTarget.hostPort) {
          record.degraded = false;
          record.degradeReason = undefined;
          record.degradedHostPort = undefined;
          record.protocolFailures = 0;
        }
        const target: ProbeTarget = record.degraded
          ? { ...rawTarget, probeKind: 'container', hostPort: 0 }
          : rawTarget;
        record.name = target.name;
        record.probeKind = target.probeKind;
        record.projectId = target.projectId;
        record.excluded = target.excluded;
        this.records.set(target.id, record);
        if (target.active) {
          activeTargets.push(target);
          continue;
        }
        // 暂停：不产采样（时间桶留空），并把仍开着的故障事件就地收尾，
        // 否则一个被手动停掉的分支、或刚被加进排除名单的非 HTTP 服务，
        // 会留下一条永不结束的 incident。
        record.status = 'paused';
        record.pausedReason = pausedReasonOf(target);
        record.consecutiveFailures = 0;
        record.consecutiveSuccesses = 0;
        applyIncidentTransition(record.incidents, 'to-up', { targetId: target.id, at: now });
      }

      const probe = this.deps.probe || defaultHttpProbe;
      for (let i = 0; i < activeTargets.length; i += PROBE_CONCURRENCY) {
        const chunk = activeTargets.slice(i, i + PROBE_CONCURRENCY);
        const results = await Promise.all(chunk.map(async (target) => {
          try {
            return { target, outcome: await probe(target, this.deps.config.timeoutMs), thrown: false };
          } catch (err) {
            // 探测器自身抛异常属于内部故障，不是「对面不说 HTTP」的证据，
            // 因此不参与自动降级判定，照常记一次失败。
            return {
              target,
              outcome: { up: false, ms: 0, err: (err as Error).message } as Omit<UptimeSample, 't'>,
              thrown: true,
            };
          }
        }));
        for (const { target, outcome, thrown } of results) {
          this.applySample(target, { ...outcome, t: this.now() }, { allowDegrade: !thrown });
        }
      }

      this.lastCycleAt = now;
      this.persist();
    } finally {
      this.cycleRunning = false;
    }
  }

  private applySample(
    target: ProbeTarget,
    rawSample: UptimeSample,
    options: { allowDegrade: boolean } = { allowDegrade: true },
  ): void {
    const record = this.records.get(target.id);
    if (!record) return;
    const sample = options.allowDegrade ? this.maybeDegrade(target, record, rawSample) : rawSample;
    appendCapped(record.samples, sample, this.deps.config.maxSamples);
    applyDailyRollup(record.daily, sample, MAX_DAILY_ROLLUPS);
    record.lastSample = sample;
    record.pausedReason = undefined;

    const next = nextDebounceState(
      {
        // paused 之后重新开跑时不带旧状态惯性，从 unknown 起算。
        status: record.status === 'paused' ? 'unknown' : record.status,
        consecutiveFailures: record.consecutiveFailures,
        consecutiveSuccesses: record.consecutiveSuccesses,
      },
      sample,
      {
        failureThreshold: this.deps.config.failureThreshold,
        recoveryThreshold: this.deps.config.recoveryThreshold,
      },
    );
    record.status = next.status;
    record.consecutiveFailures = next.consecutiveFailures;
    record.consecutiveSuccesses = next.consecutiveSuccesses;
    applyIncidentTransition(record.incidents, next.transition, {
      targetId: target.id,
      at: sample.t,
      cause: sample.err || (sample.code ? `HTTP ${sample.code}` : '探测连续失败'),
    }, MAX_INCIDENTS_PER_TARGET);
  }

  /**
   * 自动降级闸：端口开着但不说 HTTP 的服务（gRPC / 裸 TCP / 只跑 worker 的
   * 端口占位）会连续拿到协议层错误。这类目标若一直按 HTTP 判定，就会被永久
   * 标故障、合成一条永不结束的 incident，把真故障淹掉——比没有状态页更糟。
   *
   * 判据卡得很死，避免把真故障吞掉：
   *   1. 只认协议层错误（连接被重置 / 响应解析失败 / 非 HTTP 响应）；
   *      连接被拒、超时、5xx 一律不降级；
   *   2. 该目标**从未**成功答过一次 HTTP（答过说明它本来就是 HTTP 服务，
   *      现在答不上就是真出事了）；
   *   3. 连续次数达到 failureThreshold，与判故障同一把尺子。
   *
   * 触发时把当次采样改判为容器状态结果，故障事件因此压根不会开出来。
   */
  private maybeDegrade(target: ProbeTarget, record: UptimeTargetRecord, sample: UptimeSample): UptimeSample {
    if (sample.up) {
      record.protocolFailures = 0;
      if (target.probeKind === 'http') record.httpEverUp = true;
      return sample;
    }
    if (record.degraded || target.probeKind !== 'http' || record.httpEverUp) return sample;
    if (classifyProbeFailure(sample) !== 'protocol') {
      record.protocolFailures = 0;
      return sample;
    }
    record.protocolFailures = (record.protocolFailures || 0) + 1;
    if (record.protocolFailures < this.deps.config.failureThreshold) return sample;

    record.degraded = true;
    record.degradedHostPort = target.hostPort;
    record.probeKind = 'container';
    record.degradeReason = `端口 ${target.hostPort} 连续 ${record.protocolFailures} 次返回非 HTTP 响应`
      + `（${sample.err || '协议错误'}），已自动改为按容器状态判定`;
    this.deps.logger?.info?.(`[uptime] ${target.name} ${record.degradeReason}`);
    const up = target.serviceStatus === 'running';
    return { t: sample.t, up, ms: 0, err: up ? undefined : `容器状态 ${target.serviceStatus}` };
  }

  /** 全量摘要：状态页一次请求就能画完（含 90 段柱条）。 */
  getSummary(barSegments: number = DEFAULT_BAR_SEGMENTS): UptimeSummary {
    // 排序口径见 compareTargetsForDisplay：先按「值不值得看」，同档内才按名字。
    const now = this.now();
    const dayMs = 24 * 3600 * 1000;
    const targets: UptimeTargetSummary[] = [];
    let up = 0;
    let down = 0;
    let paused = 0;
    let unknown = 0;
    let excluded = 0;

    for (const record of [...this.records.values()].sort(compareTargetsForDisplay)) {
      const a24 = availabilityOverRange(record, dayMs, now);
      const a7 = availabilityOverRange(record, 7 * dayMs, now);
      const open = record.incidents.find((i) => i.endedAt === null) || null;
      if (record.excluded) excluded += 1;
      else if (record.status === 'up') up += 1;
      else if (record.status === 'down') down += 1;
      else if (record.status === 'paused') paused += 1;
      else unknown += 1;
      targets.push({
        id: record.id,
        name: record.name,
        branchId: record.branchId,
        projectId: record.projectId,
        profileId: record.profileId,
        probeKind: record.probeKind,
        status: record.status,
        pausedReason: record.pausedReason,
        excluded: Boolean(record.excluded),
        degraded: Boolean(record.degraded),
        degradeReason: record.degradeReason,
        lastSample: record.lastSample,
        availability24h: a24.ratio,
        availability7d: a7.ratio,
        avgLatencyMs24h: a24.avgLatencyMs,
        sampleCount24h: a24.upCount + a24.downCount,
        buckets: bucketizeSamples(record.samples, now - dayMs, now, barSegments),
        openIncidentSince: open ? open.startedAt : null,
      });
    }

    return {
      enabled: this.deps.config.enabled,
      generatedAt: now,
      intervalSeconds: Math.round(this.deps.config.intervalMs / 1000),
      timeoutMs: this.deps.config.timeoutMs,
      failureThreshold: this.deps.config.failureThreshold,
      firstDataEtaSeconds: Math.round(this.deps.config.intervalMs / 1000),
      lastCycleAt: this.lastCycleAt,
      excludePatterns: [...(this.deps.config.excludePatterns || [])],
      overall: { total: targets.length, up, down, paused, unknown, excluded, ok: down === 0 },
      targets,
    };
  }

  /** 单 target 时序（已降采样到固定桶数）。 */
  getHistory(targetId: string, rangeMs: number, bucketCount: number): {
    id: string;
    name: string;
    from: number;
    to: number;
    bucketCount: number;
    points: ReturnType<typeof bucketizeSamples>;
  } | null {
    const record = this.records.get(targetId);
    if (!record) return null;
    const now = this.now();
    const from = now - rangeMs;
    // 原始采样只留约 24 小时（环形缓冲），更早的历史在按天聚合里。跨天的 range
    // 若只 bucketize samples，7d/30d 会返回一整片空桶——看着像「那几天没监控」，
    // 实际是数据在另一个字段里（Codex PR #1273 P2）。
    // 判据只看 range 本身，不看当前采样跨度：刚起的监控只有几分钟采样，若按
    // 「range 超过采样跨度」判，24h 也会被推去走按天聚合，退化成一天一个点。
    const needsRollup = rangeMs > DAY_MS;
    const points = needsRollup
      ? dailyRollupPoints(record, from, now)
      : bucketizeSamples(record.samples, from, now, bucketCount);
    return { id: record.id, name: record.name, from, to: now, bucketCount: points.length, points };
  }

  /** 全局故障事件时间线，最近的在前。 */
  getIncidents(limit = 50): UptimeIncidentView[] {
    const now = this.now();
    const rows: UptimeIncidentView[] = [];
    for (const record of this.records.values()) {
      for (const incident of record.incidents) {
        rows.push({
          ...incident,
          targetName: record.name,
          branchId: record.branchId,
          projectId: record.projectId,
          durationMs: incidentDurationMs(incident, now),
          ongoing: incident.endedAt === null,
        });
      }
    }
    rows.sort((a, b) => b.startedAt - a.startedAt);
    return rows.slice(0, Math.min(Math.max(1, limit), 200));
  }

  /** 测试/诊断用：读取内部台账。 */
  getRecord(targetId: string): UptimeTargetRecord | undefined {
    return this.records.get(targetId);
  }

  // ── 持久化：独立文件 + 原子写，失败静默（监控不能拖垮主流程） ──

  private load(): void {
    const fp = this.deps.config.storePath;
    if (!fp) return;
    try {
      if (!fs.existsSync(fp)) return;
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as UptimeStoreFile;
      if (!parsed || !Array.isArray(parsed.targets)) return;
      for (const record of parsed.targets) {
        if (!record || typeof record.id !== 'string') continue;
        record.samples = Array.isArray(record.samples) ? record.samples.slice(-this.deps.config.maxSamples) : [];
        record.daily = Array.isArray(record.daily) ? record.daily.slice(-MAX_DAILY_ROLLUPS) : [];
        record.incidents = Array.isArray(record.incidents) ? record.incidents.slice(-MAX_INCIDENTS_PER_TARGET) : [];
        this.records.set(record.id, record);
      }
    } catch (err) {
      this.deps.logger?.warn?.(`[uptime] 读取历史失败，从空台账开始: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    const fp = this.deps.config.storePath;
    if (!fp) return;
    const payload: UptimeStoreFile = {
      version: 1,
      savedAt: this.now(),
      targets: [...this.records.values()],
    };
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const tmp = `${fp}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, fp);
    } catch (err) {
      this.deps.logger?.warn?.(`[uptime] 落盘失败（仅内存保留）: ${(err as Error).message}`);
    }
  }
}
