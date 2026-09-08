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
 *    见 doc/debt.cds.md「CDS 存活监控（uptime-monitor）」。
 *
 * 纯计算（可用率 / 去抖 / 降采样 / 事件合成）全在 services/uptime-metrics.ts，
 * 本文件只做「发探测 + 编排 + 落盘」。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { BranchEntry, Project, ReleaseRun, ReleaseTarget, UptimeCustomMonitor } from '../types.js';
import {
  CUSTOM_PROBE_ID_PREFIX,
  customProbeTargetId,
  describeMonitorProbe,
  probeCustomMonitor,
} from './uptime-custom-monitor.js';
// 故障归因到发布的时间窗判定只有这一处，发布中心将来要展示同款关联必须复用它。
import { linkIncidentToRelease, releaseIncidentLinkWindowMs } from './release-incident-link.js';
import { isTrunkBranch } from './branch-protection.js';
import { isRemoteExecutorOwned } from './executor-ownership.js';
import {
  RELEASE_PROBE_ID_PREFIX,
  isReleaseTargetProbeable,
  releaseProbeSkipReason,
  releaseProbeTargetId,
  releaseProbeUrl,
} from './release-probe-target.js';
// 生产目标的探测必须与发布中心预检用同一个 HTTP 判定函数：两处各写一遍的结局是
// 「预检说健康、状态页说宕机」（或反过来），用户无从判断该信哪个。
import { probeHealthcheckStatus } from './release-service.js';
import { probeRequestHeaders } from './probe-marker.js';
import {
  DEFAULT_BAR_SEGMENTS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_RECOVERY_THRESHOLD,
  MAX_DAILY_ROLLUPS,
  MAX_INCIDENTS_PER_TARGET,
  MAX_SAMPLES_HARD_CEILING,
  samplesForDayAtInterval,
  appendCapped,
  applyDailyRollup,
  applyIncidentTransition,
  availabilityOverRange,
  calendarDayWindow,
  bucketizeSamples,
  incidentDurationMs,
  nextDebounceState,
  type UptimeDailyRollup,
  type UptimeIncident,
  type UptimeSample,
  type UptimeBucket,
  type UptimeStatus,
} from './uptime-metrics.js';

/**
 * 探测方式。`url` 是生产发布目标专用：它在 CDS 这边**没有容器、没有宿主端口**，
 * 唯一可信的存活信号就是打它自己的 healthcheckUrl。绝不能把它并进 http/container
 * 二分里——container 分支读的是 serviceStatus（控制面意图），生产站点整站挂掉时
 * 那个值仍是「enabled」，状态页会全绿。
 */
export type ProbeKind = 'http' | 'container' | 'url' | 'keyword' | 'tcp';

/**
 * 目标来源：分支预览服务（系统从分支台账推导）/ 生产发布目标（从发布中心推导）/
 * 自定义监控（人在监控中心手动添加）。这是状态页分组、可用率含义与操作权限的
 * 分界线——probeKind 只说「怎么探」，source 说「这是谁的承诺」。
 */
export type ProbeSource = 'branch' | 'release' | 'custom';

/** 从记录 id 反推来源。三类前缀在结构上互斥（见各自 *_PROBE_ID_PREFIX 注释）。 */
export function probeSourceOfId(id: string): ProbeSource {
  if (id.startsWith(RELEASE_PROBE_ID_PREFIX)) return 'release';
  if (id.startsWith(CUSTOM_PROBE_ID_PREFIX)) return 'custom';
  return 'branch';
}

/** 探测目标：一个分支的一个对外服务，或一个生产发布目标。 */
export interface ProbeTarget {
  /** 分支目标为 `${branchId}::${profileId}`，发布目标为 `release@${targetId}`，自定义为 `monitor@${id}`；URL 里需 encodeURIComponent */
  id: string;
  source: ProbeSource;
  branchId: string;
  projectId: string;
  profileId: string;
  /** 展示名，如 `feature-x / api`、`生产 / 官网` */
  name: string;
  /** 容器发布到宿主机的端口；0 表示没有可探测端口（url 型恒为 0） */
  hostPort: number;
  /** http = 直连宿主机端口；container = 退化为容器状态判定；url = 打发布目标的上线地址 */
  probeKind: ProbeKind;
  /** url 型的探测地址（发布目标的 healthcheckUrl） */
  url?: string;
  /** url 型不可探测时的人话原因，来自 release-probe-target 这一个判定源 */
  releaseSkipReason?: string;
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
  /** 自定义监控的定义（探测实现按它分派）；其它来源为空 */
  monitor?: UptimeCustomMonitor;
  /** 自定义监控自己的间隔（毫秒）；缺省跟随全局。只能比全局慢，不能更快 */
  intervalMs?: number;
  /** 自定义监控自己的超时（毫秒）；缺省跟随全局 */
  timeoutMs?: number;
  /** 一句人话描述探测方式（详情页展示） */
  probeDescription?: string;
  /** 分支目标：git 分支名 / 项目显示名 / 最近访问时间（监控中心分支汇总与模态窗用） */
  branchName?: string;
  projectName?: string;
  branchLastActiveAt?: string;
  /**
   * 分支目标的「用户视角」探测地址（预览域名）。有它才会做第二判定：
   * 经 forwarder / TLS / 路由整条链路，与真人打开预览是同一条路。
   */
  userViewUrl?: string;
}

/**
 * 用户视角探测的落盘状态（挂在分支目标的台账上）。
 *
 * 与进程视角分开记：进程视角说「容器里的进程在应答」，用户视角说「从预览域名进去
 * 真的能到」。两者都对才算正常；用户视角失败会折进主采样判故障（原因写明是用户视角），
 * 但探测器自己够不着预览域名（DNS / 连接失败）不算故障——那是探测器的问题，
 * 单独标 unreachable，不许把它变成一屏假红。
 */
export interface UserViewState {
  url: string;
  /** 只按最近一次结果给：up / down / unknown（未探过） */
  status: UptimeStatus;
  lastSample: UptimeSample | null;
  /** 探测器够不着预览域名（不是用户视角故障） */
  unreachable?: boolean;
}

/** 单个 target 的持久化状态。 */
/**
 * 存活翻转事件（上 cds-events-bus 用）。事件名与 CdsEventType 一一对应，
 * 由接线方转发——本模块不 import 总线（见构造参数 onAlert 的注释）。
 */
export type UptimeAlertEventType = 'uptime.target.down' | 'uptime.target.recovered';

export interface UptimeAlertEventData {
  targetId: string;
  projectId: string;
  branchId: string;
  /** 站内信渲染直接用它当主语，字段名与发布漂移事件对齐（targetName）。 */
  targetName: string;
  probeKind: ProbeKind;
  probeUrl?: string;
  message: string;
  consecutiveFailures: number;
  detectedAt: string;
}

