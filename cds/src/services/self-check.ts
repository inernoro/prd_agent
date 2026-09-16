/*
 * CDS 自检端点 —— CDS 用同一套协议监控自己。
 *
 * 用户 2026-09-16：「先加上自己的吧，以代码初始化的方式来驱动，方便 CDS 迁移部署在
 * 其他服务器上。比如自己的部署、构建、页面打开时间什么的，找几个用户最在意的分类。」
 *
 * 做法与 MAP / llmgw 完全一样：CDS 暴露一个 health+json 端点，每条 check 自带
 * `cds:monitor` 声明，启动时把这个端点插进一个内置项目——于是 CDS 搬到哪台机器，
 * 这一整套监控都跟着起来，不用任何人手配。这也是「监控自发现协议」第一次被协议的
 * 作者自己吃：判据写在被监控方自己身上，CDS 只是恰好也是被监控方。
 *
 * 分类按「用户最在意什么」而不是按内部模块：
 *
 *   部署    卡住的部署（在途太久）、失败率
 *   构建    排队积压、最久等待
 *   页面    首屏最重那个接口的 P95、5xx 比例
 *   探测器  上一轮距今（它停了下面全是旧闻）
 *   接入    GitHub webhook 签名失败 / 派发错误——迁移后最常坏的就是这两条
 *   宿主    磁盘、Docker
 *   通知    还有没有一条通道通着——迁移后通道一条都不在
 *   自身    前端产物有没有落后于代码（2026-09-15 当天踩过）
 *
 * 三条纪律：
 *   - **量不到就说量不到**，不补 0。读不到磁盘就 fail 并写明原因，不许写成「0%」——
 *     那会被读成一块全空的盘。
 *   - **零流量不算绿**。P95 与 5xx 比例是被动观测，样本量来自同一份文档里的请求数；
 *     半夜没人访问时它们显示「没人用过」，不显示「一切正常」。
 *   - **阈值是常量，写在最上面**，一处改全局动；不散在各条 check 里。
 */
import { SELF_CHECK_PATH } from './self-check-path.js';

export { SELF_CHECK_PATH };

/** 自检端点每条监控的探测间隔。5 分钟：够密到脉搏墙连成线，又不至于把日志刷满。 */
export const SELF_MONITOR_INTERVAL_SECONDS = 300;

/** 一次部署在途多久算「卡住」。CDS 自己的硬超时是 45 分钟，超过它还没终态就是卡了。 */
export const DEPLOY_STUCK_AFTER_MS = 45 * 60 * 1000;
/**
 * 在途部署的心跳停了多久算「死了」。2026-09-16 线上实测：CDS 重启把七个 building 的部署
 * 打断，它们的心跳全停在重启那一刻，状态却一直是 building——按年龄要等 45 分钟才报，
 * 按心跳 10 分钟就该报。
 */
export const DEPLOY_HEARTBEAT_STALE_MS = 10 * 60 * 1000;
/** 24 小时内失败率超过这个百分比，说明坏的不是某个提交，是 CDS 自己。 */
export const DEPLOY_FAILURE_RATE_MAX_PERCENT = 50;
/** 构建队列积压上限。2026-07-16 事故：queued=54，agent 排队 50 分钟以上。 */
export const BUILD_QUEUE_MAX = 5;
/** 构建最久等待上限（分钟）。 */
export const BUILD_WAIT_MAX_MINUTES = 15;
/** 首屏最重的接口（分支列表）的 P95 上限（毫秒）。 */
export const API_P95_MAX_MS = 1500;
/** 30 分钟内 5xx 占比上限（百分比）。 */
export const API_ERROR_RATE_MAX_PERCENT = 5;
/** 探测器上一轮距今上限（秒）。轮次 60 秒，3 轮没完成就是停摆。 */
export const PROBER_STALE_AFTER_SECONDS = 180;
/** 磁盘占用上限（百分比）。与 disk-guard 的 freeze 档一致：到这里部署会被冻结。 */
export const DISK_USED_MAX_PERCENT = 90;
/** Docker daemon 响应上限（毫秒）。 */
export const DOCKER_PING_MAX_MS = 3000;
/** 读不到 Docker 时写进 observedValue 的哨兵值——它必须落在阈值之外，而不是缺省成 0。 */
export const DOCKER_UNREACHABLE_MS = 99_999;
/** 探测器停摆时写进 observedValue 的哨兵值，同上。 */
export const PROBER_STALLED_SECONDS = 9_999;
/**
 * 进程刚起来的宽限期：自身状态缓存还没算完之前，不把「还不知道」当成「前端产物落后」。
 * 没有这个宽限，每次自更新重启都会先响一次铃再自己恢复——铃响多了就没人听了。
 * 过了宽限还不知道，那就是真的拿不到，照实 fail。
 */