export interface UptimeTargetRecord {
  id: string;
  /** 旧台账可缺省，load 时按 id 前缀回填 */
  source?: ProbeSource;
  branchId: string;
  projectId: string;
  profileId: string;
  name: string;
  probeKind: ProbeKind;
  /** url 型：本目标探的是哪个地址（状态页展示，便于确认探的是不是线上） */
  probeUrl?: string;
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
  /** 探测方式的人话描述（自定义监控由定义派生，其它来源按 probeKind 兜底） */
  probeDescription?: string;
  /** 本目标实际生效的探测间隔（毫秒） */
  intervalMs?: number;
  /** 本目标实际生效的超时（毫秒） */
  timeoutMs?: number;
  branchName?: string;
  projectName?: string;
  branchStatus?: string;
  branchLastActiveAt?: string;
  /** 分支目标的用户视角判定 */
  userView?: UserViewState;
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
   * 监控范围。默认 `all`（2026-09-08 监控中心重做起）——全部分支都探。
   *
   * 此前默认只看主干，理由是特性分支大量处于降温态、全量纳入会把状态页变成一屏噪声。
   * 重做后主列表只展示主站（生产目标 + 自定义监控），分支按项目折成一条汇总行、
   * 点开模态窗才看明细，噪声问题在展示层解决，探测面就不必再缩。
   * 仍可设 CDS_UPTIME_SCOPE=trunk 收窄到主干。
   */
  scope: 'trunk' | 'all';
  /**
   * 分支目标是否做「用户视角」第二判定（`CDS_UPTIME_USER_VIEW`，默认开）。
   * 经预览域名整条链路探，带进程级探测令牌，代理侧不刷新 LRU。
   */
  userViewEnabled?: boolean;
  /**
   * 是否把生产发布目标纳入探测（`CDS_UPTIME_RELEASE_ENABLED`，默认开）。
   *
   * 逃生阀存在的理由：这一档把探测从「只打本机 127.0.0.1」变成「常态每
   * intervalMs 对生产站点发一次外呼」。真出现被探端限流、计费、WAF 拦截时，
   * 必须能只关这一类而不牵连分支监控。可选字段——不传即视为开启，避免既有
   * 30+ 处 config 字面量全部要改。
   */
  releaseTargetsEnabled?: boolean;
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
  /**
   * 读生产发布目标。可选——不接线时监控只盯分支，与本功能上线前行为一致。
   */
  getReleaseTargets?(): ReleaseTarget[];
  /**
   * 读某个发布目标的发布记录，用于把新开的故障归因到「哪次发布引入的」。
   * 可选——不接线就退化成无归因（incident 照常开，只是不带 releaseId），
   * 绝不因为少接一行而报错或漏掉故障本身。
   */
  getReleaseRuns?(targetId: string): ReleaseRun[];
  /**
   * 读监控中心的自定义探测目标。可选——不接线时监控中心只有系统推导的两类目标，
   * 「添加监控」保存了也永远不会被探（守卫测试盯着 index.ts 的这行接线）。
   */
  getUptimeMonitors?(): UptimeCustomMonitor[];
  /**
   * 分支的预览地址（用户视角探测用）。可选——不接线就没有用户视角判定，
   * 分支目标只有进程视角。
   */
  getPreviewUrl?(branch: BranchEntry): string;
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
  // 空字段必须剔除：发布目标没有 branchId（恒为空串），留着会让 `*` 之外的
  // 空白规则意外命中，把一个正常的生产目标静默排除出监控。
  const fields = [
    candidate.id,
    candidate.profileId,
    candidate.branchId,
    `${candidate.projectId}/${candidate.profileId}`,
    candidate.name,
  ].filter((field) => field.length > 0);
  for (const pattern of patterns) {
    const re = patternToRegExp(pattern);
    if (fields.some((field) => re.test(field))) return pattern;
  }
  return null;
}

/** 从环境变量解析配置。所有项都有安全默认，未配置即按默认跑。 */
export function uptimeConfigFromEnv(repoRoot: string): UptimeMonitorConfig {
  const intervalMs = envInt('CDS_UPTIME_INTERVAL_SECONDS', DEFAULT_INTERVAL_SECONDS, 10, 3600) * 1000;
  return {
    enabled: envFlag('CDS_UPTIME_ENABLED', true),
    excludePatterns: parseExcludePatterns(process.env.CDS_UPTIME_EXCLUDE),
    intervalMs,
    timeoutMs: envInt('CDS_UPTIME_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 500, 30_000),
    failureThreshold: envInt('CDS_UPTIME_FAILURE_THRESHOLD', DEFAULT_FAILURE_THRESHOLD, 1, 20),
    recoveryThreshold: envInt('CDS_UPTIME_RECOVERY_THRESHOLD', DEFAULT_RECOVERY_THRESHOLD, 1, 20),
    // 容量按实际间隔推导，保证任何支持的间隔都真的覆盖住对外宣称的 24 小时。
    maxSamples: envInt(
      'CDS_UPTIME_MAX_SAMPLES',
      samplesForDayAtInterval(intervalMs),
      60,
      MAX_SAMPLES_HARD_CEILING,
    ),
    // 默认全部分支都探（展示层折叠）；CDS_UPTIME_SCOPE=trunk 收窄到主干。
    scope: (process.env.CDS_UPTIME_SCOPE || '').trim().toLowerCase() === 'trunk' ? 'trunk' : 'all',
    userViewEnabled: envFlag('CDS_UPTIME_USER_VIEW', true),
    releaseTargetsEnabled: envFlag('CDS_UPTIME_RELEASE_ENABLED', true),
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
    getPreviewUrl?: (branch: BranchEntry) => string;
  } = {},
): ProbeTarget[] {
  const scope = options.scope ?? 'all';
  const targets: ProbeTarget[] = [];
  for (const branch of branches) {
    if (!branch || branch.deleting) continue;
    const project = options.getProject?.(branch.projectId);
    // 非主干分支在 trunk 范围下**根本不产 target**（而不是产一个 paused 的），
    // 否则状态页仍要滚过上百条灰条才看得到主干——那等于没收窄。
    if (scope === 'trunk' && !isTrunkBranch(branch, project)) continue;
    const userViewUrl = options.getPreviewUrl ? (options.getPreviewUrl(branch) || '').trim() : '';
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
      // 归属判定走 SSOT：executorId 以 master- 开头的是内嵌 master 自己持有的
      // 本地分支，容器就在本机，必须照常探测（Codex PR #1273 P2）。
      const remoteExecutor = isRemoteExecutorOwned(branch.executorId);
      const active = branchLive && serviceLive && !excludedBy && !remoteExecutor;
      targets.push({
        id,
        source: 'branch',
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
        branchName: branch.branch || branch.id,
        projectName: project?.name || undefined,
        branchLastActiveAt: branch.lastAccessedAt,
        userViewUrl: userViewUrl || undefined,
      });
    }
  }
  return targets;
}

/**
 * 从生产发布目标推导探测目标（纯函数）。
 *
 * 刻意**不复用** selectProbeTargets 的分支循环：那里每一条规则都是分支专用的
 * （scope=trunk 收窄、远端 executor 归属、branchStatus/serviceStatus 活性），
 * 套到发布目标上全是误伤——事故值：默认 scope=trunk 会把生产目标一刀 continue
 * 掉，功能等于没做；集群部署下 executor 归属判定会让生产目标全体沉默。
 *
 * 「能不能探」只问 release-probe-target 那一个判定源，不在这里重写一遍。
 */
export function selectReleaseProbeTargets(
  releaseTargets: ReadonlyArray<ReleaseTarget>,
  excludePatterns: ReadonlyArray<string> = [],
): ProbeTarget[] {
  const targets: ProbeTarget[] = [];
  for (const target of releaseTargets) {
    if (!target) continue;
    const id = releaseProbeTargetId(target);
    const name = `生产 / ${target.name || target.id}`;
    const skipReason = releaseProbeSkipReason(target);
    const excludedBy = matchExcludePattern(
      { id, branchId: '', projectId: target.projectId, profileId: target.id, name },
      excludePatterns,
    );
    targets.push({
      id,
      source: 'release',
      branchId: '',
      projectId: target.projectId,
      profileId: target.id,
      name,
      hostPort: 0,
      probeKind: 'url',
      url: releaseProbeUrl(target),
      active: !skipReason && !excludedBy,
      // 发布目标没有分支，也没有 executor 归属这一维，别给它扣分支的帽子。
      branchStatus: 'release-target',
      serviceStatus: isReleaseTargetProbeable(target) ? 'enabled' : 'disabled',
      excluded: Boolean(excludedBy),
      excludedBy: excludedBy || undefined,
      releaseSkipReason: skipReason || undefined,
    });
  }
  return targets;
}

/**
 * 从监控中心的自定义定义推导探测目标（纯函数）。
 *
 * 与前两类的差别：活性只看 `enabled`（人手动暂停），没有分支状态、executor
 * 归属这些维度；间隔与超时可按目标覆盖，但只在轮次里判「到没到点」，
 * 定时器仍是全局那一个。排除名单照样生效（逃生阀对三类一视同仁）。
 */
export function selectCustomProbeTargets(
  monitors: ReadonlyArray<UptimeCustomMonitor>,
  excludePatterns: ReadonlyArray<string> = [],
  options: { globalIntervalMs?: number } = {},
): ProbeTarget[] {
  const targets: ProbeTarget[] = [];
  for (const monitor of monitors) {
    if (!monitor || !monitor.id) continue;
    const id = customProbeTargetId(monitor);
    const name = monitor.name || monitor.id;
    const excludedBy = matchExcludePattern(
      { id, branchId: '', projectId: monitor.projectId || '', profileId: monitor.id, name },
      excludePatterns,
    );
    const ownInterval = monitor.intervalSeconds ? monitor.intervalSeconds * 1000 : undefined;
    const globalInterval = options.globalIntervalMs || 0;
    targets.push({
      id,
      source: 'custom',
      branchId: '',
      projectId: monitor.projectId || '',
      profileId: monitor.id,
      name,
      hostPort: 0,
      probeKind: monitor.kind === 'tcp' ? 'tcp' : monitor.kind === 'keyword' ? 'keyword' : 'url',
      url: monitor.url,
      active: monitor.enabled && !excludedBy,
      branchStatus: 'custom-monitor',
      serviceStatus: monitor.enabled ? 'enabled' : 'paused',
      excluded: Boolean(excludedBy),
      excludedBy: excludedBy || undefined,
      monitor,
      // 比全局还快的间隔没有意义（轮次本身按全局跑），按全局结算并如实展示。
      intervalMs: ownInterval && globalInterval ? Math.max(ownInterval, globalInterval) : ownInterval,
      timeoutMs: monitor.timeoutMs,
      probeDescription: describeMonitorProbe(monitor),
    });
  }
  return targets;
}

/**
 * 三类目标合并成一轮探测清单。合并只此一处，避免调用方各自拼一份后漏掉某一类。
 */
export function selectAllProbeTargets(
  branches: ReadonlyArray<BranchEntry>,
  releaseTargets: ReadonlyArray<ReleaseTarget>,
  excludePatterns: ReadonlyArray<string> = [],
  options: {
    scope?: 'trunk' | 'all';
    getProject?: (projectId: string) => Project | null | undefined;
    releaseTargetsEnabled?: boolean;
    customMonitors?: ReadonlyArray<UptimeCustomMonitor>;
    globalIntervalMs?: number;
    getPreviewUrl?: (branch: BranchEntry) => string;
  } = {},
): ProbeTarget[] {
  const branchTargets = selectProbeTargets(branches, excludePatterns, options);
  const customTargets = selectCustomProbeTargets(options.customMonitors || [], excludePatterns, {
    globalIntervalMs: options.globalIntervalMs,
  });
  if (options.releaseTargetsEnabled === false) return [...branchTargets, ...customTargets];
  return [...branchTargets, ...selectReleaseProbeTargets(releaseTargets, excludePatterns), ...customTargets];
}

/** paused 原因的人话文案（前端直接展示）。 */
export function pausedReasonOf(target: ProbeTarget): string {
  if (target.excluded) {
    return `未纳入监控（命中排除规则 ${target.excludedBy}，可在 CDS_UPTIME_EXCLUDE 里移除）`;
  }
  if (target.remoteExecutor) {
    return '未纳入监控（容器在远端 executor，协调端探不到其宿主端口）';
  }
  if (target.source === 'custom') {
    return '已手动暂停，在监控中心点「恢复探测」即可继续';
  }
  // url 型必须在分支/服务状态之前结算：它的 branchStatus 是占位值 release-target，
  // 落到下面的模板会输出「分支状态 release-target，暂不探测」——用户读到的是
  // 一条根本不存在的分支，而真正的原因（目标已停用 / 没配上线地址）被吞掉。
  if (target.probeKind === 'url') {
    return target.releaseSkipReason || '发布目标暂不探测';
  }
  if (!LIVE_BRANCH_STATUSES.has(target.branchStatus)) {
    if (target.branchStatus === 'idle') return '分支已降温（调度器空闲回收），不计入故障';
    return `分支状态 ${target.branchStatus}，暂不探测`;
  }
  return `服务状态 ${target.serviceStatus}，暂不探测`;
}