export const SELF_STATUS_GRACE_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;

/** 部署的非终态：还在往前走的那几档。 */
const DEPLOY_IN_FLIGHT = new Set(['pending', 'queued', 'preparing', 'building', 'starting', 'verifying']);

export interface SelfCheckDeps {
  now: () => number;
  deploymentRuns: () => ReadonlyArray<{ status: string; startedAt: string; finishedAt?: string; heartbeatAt?: string; updatedAt?: string }>;
  webhookDeliveries: (limit: number) => ReadonlyArray<{ receivedAt: string; signatureValid: boolean; dispatchAction: string }>;
  buildGate: () => { active: number; queued: number; max: number; waiters: ReadonlyArray<{ enqueuedAt: string }> };
  /**
   * 探测器活性。拿不到传 null——那是「不知道」，不是「健康」。
   * `stale` 是探测器自己的停摆判定（从未完成过一轮时它以进程启动时刻为基准），
   * 这里直接复用，不另写一份「多久算停」。
   */
  cycleHealth: () => { sinceLastCycleMs: number | null; stale: boolean; running: boolean; watchdogResets: number } | null;
  /** 进程启动时刻（毫秒）。拿不到传 null。 */
  processStartedAt: () => number | null;
  diskUsage: () => { totalBytes: number; freeBytes: number } | null;
  dockerPing: () => Promise<{ ok: boolean; ms: number; detail?: string }>;
  /** 最近一段时间主进程的请求统计。没有日志存储时返回 null。 */
  httpStats: (sinceMs: number) => Promise<{ requests: number; serverErrors: number; branchesP95Ms: number | null } | null>;
  /** 真的会响的通知通道数（与面板同一份判定）。 */
  liveAlarmChannels: () => number;
  /** `ready=false` 表示自身状态缓存还没算过一次——刚起来的进程会有几十秒这样。 */
  selfStatus: () => { ready: boolean; bundleStale: boolean; headSha: string; currentBranch: string } | null;
  storeBackend: () => string;
}

export type HealthStatus = 'pass' | 'warn' | 'fail';

/** IETF health+json 的一条 check，外加 `cds:monitor` 自描述段。 */
export interface SelfCheckItem {
  componentId: string;
  componentType: string;
  observedValue: number | string | null;
  observedUnit?: string;
  status: HealthStatus;
  time: string;
  output?: string;
  'cds:monitor'?: {
    name: string;
    op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
    value: number | string;
    intervalSeconds: number;
    failuresToAlarm: number;
    severity: 'P0' | 'P1' | 'P2';
    environment: 'production';
    observeMode?: 'passive';
    sampleComponentId?: string;
  };
}

export interface SelfCheckDoc {
  status: HealthStatus;
  serviceId: 'cds';
  description: string;
  releaseId?: string;
  checks: Record<string, SelfCheckItem>;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export { percentile as selfCheckPercentile };

function monitored(
  base: Omit<SelfCheckItem, 'cds:monitor' | 'time'>,
  spec: Omit<NonNullable<SelfCheckItem['cds:monitor']>, 'intervalSeconds' | 'environment'> & { intervalSeconds?: number },
  time: string,
): SelfCheckItem {
  return {
    ...base,
    time,
    'cds:monitor': {
      intervalSeconds: SELF_MONITOR_INTERVAL_SECONDS,
      environment: 'production',
      ...spec,
    },
  };
}

/** 把一批 check 合成整份文档，总状态取最差。 */
export function assembleDoc(checks: SelfCheckItem[], releaseId?: string): SelfCheckDoc {
  const rank: Record<HealthStatus, number> = { pass: 0, warn: 1, fail: 2 };
  const worst = checks.reduce<HealthStatus>((acc, c) => (rank[c.status] > rank[acc] ? c.status : acc), 'pass');
  const map: Record<string, SelfCheckItem> = {};
  for (const c of checks) map[c.componentId] = c;
  return {
    status: worst,
    serviceId: 'cds',
    description: 'CDS 自检：部署 / 构建 / 页面 / 探测器 / 接入 / 宿主 / 通知 / 自身',
    ...(releaseId ? { releaseId } : {}),
    checks: map,
  };
}

export async function buildSelfCheck(deps: SelfCheckDeps): Promise<SelfCheckDoc> {
  const now = deps.now();
  const time = new Date(now).toISOString();
  const checks: SelfCheckItem[] = [];

  // ── 部署 ───────────────────────────────────────────────────────────
  const runs = deps.deploymentRuns();
  const inFlight = runs.filter((r) => DEPLOY_IN_FLIGHT.has(r.status));
  const tooOld = inFlight.filter((r) => now - Date.parse(r.startedAt) > DEPLOY_STUCK_AFTER_MS);
  // 心跳以 heartbeatAt 为准，没有就退回 updatedAt；两个都没有的老记录不按心跳判（不假定）。
  const heartbeatDead = inFlight.filter((r) => {
    const beat = r.heartbeatAt || r.updatedAt;
    return Boolean(beat) && now - Date.parse(beat as string) > DEPLOY_HEARTBEAT_STALE_MS;
  });
  const stuck = new Set([...tooOld, ...heartbeatDead]);
  checks.push(monitored(
    {
      componentId: 'deploy.stuck', componentType: 'deploy',
      observedValue: stuck.size, observedUnit: 'count',
      status: stuck.size === 0 ? 'pass' : 'fail',
      output: stuck.size === 0
        ? `没有卡住的部署（在途 ${inFlight.length} 个，心跳都在）`
        : `${stuck.size} 个部署卡住：${tooOld.length} 个在途超过 45 分钟，${heartbeatDead.length} 个心跳停了超过 10 分钟（多半是 CDS 重启把它们打断了，状态没收尸）`,
    },
    { name: 'CDS · 部署卡住', op: 'eq', value: 0, failuresToAlarm: 1, severity: 'P0' },
    time,
  ));

  const finished = runs.filter((r) => r.finishedAt && now - Date.parse(r.finishedAt) <= DAY_MS && (r.status === 'failed' || r.status === 'running' || r.status === 'cancelled'));
  const failed = finished.filter((r) => r.status === 'failed').length;
  const failureRate = finished.length === 0 ? 0 : Math.round((failed / finished.length) * 100);
  checks.push({
    componentId: 'deploy.finished-24h', componentType: 'deploy',
    observedValue: finished.length, observedUnit: 'count', status: 'pass', time,
    output: '近 24 小时结束的部署数（失败率的样本量）',
  });
  checks.push(monitored(
    {
      componentId: 'deploy.failure-rate-24h', componentType: 'deploy',
      observedValue: failureRate, observedUnit: 'percent',
      status: failureRate <= DEPLOY_FAILURE_RATE_MAX_PERCENT ? 'pass' : 'fail',
      output: finished.length === 0 ? '近 24 小时没有部署结束 —— 无从判断' : `近 24 小时 ${finished.length} 次部署，${failed} 次失败`,
    },
    // 被动：没有部署的夜里不该显示成「失败率 0%，一切正常」，而是「没样本」。
    { name: 'CDS · 部署失败率', op: 'lte', value: DEPLOY_FAILURE_RATE_MAX_PERCENT, failuresToAlarm: 2, severity: 'P1', observeMode: 'passive', sampleComponentId: 'deploy.finished-24h' },
    time,
  ));

  // ── 构建 ───────────────────────────────────────────────────────────
  const gate = deps.buildGate();
  checks.push(monitored(
    {
      componentId: 'build.queue-waiting', componentType: 'build',
      observedValue: gate.queued, observedUnit: 'count',
      status: gate.queued <= BUILD_QUEUE_MAX ? 'pass' : 'fail',
      output: `${gate.active}/${gate.max} 在构建，${gate.queued} 个排队`,
    },
    { name: 'CDS · 构建排队', op: 'lte', value: BUILD_QUEUE_MAX, failuresToAlarm: 2, severity: 'P1' },
    time,
  ));
  const oldestWaitMin = gate.waiters.length === 0
    ? 0
    : Math.round(Math.max(...gate.waiters.map((w) => now - Date.parse(w.enqueuedAt))) / 60_000);
  checks.push(monitored(
    {
      componentId: 'build.oldest-wait-minutes', componentType: 'build',
      observedValue: oldestWaitMin, observedUnit: 'minute',
      status: oldestWaitMin <= BUILD_WAIT_MAX_MINUTES ? 'pass' : 'fail',
      output: gate.waiters.length === 0 ? '没有人在等构建槽' : `最久的一个已等 ${oldestWaitMin} 分钟`,
    },
    { name: 'CDS · 构建最久等待', op: 'lte', value: BUILD_WAIT_MAX_MINUTES, failuresToAlarm: 2, severity: 'P1' },
    time,
  ));

  // ── 页面（首屏）─────────────────────────────────────────────────────
  const http = await deps.httpStats(now - HALF_HOUR_MS);
  const requests = http?.requests ?? 0;
  checks.push({
    componentId: 'api.requests-30m', componentType: 'http',
    observedValue: http ? requests : null, observedUnit: 'count', status: http ? 'pass' : 'warn', time,
    output: http ? '近 30 分钟主进程收到的请求数（下面两条的样本量）' : '这个实例没接 HTTP 日志存储，读不到请求统计',
  });
  const p95 = http?.branchesP95Ms ?? null;
  checks.push(monitored(
    {
      componentId: 'api.branches-p95-ms', componentType: 'http',
      observedValue: p95, observedUnit: 'ms',
      status: p95 === null ? 'warn' : p95 <= API_P95_MAX_MS ? 'pass' : 'fail',
      output: p95 === null ? '近 30 分钟没人打开过分支列表' : `分支列表接口 P95 ${p95}ms —— 它是首屏最重的一次请求`,
    },
    { name: 'CDS · 首屏接口 P95', op: 'lte', value: API_P95_MAX_MS, failuresToAlarm: 2, severity: 'P1', observeMode: 'passive', sampleComponentId: 'api.requests-30m' },
    time,
  ));
  const errorRate = !http || requests === 0 ? 0 : Math.round((http.serverErrors / requests) * 100);
  checks.push(monitored(
    {
      componentId: 'api.error-rate-30m', componentType: 'http',
      observedValue: http ? errorRate : null, observedUnit: 'percent',
      status: !http ? 'warn' : errorRate <= API_ERROR_RATE_MAX_PERCENT ? 'pass' : 'fail',
      output: !http ? '读不到请求统计' : `近 30 分钟 ${requests} 个请求里 ${http.serverErrors} 个 5xx`,
    },
    { name: 'CDS · 接口 5xx 比例', op: 'lte', value: API_ERROR_RATE_MAX_PERCENT, failuresToAlarm: 2, severity: 'P0', observeMode: 'passive', sampleComponentId: 'api.requests-30m' },
    time,
  ));

  // ── 探测器 ─────────────────────────────────────────────────────────
  const cycle = deps.cycleHealth();
  const startedAt = deps.processStartedAt();
  const processAgeSec = startedAt === null ? null : Math.max(0, Math.round((now - startedAt) / 1000));
  const sinceSec = cycle?.sinceLastCycleMs === null || cycle?.sinceLastCycleMs === undefined
    ? null : Math.round(cycle.sinceLastCycleMs / 1000);
  // 停摆与否听探测器自己的（它从未完成一轮时以启动时刻为基准）；这里只决定写什么数：
  //   完成过 → 上一轮距今；没完成但没停摆 → 进程起来多久（刚重启的诚实答案）；
  //   停摆 / 拿不到 → 哨兵值，它必须落在阈值外，缺省成 0 会被读成「刚跑过」。
  const proberStalled = !cycle || cycle.stale;
  const proberObserved = sinceSec !== null ? sinceSec : proberStalled ? PROBER_STALLED_SECONDS : (processAgeSec ?? PROBER_STALLED_SECONDS);
  checks.push(monitored(
    {
      componentId: 'prober.since-last-cycle-seconds', componentType: 'prober',
      observedValue: proberObserved, observedUnit: 'second',
      status: !proberStalled && proberObserved <= PROBER_STALE_AFTER_SECONDS ? 'pass' : 'fail',
      output: !cycle
        ? '拿不到探测器状态'
        : sinceSec === null
          ? (cycle.stale ? '探测器起来之后一轮都没跑完 —— 停摆' : `进程刚起 ${processAgeSec ?? '?'} 秒，首轮还在跑`)
          : `上一轮 ${sinceSec} 秒前${cycle.watchdogResets > 0 ? `，看门狗复位过 ${cycle.watchdogResets} 次` : ''}`,
    },
    { name: 'CDS · 探测器上一轮', op: 'lte', value: PROBER_STALE_AFTER_SECONDS, failuresToAlarm: 1, severity: 'P0' },
    time,
  ));

  // ── 接入（push 即部署）───────────────────────────────────────────────
  const WEBHOOK_SAMPLE = 500;
  const recentDeliveries = deps.webhookDeliveries(WEBHOOK_SAMPLE);
  const deliveries = recentDeliveries.filter((d) => now - Date.parse(d.receivedAt) <= DAY_MS);
  // 取到的条数顶到上限，说明 24 小时内不止这些——文案里如实说「最近 N 条」，不冒充全量。
  const deliveryScope = recentDeliveries.length >= WEBHOOK_SAMPLE ? `最近 ${deliveries.length} 条` : `近 24 小时 ${deliveries.length} 条`;
  const badSig = deliveries.filter((d) => !d.signatureValid).length;
  const dispatchErrors = deliveries.filter((d) => d.dispatchAction === 'error').length;
  checks.push(monitored(
    {
      componentId: 'webhook.signature-failures-24h', componentType: 'github',
      observedValue: badSig, observedUnit: 'count',
      status: badSig === 0 ? 'pass' : 'fail',
      output: badSig === 0 ? `${deliveryScope} webhook 签名都对` : `${badSig} 条 webhook 签名不对 —— 多半是 webhook secret 和 GitHub 那边不一致（迁移后最常坏的一条）`,
    },
    { name: 'CDS · Webhook 签名', op: 'eq', value: 0, failuresToAlarm: 1, severity: 'P0' },
    time,
  ));
  checks.push(monitored(
    {
      componentId: 'webhook.dispatch-errors-24h', componentType: 'github',
      observedValue: dispatchErrors, observedUnit: 'count',
      status: dispatchErrors === 0 ? 'pass' : 'fail',
      output: dispatchErrors === 0 ? '近 24 小时没有派发失败的 webhook' : `${dispatchErrors} 条 webhook 收到了但派发失败 —— push 了没部署，就是它`,
    },
    { name: 'CDS · Webhook 派发', op: 'eq', value: 0, failuresToAlarm: 1, severity: 'P1' },
    time,
  ));

  // ── 宿主 ───────────────────────────────────────────────────────────
  const disk = deps.diskUsage();
  const usedPercent = disk ? Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100) : null;
  checks.push(monitored(
    {
      componentId: 'host.disk-used-percent', componentType: 'host',
      // 读不到就是 null + fail，不写 0：0% 会被读成一块全空的盘。
      observedValue: usedPercent, observedUnit: 'percent',
      status: usedPercent === null ? 'fail' : usedPercent < DISK_USED_MAX_PERCENT ? 'pass' : 'fail',
      output: usedPercent === null ? '读不到磁盘占用' : `磁盘已用 ${usedPercent}%${usedPercent >= DISK_USED_MAX_PERCENT ? ' —— 到这里部署会被冻结' : ''}`,
    },
    { name: 'CDS · 磁盘占用', op: 'lt', value: DISK_USED_MAX_PERCENT, failuresToAlarm: 1, severity: 'P0' },
    time,
  ));
  const docker = await deps.dockerPing();
  checks.push(monitored(
    {
      componentId: 'host.docker-ping-ms', componentType: 'host',
      observedValue: docker.ok ? docker.ms : DOCKER_UNREACHABLE_MS, observedUnit: 'ms',
      status: docker.ok && docker.ms <= DOCKER_PING_MAX_MS ? 'pass' : 'fail',
      output: docker.ok ? `Docker ${docker.detail ?? ''} 响应 ${docker.ms}ms`.trim() : `Docker 打不通：${docker.detail ?? '未知原因'}`,
    },
    { name: 'CDS · Docker 响应', op: 'lte', value: DOCKER_PING_MAX_MS, failuresToAlarm: 1, severity: 'P0' },
    time,
  ));