/**
 * 生产发布目标的探测：打它自己的上线地址。
 *
 * 走 release-service 的 probeHealthcheckStatus，与发布中心预检**同一把尺子**；
 * 两处各写一份 fetch + 超时 + 判据的结局是两边对同一个站点给出不同结论。
 */
async function probeReleaseUrl(target: ProbeTarget, timeoutMs: number): Promise<Omit<UptimeSample, 't'>> {
  const url = (target.url || '').trim();
  if (!url) return { up: false, ms: 0, err: '发布目标未配置上线地址（healthcheckUrl）' };
  const probe = await probeHealthcheckStatus(url, timeoutMs);
  const up = probe.status === 'healthy';
  return {
    up,
    ms: probe.responseTimeMs ?? 0,
    err: up ? undefined : (probe.message || '上线地址探测失败'),
  };
}

/**
 * 默认 HTTP 探测：直连 `127.0.0.1:<hostPort>`。
 *
 * 判定口径：拿到任何 < 500 的响应都算存活（401/404 说明进程在应答，
 * 只是没有那个路由）；5xx / 连接失败 / 超时算故障。
 */
export const defaultHttpProbe: ProbeFn = async (target, timeoutMs) => {
  // 自定义监控按自己的定义分派（状态码规则 / 关键字 / TCP），不走下面任何一条
  // 分支专用口径——「< 500 即存活」对用户明确写了「必须 200」的目标就是假绿。
  if (target.source === 'custom') {
    if (!target.monitor) return { up: false, ms: 0, err: '自定义监控缺少定义' };
    return await probeCustomMonitor(target.monitor, timeoutMs);
  }
  // url 型必须在 hostPort 判定之前分派：它的 hostPort 恒为 0，落进下面的容器
  // 兜底就会拿 serviceStatus 当结论 —— 那探的是「CDS 以为的目标开关」，不是
  // 生产站点本身，站点整站挂掉时依然报 up。
  if (target.probeKind === 'url') return await probeReleaseUrl(target, timeoutMs);
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
        headers: { 'user-agent': 'cds-uptime-monitor', ...probeRequestHeaders() },
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
/** 用户视角探测结果。unreachable = 探测器够不着预览域名，不是用户视角故障。 */
export interface UserViewOutcome extends Omit<UptimeSample, 't'> {
  unreachable?: boolean;
}

export type UserViewProbeFn = (url: string, timeoutMs: number) => Promise<UserViewOutcome>;

/**
 * 用户视角探测：经预览域名走完整条链路（边缘 / forwarder / 路由 / 容器）。
 *
 * 判定口径与进程视角一致：拿到任何 < 500 的响应算可达（401 是预览门禁在应答，
 * 404 是路由到了应用），5xx / 超时算失败。连接层错误（DNS、拒绝、TLS）另标
 * unreachable——那说明探测器自己够不着预览域名，不能折成目标故障。
 * 带进程级探测令牌（probe-marker.ts）：代理侧据此不刷新 LRU、不记访问（proxy.ts）；
 * 公开的 x-cds-poll 头只影响日志分类，伪造不了豁免。
 */
export const defaultUserViewProbe: UserViewProbeFn = async (url, timeoutMs) => {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: ctrl.signal,
      headers: { 'user-agent': 'cds-uptime-monitor', ...probeRequestHeaders(), accept: 'text/html,*/*;q=0.8' },
    });
    await res.body?.cancel().catch(() => undefined);
    const code = res.status;
    return { up: code > 0 && code < 500, ms: Date.now() - startedAt, code, err: code >= 500 ? `用户视角 HTTP ${code}` : undefined };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    if (aborted) return { up: false, ms: Date.now() - startedAt, err: `用户视角探测超时（${timeoutMs}ms）` };
    const msg = (err as Error & { cause?: Error }).cause?.message || (err as Error).message;
    return { up: false, ms: Date.now() - startedAt, err: `探测器够不着预览域名：${msg}`, unreachable: true };
  } finally {
    clearTimeout(timer);
  }
};

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
  // 只保留**明确证明「对面回的不是 HTTP」**的证据：HTTP 解析器报错、TLS 版本
  // 不对等。这些是解析层给出的肯定性结论，不会被「服务崩了」制造出来。
  /parse error/i,
  /hpe_/i,
  /invalid (http|response)/i,
  /wrong version number/i,
  /eproto/i,
  // 刻意不含 ECONNRESET / socket hang up / EPIPE：
  // 一个正在崩溃、OOM、过载或还没起好的**HTTP** 服务同样会重置连接。把它们
  // 当成「这不是 HTTP 服务」的证据，会让该目标被永久降级为「按容器状态判定」，
  // 而容器状态是控制面意图（running），于是一个持续崩溃的服务从此显示为绿色，
  // 直到宿主端口变化为止——假绿比假红危险得多（Codex PR #1273 P1）。
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
    source: target.source,
    branchId: target.branchId,
    projectId: target.projectId,
    profileId: target.profileId,
    name: target.name,
    probeKind: target.probeKind,
    probeUrl: target.url,
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
  source: ProbeSource;
  name: string;
  branchId: string;
  projectId: string;
  profileId: string;
  probeKind: ProbeKind;
  /** url 型：探测地址（状态页徽标 title 展示） */
  probeUrl?: string;
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
  /**
   * 最近 7 个**自然日**（UTC，含今天）的可用率。跨天窗口只有按天聚合可用，
   * 所以口径是自然日而不是精确到秒的滚动 7×24 小时。
   */
  availability7d: number | null;
  avgLatencyMs24h: number | null;
  sampleCount24h: number;
  buckets: ReturnType<typeof bucketizeSamples>;
  openIncidentSince: number | null;
  /**
   * 当前状态从何时起持续（down = 开着的故障起点；up = 上一次故障结束 / 首次看到）。
   * 状态页「已正常 3 天 / 故障已持续 12 分钟」都从这里算。unknown / paused 为 null。
   */
  statusSince: number | null;
  /** 台账里的故障事件数（含已恢复，上限 MAX_INCIDENTS_PER_TARGET） */
  incidentCount: number;
  /** 探测方式的人话描述 */
  probeDescription: string;
  /** 本目标实际生效的探测间隔（秒） */
  intervalSeconds: number;
  /** 本目标实际生效的超时（毫秒） */
  timeoutMs: number;
  /** 自定义监控的定义 id（source=custom 时有），前端据此编辑 / 暂停 / 删除 */
  monitorId?: string;
  /** 自定义监控的标签 */
  tags?: string[];
  /** 自定义监控是否启用（source=custom 时有） */
  enabled?: boolean;
  /**
   * 是否真发过请求探出来的。false = 按容器状态判定（读的是 CDS 自己的记录，
   * 不是观测），状态页标「未实测」，不算正常、不计可用率。
   */
  measured: boolean;
  /** 分支目标的用户视角判定（有预览地址且开了用户视角才有） */
  userView?: UserViewState;
  branchName?: string;
  projectName?: string;
  branchStatus?: string;
  branchLastActiveAt?: string;
}