  // ── 通知 ───────────────────────────────────────────────────────────
  const live = deps.liveAlarmChannels();
  checks.push(monitored(
    {
      componentId: 'alarm.live-channels', componentType: 'alarm',
      observedValue: live, observedUnit: 'count',
      status: live >= 1 ? 'pass' : 'fail',
      output: live >= 1
        ? `${live} 条通知通道有成功投递的记录`
        : '没有一条通知通道有成功投递的记录 —— 配了但从没发成功过的也不算；现在出问题不确定有没有人会被通知（去演练一次，成功一次就算通）',
    },
    { name: 'CDS · 通知通道', op: 'gte', value: 1, failuresToAlarm: 1, severity: 'P1' },
    time,
  ));

  // ── 自身 ───────────────────────────────────────────────────────────
  const self = deps.selfStatus();
  // 缓存还没算过一次 + 进程还在宽限期内 → 「还不知道」，不响铃；过了宽限还不知道才算真拿不到。
  const selfWarming = Boolean(self && !self.ready && processAgeSec !== null && processAgeSec * 1000 < SELF_STATUS_GRACE_MS);
  const selfKnown = Boolean(self && self.ready);
  checks.push(monitored(
    {
      componentId: 'self.bundle-stale', componentType: 'self',
      // 布尔写成 0/1：协议里期望值是字符串比较，数字最不容易被两边解读成不同的东西。
      observedValue: selfKnown ? (self!.bundleStale ? 1 : 0) : selfWarming ? 0 : 1, observedUnit: 'flag',
      status: selfKnown ? (self!.bundleStale ? 'fail' : 'pass') : selfWarming ? 'warn' : 'fail',
      output: selfKnown
        ? (self!.bundleStale ? `前端产物落后于代码 ${self!.headSha}（${self!.currentBranch}）—— 页面跑的是旧版` : `前端产物与 ${self!.headSha} 一致`)
        : selfWarming ? `进程刚起 ${processAgeSec} 秒，自身状态还没算完` : '拿不到自身状态',
    },
    { name: 'CDS · 前端产物落后', op: 'eq', value: 0, failuresToAlarm: 1, severity: 'P1' },
    time,
  ));
  checks.push({
    componentId: 'store.backend', componentType: 'store',
    observedValue: deps.storeBackend(), status: 'pass', time,
    output: '状态存储后端（迁移后核对是不是还在 Mongo 上）',
  });

  return assembleDoc(checks, selfKnown ? self!.headSha || undefined : undefined);
}