/** 覆盖面里一条「没被盯」的对象 */
export interface UptimeCoverageItem {
  id: string;
  name: string;
  source: ProbeSource;
  projectId: string;
  projectName?: string;
  kind: string;
  reason: string;
  action: string;
}

export interface UptimeCoverage {
  /** 全站可监测对象（三类来源推导出的全部目标） */
  total: number;
  /** 已纳入探测（含降温 / 未运行的分支：它们运行时就会被探） */
  covered: number;
  uncovered: UptimeCoverageItem[];
  /** 未纳入按原因计数 */
  byReason: Array<{ kind: string; count: number }>;
  scope: 'trunk' | 'all';
}

/** 探测器自身健康：横幅上告诉人「监测本身没停」 */
export interface UptimeProberHealth {
  lastCycleAt: number | null;
  lastCycleDurationMs: number | null;
  lastCycleProbed: number;
  lastCycleTargets: number;
  /** 超过两个间隔没跑完一轮 */
  stalled: boolean;
  userViewEnabled: boolean;
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
    /** 未实测（按容器状态判定）的目标数，不算正常 */
    unmeasured: number;
    ok: boolean;
  };
  targets: UptimeTargetSummary[];
  coverage: UptimeCoverage;
  prober: UptimeProberHealth;
}

/**
 * 带发布归因的故障事件。
 *
 * 字段挂在 incident 本体上（而不是另起一份归因账本），是因为归因是**创建那一刻的
 * 确定事实**，必须和 incident 同生命周期、同一份文件落盘、同一次读出来。
 * 两个字段都是可选的：存量 incident 与「没接 getReleaseRuns」的部署一律无归因，
 * 显示成「无归因」而不是编一个出来。
 */
export interface ReleaseLinkedIncident extends UptimeIncident {
  /** 疑似引入本次故障的发布 */
  releaseId?: string;
  /** 该次发布完成 → 故障判定之间隔了多久，用于「发布后 8 分钟出故障」这种文案 */
  releaseAgeMs?: number;
}

export interface UptimeIncidentView extends ReleaseLinkedIncident {
  targetName: string;
  source: ProbeSource;
  branchId: string;
  projectId: string;
  durationMs: number;
  ongoing: boolean;
}

/** 系统推导目标的探测方式描述（自定义监控由定义派生，不走这里）。 */
function defaultProbeDescription(record: Pick<UptimeTargetRecord, 'probeKind' | 'probeUrl'>): string {
  if (record.probeKind === 'url') return `GET ${record.probeUrl || '（未配置上线地址）'} · 状态 2xx`;
  if (record.probeKind === 'container') return '按容器状态判定（无可探测端口或已自动降级）';
  return 'GET 容器宿主端口根路径 · 状态 < 500';
}

/**
 * 总览计数的唯一口径：getSummary 与路由的项目级收窄都用它，别各算一份——
 * 项目级那份曾漏掉「未实测」，把按容器状态猜出来的「正常」当成实测健康报给项目 Key
 * （Codex PR #1514 P2）。按容器状态判出来的「正常」不是观测，单列未实测，不给它绿。
 */
export function tallyTargetSummaries(
  targets: ReadonlyArray<Pick<UptimeTargetSummary, 'status' | 'excluded' | 'measured'>>,
): UptimeSummary['overall'] {
  const tally = { total: targets.length, up: 0, down: 0, paused: 0, unknown: 0, excluded: 0, unmeasured: 0, ok: true };
  for (const t of targets) {
    if (t.excluded) tally.excluded += 1;
    else if (t.status === 'paused') tally.paused += 1;
    else if (!t.measured && t.status !== 'down') tally.unmeasured += 1;
    else if (t.status === 'up') tally.up += 1;
    else if (t.status === 'down') tally.down += 1;
    else tally.unknown += 1;
  }
  tally.ok = tally.down === 0;
  return tally;
}

export class UptimeMonitorService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private records = new Map<string, UptimeTargetRecord>();
  private lastCycleAt: number | null = null;
  private lastCycleDurationMs: number | null = null;
  private lastCycleProbed = 0;
  private lastCycleTargets = 0;
  private cycleRunning = false;

  constructor(
    private readonly deps: {
      state: UptimeStateSource;
      config: UptimeMonitorConfig;
      probe?: ProbeFn;
      /** 用户视角探测实现（测试注入） */
      userViewProbe?: UserViewProbeFn;
      now?: () => number;
      logger?: { warn?: (m: string) => void; info?: (m: string) => void };
      /**
       * 存活状态翻转出口（2026-07-29）。晚绑定的理由与 release-remote-watcher 的
       * setReleaseDriftNotifier 同源：监控模块不该反向 import 事件总线、更不该自己
       * 决定「这条要不要叫醒人」——那正是「存活一套、发布一套」两条分发逻辑的长法。
       * 接线方（index.ts）一行 cdsEventsBus.publish 转发即可。
       *
       * 不接不报错，只是掉线永远没人被通知——所以有源码守卫钉住这行接线。
       */
      onAlert?: (type: UptimeAlertEventType, data: UptimeAlertEventData) => void;
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
      const targets = this.selectTargets();
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
        this.syncRecordIdentity(record, target);
        this.records.set(target.id, record);
        if (target.active) {
          // 自定义监控可以比全局慢：没到点就跳过这一轮，状态原样保留。
          if (this.isDueThisCycle(target, record, now)) activeTargets.push(target);
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

      // 用户视角：每条运行中的分支探一次预览域名（不是每个服务一次）。
      const userViews = await this.probeUserViews(activeTargets);

      for (let i = 0; i < activeTargets.length; i += PROBE_CONCURRENCY) {
        const chunk = activeTargets.slice(i, i + PROBE_CONCURRENCY);
        const results = await Promise.all(chunk.map((target) => this.probeOne(target)));
        for (const { target, outcome, thrown } of results) {
          const folded = this.foldUserView(target, outcome, userViews.get(target.branchId));
          this.applySample(target, { ...folded, t: this.now() }, { allowDegrade: !thrown });
        }
      }

      this.lastCycleAt = now;
      this.lastCycleDurationMs = Math.max(0, this.now() - now);
      this.lastCycleProbed = activeTargets.length;
      this.lastCycleTargets = targets.length;
      this.persist();
    } finally {
      this.cycleRunning = false;
    }
  }

  /** 本轮探测清单（三类来源合并）。runCycle 与 probeNow 共用，避免两处各拼一份。 */
  private selectTargets(): ProbeTarget[] {
    return selectAllProbeTargets(
      this.deps.state.getAllBranches(),
      this.deps.state.getReleaseTargets?.() || [],
      this.deps.config.excludePatterns || [],
      {
        scope: this.deps.config.scope ?? 'all',
        getProject: this.deps.state.getProject?.bind(this.deps.state),
        releaseTargetsEnabled: this.deps.config.releaseTargetsEnabled !== false,
        customMonitors: this.deps.state.getUptimeMonitors?.() || [],
        globalIntervalMs: this.deps.config.intervalMs,
        getPreviewUrl: this.deps.state.getPreviewUrl?.bind(this.deps.state),
      },
    );
  }

  /**
   * 对本轮活跃的分支目标按分支去重，各探一次预览域名。结果按 branchId 返回，
   * 同一分支的所有服务共用同一个用户视角结论。关掉用户视角或没有预览地址时为空。
   */
  private async probeUserViews(activeTargets: ReadonlyArray<ProbeTarget>): Promise<Map<string, UserViewOutcome & { url: string }>> {
    const out = new Map<string, UserViewOutcome & { url: string }>();
    if (this.deps.config.userViewEnabled === false) return out;
    const byBranch = new Map<string, string>();
    for (const t of activeTargets) {
      if (t.source !== 'branch' || !t.userViewUrl || byBranch.has(t.branchId)) continue;
      byBranch.set(t.branchId, t.userViewUrl);
    }
    const probe = this.deps.userViewProbe || defaultUserViewProbe;
    const entries = [...byBranch.entries()];
    for (let i = 0; i < entries.length; i += PROBE_CONCURRENCY) {
      const chunk = entries.slice(i, i + PROBE_CONCURRENCY);
      const results = await Promise.all(chunk.map(async ([branchId, url]) => {
        try {
          return [branchId, { ...(await probe(url, this.deps.config.timeoutMs)), url }] as const;
        } catch (err) {
          return [branchId, { up: false, ms: 0, err: `用户视角探测异常：${(err as Error).message}`, unreachable: true, url }] as const;
        }
      }));
      for (const [branchId, result] of results) out.set(branchId, result);
    }
    return out;
  }

  /**
   * 把用户视角折进主采样：进程在答但用户视角 5xx / 超时 → 记为失败（原因写明是用户视角）。
   * 探测器够不着预览域名（unreachable）只记在 userView 上，不折——那不是目标故障。
   */
  private foldUserView(
    target: ProbeTarget,
    outcome: Omit<UptimeSample, 't'>,
    userView: (UserViewOutcome & { url: string }) | undefined,
  ): Omit<UptimeSample, 't'> {
    const record = this.records.get(target.id);
    if (!record || target.source !== 'branch') return outcome;
    if (!userView) {
      // 本轮没有用户视角（关掉了 / 没地址）：清掉旧结论，别让上一轮的红一直挂着。
      if (record.userView && !target.userViewUrl) record.userView = undefined;
      return outcome;
    }
    const sample: UptimeSample = { t: this.now(), up: userView.up, ms: userView.ms, code: userView.code, err: userView.err };
    record.userView = {
      url: userView.url,
      status: userView.unreachable ? 'unknown' : (userView.up ? 'up' : 'down'),
      lastSample: sample,
      unreachable: userView.unreachable || undefined,
    };
    if (outcome.up && !userView.up && !userView.unreachable) {
      return { up: false, ms: userView.ms, code: userView.code, err: userView.err || '用户视角不可达' };
    }
    return outcome;
  }

  /** 把目标定义上会变的展示字段同步进台账（改名、改地址、改间隔都要立刻反映）。 */
  private syncRecordIdentity(record: UptimeTargetRecord, target: ProbeTarget): void {
    record.source = target.source;
    record.name = target.name;
    record.probeKind = target.probeKind;
    record.probeUrl = target.url;
    record.projectId = target.projectId;
    record.profileId = target.profileId;
    record.excluded = target.excluded;
    record.probeDescription = target.probeDescription;
    record.intervalMs = target.intervalMs || this.deps.config.intervalMs;
    record.timeoutMs = target.timeoutMs || this.deps.config.timeoutMs;
    record.branchName = target.branchName;
    record.projectName = target.projectName;
    record.branchStatus = target.source === 'branch' ? target.branchStatus : undefined;
    record.branchLastActiveAt = target.branchLastActiveAt;
  }

  /** 按容器状态判定的目标不是观测，标「未实测」。 */
  private isMeasured(record: Pick<UptimeTargetRecord, 'probeKind' | 'source'>): boolean {
    return record.probeKind !== 'container';
  }

  /**
   * 覆盖面（对外口径）。项目级凭据只能看自己项目那一份：uncovered 里有目标 id、
   * 分支名、项目名与原因，全量吐给一把项目 Key 就是跨项目枚举（Codex PR #1514 P1）。
   */
  getCoverage(projectId?: string | null): UptimeCoverage {
    const all = this.selectTargets();
    return this.computeCoverage(projectId ? all.filter((t) => t.projectId === projectId) : all);
  }

  /**
   * 目标此刻的归属项目：先看本轮目标定义（刚保存、还没参与过轮次的目标也算），
   * 再看台账。都没有 → undefined = 目标不存在。路由靠它判项目级凭据能不能碰。
   */
  getTargetProjectId(targetId: string): string | undefined {
    const live = this.selectTargets().find((t) => t.id === targetId);
    if (live) return live.projectId;
    return this.records.get(targetId)?.projectId;
  }

  /** 覆盖面：全站可监测对象里，哪些没被盯、为什么、能怎么办。 */
  private computeCoverage(targets: ReadonlyArray<ProbeTarget>): UptimeCoverage {
    const uncovered: UptimeCoverageItem[] = [];
    for (const t of targets) {
      let kind: string | null = null;
      let reason = '';
      let action = '';
      if (t.excluded) {
        kind = '命中排除名单';
        reason = `命中排除规则 ${t.excludedBy}`;
        action = '在 CDS_UPTIME_EXCLUDE 里移除该规则';
      } else if (t.remoteExecutor) {
        kind = '远端执行器探不到';
        reason = '容器跑在远端执行器，协调端探不到其宿主端口';
        action = '等执行器侧探测上线';
      } else if (t.source === 'release' && t.releaseSkipReason) {
        kind = t.releaseSkipReason.includes('上线地址') ? '发布目标缺上线地址' : '发布目标未启用';
        reason = t.releaseSkipReason;
        action = t.releaseSkipReason.includes('上线地址') ? '去发布中心补 healthcheckUrl' : '在发布中心启用后自动纳入';
      }
      if (!kind) continue;
      uncovered.push({ id: t.id, name: t.name, source: t.source, projectId: t.projectId, projectName: t.projectName, kind, reason, action });
    }
    const counts = new Map<string, number>();
    for (const u of uncovered) counts.set(u.kind, (counts.get(u.kind) || 0) + 1);
    return {
      total: targets.length,
      covered: targets.length - uncovered.length,
      uncovered,
      byReason: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
      scope: this.deps.config.scope ?? 'all',
    };
  }

  /**
   * 自定义监控的间隔闸：只有它自己的间隔比全局慢时才需要判断。容差取半个全局
   * 间隔——定时器有漂移，卡死在「差 300ms 才到点」上会让 2 分钟间隔变成 3 分钟。
   */
  private isDueThisCycle(target: ProbeTarget, record: UptimeTargetRecord, now: number): boolean {
    const own = target.intervalMs || 0;
    const global = this.deps.config.intervalMs;
    if (own <= global) return true;
    if (!record.lastSample) return true;
    return now - record.lastSample.t >= own - global / 2;
  }

  private async probeOne(target: ProbeTarget): Promise<{
    target: ProbeTarget;
    outcome: Omit<UptimeSample, 't'>;
    thrown: boolean;
  }> {
    const probe = this.deps.probe || defaultHttpProbe;
    const timeoutMs = target.timeoutMs || this.deps.config.timeoutMs;
    try {
      return { target, outcome: await probe(target, timeoutMs), thrown: false };
    } catch (err) {
      // 探测器自身抛异常属于内部故障，不是「对面不说 HTTP」的证据，
      // 因此不参与自动降级判定，照常记一次失败。
      return {
        target,
        outcome: { up: false, ms: 0, err: (err as Error).message },
        thrown: true,
      };
    }
  }

  /**
   * 对单个目标立刻探一次并记入台账（监控中心「立即探测」）。
   *
   * 走与轮次完全相同的 probe → applySample 路径，所以去抖、故障合成、告警外发
   * 都照常生效——它只是把「等下一轮」变成「现在」，不是另一套判定。
   * 返回 null = 目标不存在；skipped = 目标此刻不该探（暂停 / 排除），原因随附。
   */
  async probeNow(targetId: string): Promise<
    | { ok: true; sample: UptimeSample; status: UptimeStatus }
    | { ok: false; skipped: string }
    | null
  > {
    const target = this.selectTargets().find((t) => t.id === targetId);
    if (!target) return null;
    const now = this.now();
    const record = this.records.get(target.id) || emptyRecord(target, now);
    this.syncRecordIdentity(record, target);
    this.records.set(target.id, record);
    if (!target.active) {
      // 刚保存就被暂停的目标也要立刻在状态页出现且标对档，不能等下一轮才从
      // unknown 翻成 paused。收尾逻辑与轮次一致。
      record.status = 'paused';
      record.pausedReason = pausedReasonOf(target);
      record.consecutiveFailures = 0;
      record.consecutiveSuccesses = 0;
      applyIncidentTransition(record.incidents, 'to-up', { targetId: target.id, at: now });
      this.persist();
      return { ok: false, skipped: pausedReasonOf(target) };
    }
    const effective: ProbeTarget = record.degraded ? { ...target, probeKind: 'container', hostPort: 0 } : target;
    // 用户视角与轮次同款：进程在答但预览域名 5xx 时，「立即探测」不能把目标翻绿、
    // 把故障就地收尾——恢复阈值默认是 1，一次进程视角的成功就够翻了（Codex PR #1514 P1）。
    const [{ outcome, thrown }, userViews] = await Promise.all([this.probeOne(effective), this.probeUserViews([effective])]);
    const folded = this.foldUserView(effective, outcome, userViews.get(effective.branchId));
    const sample: UptimeSample = { ...folded, t: this.now() };
    this.applySample(effective, sample, { allowDegrade: !thrown });
    this.persist();
    return { ok: true, sample: record.lastSample || sample, status: record.status };
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
    const cause = sample.err || (sample.code ? `HTTP ${sample.code}` : '探测连续失败');
    applyIncidentTransition(record.incidents, next.transition, {
      targetId: target.id,
      at: sample.t,
      cause,
    }, MAX_INCIDENTS_PER_TARGET);
    if (next.transition === 'to-down') this.attachReleaseAttribution(target, record, sample.t);
    // 状态翻转才外发：去抖已经在 nextDebounceState 做过，走到这里就是「真掉线 / 真恢复」，
    // 不会每轮探测都响一次。排除名单里的目标不算故障，不打扰人。
    if (next.transition && !record.excluded) {
      this.emitAlert(
        next.transition === 'to-down' ? 'uptime.target.down' : 'uptime.target.recovered',
        target,
        record,
        sample.t,
        next.transition === 'to-down' ? cause : '探测已连续成功，服务恢复',
      );
    }
  }

  /** 把状态翻转转发给接线方（未接线时静默，见构造参数 onAlert 注释）。 */
  private emitAlert(
    type: UptimeAlertEventType,
    target: ProbeTarget,
    record: UptimeTargetRecord,
    at: number,
    message: string,
  ): void {
    if (!this.deps.onAlert) return;
    try {
      this.deps.onAlert(type, {
        targetId: target.id,
        projectId: target.projectId,
        branchId: target.branchId,
        targetName: target.name,
        probeKind: target.probeKind,
        ...(target.url ? { probeUrl: target.url } : {}),
        message,
        consecutiveFailures: record.consecutiveFailures,
        detectedAt: new Date(at).toISOString(),
      });
    } catch (err) {
      this.deps.logger?.warn?.(`[uptime] 告警外发失败: ${(err as Error).message}`);
    }
  }

  /**
   * 给刚开出来的故障打上「疑似由哪次发布引入」。
   *
   * 只对 url 型（生产发布目标）做：分支预览没有发布这一说，套上去只会把分支抖动
   * 记成某次生产发布的锅。目标 id 走 target.profileId 而不是切 `release@` 前缀 ——
   * 前缀是 releaseProbeTargetId 的实现细节，在这里再解析一遍就是第二个判定源。
   */
  private attachReleaseAttribution(target: ProbeTarget, record: UptimeTargetRecord, atMs: number): void {
    if (target.source !== 'release' || !target.profileId) return;
    const readRuns = this.deps.state.getReleaseRuns;
    if (!readRuns) return;
    let link: ReturnType<typeof linkIncidentToRelease> = null;
    try {
      link = linkIncidentToRelease(atMs, readRuns.call(this.deps.state, target.profileId), {
        windowMs: releaseIncidentLinkWindowMs(),
      });
    } catch (err) {
      // 归因是锦上添花，读 state 出任何问题都不能把「记录故障」这件正事带塌。
      this.deps.logger?.warn?.(`[uptime] 故障归因失败（保留无归因故障）: ${(err as Error).message}`);
      return;
    }
    if (!link) return;
    // 刚刚这一轮开出来的那条：未结束 + 起始时刻正是本次采样时刻。
    const opened = record.incidents.find((i) => i.endedAt === null && i.startedAt === atMs) as
      ReleaseLinkedIncident | undefined;
    if (!opened) return;
    opened.releaseId = link.releaseId;
    opened.releaseAgeMs = link.ageMs;
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
    // url 型永不降级（假绿防线）：降级后的判据是 serviceStatus，而生产站点在 CDS
    // 这边根本没有容器，读到的是 ProbeTarget 上占位的 'enabled' → 恒为 up。
    // 事故值：生产整站挂掉，连续拿到协议层错误，状态页反而从红转绿。
    if (target.probeKind === 'url') return sample;
    // 自定义监控的判定就是用户写的那条规则，没有「其实它不说 HTTP」这回事。
    if (target.source !== 'branch') return sample;
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

    for (const record of [...this.records.values()].sort(compareTargetsForDisplay)) {
      const measured = this.isMeasured(record);
      const a24 = availabilityOverRange(record, dayMs, now);
      const a7 = availabilityOverRange(record, 7 * dayMs, now);
      const open = record.incidents.find((i) => i.endedAt === null) || null;
      const lastClosed = [...record.incidents].reverse().find((i) => i.endedAt !== null) || null;
      const statusSince = record.status === 'down'
        ? (open ? open.startedAt : null)
        : record.status === 'up'
          ? (lastClosed?.endedAt ?? record.firstSeenAt)
          : null;
      targets.push({
        id: record.id,
        source: record.source || probeSourceOfId(record.id),
        name: record.name,
        branchId: record.branchId,
        projectId: record.projectId,
        profileId: record.profileId,
        probeKind: record.probeKind,
        probeUrl: record.probeUrl,
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
        statusSince,
        incidentCount: record.incidents.length,
        probeDescription: record.probeDescription || defaultProbeDescription(record),
        intervalSeconds: Math.round((record.intervalMs || this.deps.config.intervalMs) / 1000),
        timeoutMs: record.timeoutMs || this.deps.config.timeoutMs,
        measured,
        userView: record.userView,
        branchName: record.branchName,
        projectName: record.projectName,
        branchStatus: record.branchStatus,
        branchLastActiveAt: record.branchLastActiveAt,
        ...(record.source === 'custom' ? this.customFacet(record.profileId) : {}),
      });
    }

    const intervalMs = this.deps.config.intervalMs;
    return {
      enabled: this.deps.config.enabled,
      generatedAt: now,
      intervalSeconds: Math.round(this.deps.config.intervalMs / 1000),
      timeoutMs: this.deps.config.timeoutMs,
      failureThreshold: this.deps.config.failureThreshold,
      firstDataEtaSeconds: Math.round(this.deps.config.intervalMs / 1000),
      lastCycleAt: this.lastCycleAt,
      excludePatterns: [...(this.deps.config.excludePatterns || [])],
      overall: tallyTargetSummaries(targets),
      targets,
      coverage: this.getCoverage(),
      prober: {
        lastCycleAt: this.lastCycleAt,
        lastCycleDurationMs: this.lastCycleDurationMs,
        lastCycleProbed: this.lastCycleProbed,
        lastCycleTargets: this.lastCycleTargets,
        stalled: this.deps.config.enabled && this.lastCycleAt !== null && now - this.lastCycleAt > intervalMs * 2,
        userViewEnabled: this.deps.config.userViewEnabled !== false,
      },
    };
  }

  /** 自定义监控在摘要里附带的定义字段（编辑 / 暂停 / 标签都靠它）。 */
  private customFacet(monitorId: string): Pick<UptimeTargetSummary, 'monitorId' | 'tags' | 'enabled'> {
    const monitor = (this.deps.state.getUptimeMonitors?.() || []).find((m) => m.id === monitorId);
    return { monitorId, tags: monitor?.tags || [], enabled: monitor ? monitor.enabled : true };
  }

  /** 单 target 时序（已降采样到固定桶数）。 */
  getHistory(targetId: string, rangeMs: number, bucketCount: number): {
    id: string;
    name: string;
    from: number;
    to: number;
    bucketCount: number;
    points: ReturnType<typeof bucketizeSamples>;
    /** 最近 20 次原始采样，最新在前——判定就是从这些来的，给人核对 */
    recentSamples: UptimeSample[];
  } | null {
    const record = this.records.get(targetId);
    if (!record) return null;
    const now = this.now();
    // 跨天 range 的起点必须与按天聚合的桶边界一致，否则返回的 from 早于第一个桶
    // （或桶多出一天），曲线上会出现「窗口外的那天」（Codex PR #1273 P2）。
    // 自然日边界走 calendarDayWindow 这一个判定源，与 availabilityOverRange 同源。
    const from = rangeMs > DAY_MS ? calendarDayWindow(rangeMs, now).fromMs : now - rangeMs;
    // 原始采样只留约 24 小时（环形缓冲），更早的历史在按天聚合里。跨天的 range
    // 若只 bucketize samples，7d/30d 会返回一整片空桶——看着像「那几天没监控」，
    // 实际是数据在另一个字段里（Codex PR #1273 P2）。
    // 判据只看 range 本身，不看当前采样跨度：刚起的监控只有几分钟采样，若按
    // 「range 超过采样跨度」判，24h 也会被推去走按天聚合，退化成一天一个点。
    const needsRollup = rangeMs > DAY_MS;
    const points = needsRollup
      ? dailyRollupPoints(record, from, now)
      : bucketizeSamples(record.samples, from, now, bucketCount);
    return { id: record.id, name: record.name, from, to: now, bucketCount: points.length, points, recentSamples: record.samples.slice(-20).reverse() };
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
          source: record.source || probeSourceOfId(record.id),
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

  /**
   * 立刻抹掉一个目标的台账（删除自定义监控时用）。不调它也会在下一轮被清理，
   * 但那意味着删掉的东西还要在状态页上挂最多一个探测间隔——用户会以为没删成。
   */
  forgetTarget(targetId: string): boolean {
    const existed = this.records.delete(targetId);
    if (existed) this.persist();
    return existed;
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
        if (!record.source) record.source = probeSourceOfId(record.id);
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
