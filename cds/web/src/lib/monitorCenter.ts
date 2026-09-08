/*
 * monitorCenter — 监控中心（/status）的类型与纯函数层。
 *
 * 页面组件只负责摆放；「第一屏该说什么结论」「列表怎么筛怎么分组」「默认选中谁」
 * 「数字怎么读」全在这里，没有 React 依赖，tests/web/monitor-center-view.test.ts
 * 直接跑真值断言，不靠源码扫描。
 *
 * 结论先于数字（conclusion-before-numbers）：顶部横幅是一句挂着数字、能归因的判断，
 * 不是让人自己读一排计数。算不出来的（没有目标、监控关着）就直说，不凑句子。
 */

export type UptimeStatus = 'up' | 'down' | 'paused' | 'unknown';
export type BucketStatus = 'up' | 'down' | 'partial' | 'none';
/** 与后端 ProbeKind 一一对应；分流逻辑一律走 Record 映射，不许写二分三元。 */
export type ProbeKind = 'http' | 'container' | 'url' | 'keyword' | 'tcp';
/** 目标来源：谁的承诺。分组、可用率含义、能不能编辑都由它决定。 */
export type ProbeSource = 'branch' | 'release' | 'custom';
export type MonitorKind = 'http' | 'keyword' | 'tcp';

export interface UptimeSample {
  t: number;
  up: boolean;
  ms: number;
  code?: number;
  err?: string;
}

export interface UptimeBucket {
  from: number;
  to: number;
  up: number;
  down: number;
  avgLatencyMs: number | null;
  status: BucketStatus;
}

export interface UptimeTargetSummary {
  id: string;
  source: ProbeSource;
  name: string;
  branchId: string;
  projectId: string;
  profileId: string;
  probeKind: ProbeKind;
  probeUrl?: string;
  status: UptimeStatus;
  pausedReason?: string;
  excluded?: boolean;
  degraded?: boolean;
  degradeReason?: string;
  lastSample: UptimeSample | null;
  availability24h: number | null;
  availability7d: number | null;
  avgLatencyMs24h: number | null;
  sampleCount24h: number;
  buckets: UptimeBucket[];
  openIncidentSince: number | null;
  statusSince: number | null;
  incidentCount: number;
  probeDescription: string;
  intervalSeconds: number;
  timeoutMs: number;
  monitorId?: string;
  tags?: string[];
  enabled?: boolean;
  /** false = 按容器状态判定（不是观测），标「未实测」，不算正常 */
  measured: boolean;
  /** 分支目标的用户视角判定（经预览域名） */
  userView?: UserViewState;
  branchName?: string;
  projectName?: string;
  branchStatus?: string;
  branchLastActiveAt?: string;
}

export interface UserViewState {
  url: string;
  status: UptimeStatus;
  lastSample: UptimeSample | null;
  unreachable?: boolean;
}

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
  total: number;
  covered: number;
  uncovered: UptimeCoverageItem[];
  byReason: Array<{ kind: string; count: number }>;
  scope: 'trunk' | 'all';
}

export interface UptimeProberHealth {
  lastCycleAt: number | null;
  lastCycleDurationMs: number | null;
  lastCycleProbed: number;
  lastCycleTargets: number;
  stalled: boolean;
  userViewEnabled: boolean;
}

export interface UptimeSummary {
  enabled: boolean;
  generatedAt: number;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  firstDataEtaSeconds: number;
  lastCycleAt: number | null;
  excludePatterns?: string[];
  overall: {
    total: number;
    up: number;
    down: number;
    paused: number;
    unknown: number;
    excluded?: number;
    unmeasured?: number;
    ok: boolean;
  };
  targets: UptimeTargetSummary[];
  coverage?: UptimeCoverage;
  prober?: UptimeProberHealth;
}

export interface UptimeIncidentView {
  id: string;
  targetId: string;
  targetName: string;
  source: ProbeSource;
  branchId: string;
  projectId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  cause: string;
  ongoing: boolean;
  /** 疑似引入本次故障的发布（生产目标才有）。无归因时后端不下发。 */
  releaseId?: string;
  releaseAgeMs?: number;
}

export interface UptimeHistory {
  id: string;
  name: string;
  from: number;
  to: number;
  bucketCount: number;
  points: UptimeBucket[];
  range: HistoryRange;
  /** 最近原始采样，最新在前 */
  recentSamples?: UptimeSample[];
}

export interface CustomMonitor {
  id: string;
  name: string;
  kind: MonitorKind;
  url?: string;
  method?: 'GET' | 'HEAD';
  expectedStatus?: string;
  keyword?: string;
  host?: string;
  port?: number;
  intervalSeconds?: number;
  timeoutMs?: number;
  projectId?: string | null;
  tags?: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type HistoryRange = '24h' | '7d' | '30d';
export const HISTORY_RANGES: ReadonlyArray<{ value: HistoryRange; label: string }> = [
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
];

export const SOURCE_META: Record<ProbeSource, { label: string; short: string; hint: string }> = {
  custom: { label: '自定义监控', short: '自定义', hint: '在监控中心手动添加：第三方依赖、上游网关、未接入 CDS 的服务' },
  release: { label: '生产发布目标', short: '生产', hint: '探测发布中心配置的上线地址（healthcheckUrl），可用率是线上承诺' },
  branch: { label: '分支预览服务', short: '分支', hint: '直连容器宿主端口，不经预览代理；降温期间记「已暂停」，不计故障' },
};
/** 列表分组顺序：自己添加的在最前，其次线上，最后临时环境。 */
export const SOURCE_ORDER: ReadonlyArray<ProbeSource> = ['custom', 'release', 'branch'];

export const PROBE_KIND_LABEL: Record<ProbeKind, string> = {
  http: 'HTTP 探测',
  container: '按容器状态判定',
  url: 'URL 探测',
  keyword: '关键字探测',
  tcp: 'TCP 端口探测',
};

export const MONITOR_KIND_META: Record<MonitorKind, { label: string; hint: string }> = {
  http: { label: 'HTTP 网址', hint: '请求一个地址，状态码落在规则内即正常（默认 200-399）' },
  keyword: { label: '关键字', hint: '状态码正常之外，响应体还必须包含指定文本，适合健康接口返回 JSON 的场景' },
  tcp: { label: 'TCP 端口', hint: '只看端口能不能建立连接，适合数据库、缓存、消息队列等不说 HTTP 的服务' },
};

export type StatusFilter = 'all' | 'down' | 'up' | 'paused' | 'unknown';
export const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'down', label: '故障' },
  { value: 'up', label: '正常' },
  { value: 'unknown', label: '待确认' },
  { value: 'paused', label: '暂停' },
];

// ── 格式化 ──

export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '暂无数据';
  return `${(ratio * 100).toFixed(ratio >= 0.9995 ? 0 : 2)}%`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export function formatShortClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

/** 时长的人话：秒 / 分 / 时 / 天，量纲随大小切换，绝不输出「0 小时」。 */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec} 秒`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return min % 60 ? `${hour} 小时 ${min % 60} 分` : `${hour} 小时`;
  const day = Math.floor(hour / 24);
  return hour % 24 ? `${day} 天 ${hour % 24} 小时` : `${day} 天`;
}

export function formatRelative(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < 45_000) return '刚刚';
  return `${formatDuration(diff)}前`;
}

/** 「已正常 3 天」「故障已持续 12 分钟」；unknown / paused 给不出时长就不编。 */
export function describeStatusSince(status: UptimeStatus, statusSince: number | null, now: number): string {
  if (statusSince === null) return status === 'paused' ? '探测已暂停' : '状态确认中';
  const span = formatDuration(now - statusSince);
  if (status === 'down') return `故障已持续 ${span}`;
  if (status === 'up') return `已连续正常 ${span}`;
  return status === 'paused' ? '探测已暂停' : '状态确认中';
}

// ── 结论 ──

export type HeadlineTone = 'ok' | 'warn' | 'danger' | 'neutral';

export interface MonitorHeadline {
  tone: HeadlineTone;
  title: string;
  detail: string;
}

/** 参与整体口径的目标：排除的、暂停的都不拉平均——关键数旁边写着「暂停不计入」，就得真不计入。 */
function contributes(t: UptimeTargetSummary): boolean {
  return !t.excluded && t.status !== 'paused' && t.sampleCount24h > 0;
}

/** 按采样次数加权的整体可用率：只算真正探过的目标，暂停 / 排除的不拉平均。 */
export function overallAvailability24h(targets: ReadonlyArray<UptimeTargetSummary>): number | null {
  let weight = 0;
  let sum = 0;
  for (const t of targets) {
    if (!contributes(t) || t.availability24h === null) continue;
    weight += t.sampleCount24h;
    sum += t.availability24h * t.sampleCount24h;
  }
  return weight > 0 ? sum / weight : null;
}

export function overallAvgLatency24h(targets: ReadonlyArray<UptimeTargetSummary>): number | null {
  let weight = 0;
  let sum = 0;
  for (const t of targets) {
    if (!contributes(t) || t.avgLatencyMs24h === null) continue;
    weight += t.sampleCount24h;
    sum += t.avgLatencyMs24h * t.sampleCount24h;
  }
  return weight > 0 ? Math.round(sum / weight) : null;
}

function joinNames(names: string[], max = 3): string {
  if (names.length <= max) return names.join('、');
  return `${names.slice(0, max).join('、')} 等 ${names.length} 个`;
}

export function buildMonitorHeadline(
  summary: Pick<UptimeSummary, 'enabled' | 'overall' | 'targets'> & { prober?: UptimeProberHealth },
  incidents: ReadonlyArray<UptimeIncidentView>,
  now: number,
): MonitorHeadline {
  if (!summary.enabled) {
    return { tone: 'neutral', title: '存活监控已关闭', detail: '当前实例设置了 CDS_UPTIME_ENABLED=0，移除后重启 CDS 即可恢复周期探测。' };
  }
  const { overall } = summary;
  const active = summary.targets.filter((t) => !t.excluded);
  if (summary.prober?.stalled) {
    return {
      tone: 'warn',
      title: '监测本身停了',
      detail: `探测器上一轮在 ${summary.prober.lastCycleAt ? formatRelative(summary.prober.lastCycleAt, now) : '未知时刻'}，超过两个探测间隔没有跑完，下面的状态可能已经过期。`,
    };
  }
  if (active.length === 0) {
    return { tone: 'neutral', title: '还没有可监控的目标', detail: '点右上角「添加监控」盯一个地址，或部署一个分支、给发布目标配上上线地址。' };
  }
  if (overall.down > 0) {
    const down = active.filter((t) => t.status === 'down');
    const production = down.filter((t) => t.source === 'release').length;
    const longest = down.reduce<number>((acc, t) => (t.openIncidentSince ? Math.max(acc, now - t.openIncidentSince) : acc), 0);
    const parts = [joinNames(down.map((t) => t.name))];
    if (production > 0) parts.push(`其中 ${production} 个是生产目标`);
    if (longest > 0) parts.push(`最长已持续 ${formatDuration(longest)}`);
    return {
      tone: production > 0 ? 'danger' : 'danger',
      title: production > 0 ? `${overall.down} 个目标故障，生产受影响` : `${overall.down} 个目标故障`,
      detail: `${parts.join('，')}。`,
    };
  }
  if (overall.unknown > 0) {
    return {
      tone: 'warn',
      title: `${overall.unknown} 个目标状态确认中`,
      detail: `其余 ${overall.up} 个正常。首轮探测或连续失败还没到判定阈值时会停在这一档，不会先报绿。`,
    };
  }
  const availability = overallAvailability24h(active.filter((t) => t.measured !== false));
  const latency = overallAvgLatency24h(active.filter((t) => t.measured !== false));
  // 「24 小时内恢复」看的是恢复时刻（endedAt），不是开始时刻：一次持续 30 小时、
  // 1 小时前才恢复的故障也算，否则刚修完就报「24 小时内没有故障」。最近恢复的排前面。
  const recent = incidents
    .filter((i): i is UptimeIncidentView & { endedAt: number } => !i.ongoing && i.endedAt !== null && now - i.endedAt <= 24 * 3600 * 1000)
    .sort((a, b) => b.endedAt - a.endedAt);
  const unmeasured = overall.unmeasured ?? 0;
  const tail = recent.length > 0
    ? `24 小时内恢复了 ${recent.length} 次故障，最近一次是 ${recent[0].targetName}（持续 ${formatDuration(recent[0].durationMs)}）。`
    : '24 小时内没有故障。';
  const stats = [
    availability !== null ? `近 24h 整体可用率 ${formatPercent(availability)}` : null,
    latency !== null ? `平均响应 ${formatLatency(latency)}` : null,
  ].filter(Boolean).join('，');
  const unmeasuredNote = unmeasured > 0 ? `另有 ${unmeasured} 个只按容器状态判定、未实测，不算在正常里。` : '';
  return {
    tone: overall.up > 0 ? 'ok' : 'neutral',
    title: overall.up > 0 ? `${overall.up} 个实测目标全部正常` : `${overall.paused} 个目标已暂停，暂无在探的目标`,
    detail: `${stats ? `${stats}。` : ''}${tail}${unmeasuredNote ? ` ${unmeasuredNote}` : ''}`,
  };
}

// ── 分支：按项目汇总 + 模态窗明细 ──

export type BranchTone = 'ok' | 'bad' | 'warn' | 'muted';

export interface BranchServiceView {
  profileId: string;
  target: UptimeTargetSummary;
  tone: BranchTone;
}

export interface BranchView {
  branchId: string;
  branchName: string;
  projectId: string;
  projectName: string;
  /** running = 存活 / unmeasured = 在跑但没有一个服务实测到 / idle = 降温或未运行 */
  bucket: 'running' | 'unmeasured' | 'idle';
  /** 在跑、有实测服务但还没判定出来（首轮 / 未到阈值）：「待确认」筛选认它 */
  unconfirmed: boolean;
  tone: BranchTone;
  services: BranchServiceView[];
  /** 代表目标：故障优先，其次实测的第一个 */
  primary: UptimeTargetSummary;
  /** 24h 迷你条：各实测服务的桶逐段合并，与旁边的可用率 / 响应数字同一口径 */
  buckets: UptimeBucket[];
  availability24h: number | null;
  avgLatencyMs24h: number | null;
  statusText: string;
  note: string;
  userView?: UserViewState;
  lastActiveAt?: string;
}

export interface ProjectBranchGroup {
  projectId: string;
  projectName: string;
  branches: BranchView[];
  running: number;
  total: number;
  ok: number;
  bad: number;
  unmeasured: number;
  idle: number;
}

function serviceTone(t: UptimeTargetSummary): BranchTone {
  if (t.excluded) return 'muted';
  if (t.status === 'down') return 'bad';
  if (t.status === 'paused') return 'muted';
  if (t.measured === false) return 'warn';
  if (t.status === 'up') return 'ok';
  return 'warn';
}

const BRANCH_LIVE = new Set(['running']);

/**
 * 把多个服务的 24h 桶逐段合并成一条：同一段里任一服务有失败就标 down / partial，
 * 都好才 up。迷你条只画代表目标的桶、数字却按全部实测服务算，一个服务全绿另一个
 * 时断时续时会出现「75% 旁边一条全绿」（Codex PR #1514 第三轮 P2）。
 */
export function mergeBuckets(series: ReadonlyArray<ReadonlyArray<UptimeBucket>>): UptimeBucket[] {
  const lists = series.filter((b) => b.length > 0);
  if (lists.length === 0) return [];
  const length = Math.min(...lists.map((b) => b.length));
  const out: UptimeBucket[] = [];
  for (let i = 0; i < length; i += 1) {
    let up = 0;
    let down = 0;
    let latencySum = 0;
    let latencyCount = 0;
    for (const b of lists) {
      const cell = b[i];
      up += cell.up;
      down += cell.down;
      if (cell.avgLatencyMs !== null) { latencySum += cell.avgLatencyMs; latencyCount += 1; }
    }
    const status: UptimeBucket['status'] = up > 0 && down > 0 ? 'partial' : down > 0 ? 'down' : up > 0 ? 'up' : 'none';
    out.push({ from: lists[0][i].from, to: lists[0][i].to, up, down, avgLatencyMs: latencyCount > 0 ? latencySum / latencyCount : null, status });
  }
  return out;
}

function buildBranchView(targets: UptimeTargetSummary[], now: number): BranchView {
  const first = targets[0];
  const services = targets.map((t) => ({ profileId: t.profileId, target: t, tone: serviceTone(t) }));
  const live = BRANCH_LIVE.has(first.branchStatus || '');
  const anyDown = services.some((s) => s.tone === 'bad');
  const anyMeasuredUp = services.some((s) => s.tone === 'ok');
  const allExcluded = services.every((s) => s.target.excluded);
  // 实测但还没判定出来（首轮 / 连续失败未到阈值）的服务：分支不能先报绿。
  // 它和「未实测（按容器状态）」是两回事，文案要分开说。
  const unconfirmed = services.filter((s) => !s.target.excluded && s.target.measured !== false && s.target.status === 'unknown');
  const containerOnly = services.filter((s) => s.tone === 'warn' && s.target.measured === false);
  let bucket: BranchView['bucket'] = 'idle';
  if (live && !allExcluded) bucket = anyMeasuredUp || anyDown || unconfirmed.length > 0 ? 'running' : 'unmeasured';
  const tone: BranchTone = anyDown
    ? 'bad'
    : bucket === 'running'
      ? (unconfirmed.length > 0 ? 'warn' : 'ok')
      : bucket === 'unmeasured' ? 'warn' : 'muted';
  const primary = services.find((s) => s.tone === 'bad')?.target || services.find((s) => s.tone === 'ok')?.target || first;
  const measured = targets.filter((t) => t.measured !== false && !t.excluded);
  const availability24h = overallAvailability24h(measured);
  const avgLatencyMs24h = overallAvgLatency24h(measured);
  const buckets = mergeBuckets((measured.length > 0 ? measured : [primary]).map((t) => t.buckets));
  let statusText: string;
  let note = '';
  if (bucket === 'idle') {
    statusText = first.branchLastActiveAt ? `上次运行 ${formatRelative(Date.parse(first.branchLastActiveAt), now)}` : (first.pausedReason || '未运行');
  } else if (anyDown) {
    const bad = services.find((s) => s.tone === 'bad')!.target;
    statusText = describeStatusSince('down', bad.openIncidentSince ?? bad.statusSince, now);
    note = `${bad.profileId}：${bad.lastSample?.err || '连续失败'}`;
  } else if (bucket === 'unmeasured') {
    statusText = '未实测';
    note = first.pausedReason || first.degradeReason || '没有可探测的 HTTP 端口，只按容器状态判定';
  } else if (unconfirmed.length > 0) {
    statusText = '状态确认中';
    note = `${unconfirmed.map((s) => s.profileId).join('、')} 首轮探测或连续失败还没到判定阈值`;
  } else {
    const up = services.find((s) => s.tone === 'ok')!.target;
    statusText = describeStatusSince('up', up.statusSince, now);
    if (containerOnly.length > 0) note = `${containerOnly.map((s) => s.profileId).join('、')} 未实测（无 HTTP 端口，按容器状态）`;
    const uv = first.userView;
    if (uv?.status === 'down') note = `用户视角不可达：${uv.lastSample?.err || ''}`;
    else if (uv?.unreachable) note = '探测器够不着预览域名，用户视角暂不可用';
  }
  return {
    branchId: first.branchId,
    branchName: first.branchName || first.branchId,
    projectId: first.projectId,
    projectName: first.projectName || first.projectId,
    bucket,
    unconfirmed: bucket === 'running' && !anyDown && unconfirmed.length > 0,
    tone,
    services,
    primary,
    buckets,
    availability24h,
    avgLatencyMs24h,
    statusText,
    note,
    userView: first.userView,
    lastActiveAt: first.branchLastActiveAt,
  };
}

const BUCKET_RANK: Record<BranchView['bucket'], number> = { running: 0, unmeasured: 1, idle: 2 };
const TONE_RANK: Record<BranchTone, number> = { bad: 0, ok: 1, warn: 2, muted: 3 };

/** 存活的排前面：运行中（故障优先）→ 未实测 → 已降温（最近活跃的在前）。 */
export function sortBranchesAliveFirst(branches: ReadonlyArray<BranchView>): BranchView[] {
  return [...branches].sort((a, b) => {
    const bucket = BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket];
    if (bucket !== 0) return bucket;
    if (a.bucket === 'idle') {
      const at = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
      const bt = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
      if (at !== bt) return bt - at;
    }
    const tone = TONE_RANK[a.tone] - TONE_RANK[b.tone];
    if (tone !== 0) return tone;
    return a.branchName.localeCompare(b.branchName);
  });
}

/** 把分支来源的目标按项目汇总；每个项目一条汇总行，明细进模态窗。 */
export function groupBranchesByProject(targets: ReadonlyArray<UptimeTargetSummary>, now: number): ProjectBranchGroup[] {
  const byBranch = new Map<string, UptimeTargetSummary[]>();
  for (const t of targets) {
    if (t.source !== 'branch') continue;
    const list = byBranch.get(t.branchId) || [];
    list.push(t);
    byBranch.set(t.branchId, list);
  }
  const byProject = new Map<string, BranchView[]>();
  for (const list of byBranch.values()) {
    const view = buildBranchView(list, now);
    const arr = byProject.get(view.projectId) || [];
    arr.push(view);
    byProject.set(view.projectId, arr);
  }
  return [...byProject.entries()]
    .map(([projectId, branches]) => {
      const sorted = sortBranchesAliveFirst(branches);
      return {
        projectId,
        projectName: sorted[0]?.projectName || projectId,
        branches: sorted,
        running: sorted.filter((b) => b.bucket !== 'idle').length,
        total: sorted.length,
        ok: sorted.filter((b) => b.tone === 'ok').length,
        bad: sorted.filter((b) => b.tone === 'bad').length,
        unmeasured: sorted.filter((b) => b.bucket === 'unmeasured').length,
        idle: sorted.filter((b) => b.bucket === 'idle').length,
      };
    })
    .sort((a, b) => (b.bad - a.bad) || (b.running - a.running) || a.projectName.localeCompare(b.projectName));
}

export type BranchFilter = 'all' | 'running' | 'bad' | 'idle';

export function filterBranches(branches: ReadonlyArray<BranchView>, filter: BranchFilter, query: string): BranchView[] {
  const q = query.trim().toLowerCase();
  return branches.filter((b) => {
    if (filter === 'running' && b.bucket === 'idle') return false;
    if (filter === 'bad' && b.tone !== 'bad') return false;
    if (filter === 'idle' && b.bucket !== 'idle') return false;
    if (!q) return true;
    return b.branchName.toLowerCase().includes(q) || b.services.some((s) => s.profileId.toLowerCase().includes(q));
  });
}

// ── 列表：筛选 / 分组 / 默认选中 ──

export interface TargetFilter {
  query: string;
  status: StatusFilter;
  source: ProbeSource | 'all';
}

/** 主列表的「主站」目标：生产发布目标 + 自定义监控。分支来源另走 groupBranchesByProject。 */
export function mainSiteTargets(targets: ReadonlyArray<UptimeTargetSummary>): UptimeTargetSummary[] {
  return targets.filter((t) => t.source !== 'branch');
}

export function filterTargets(
  targets: ReadonlyArray<UptimeTargetSummary>,
  filter: TargetFilter,
): UptimeTargetSummary[] {
  const q = filter.query.trim().toLowerCase();
  return targets.filter((t) => {
    if (filter.source !== 'all' && t.source !== filter.source) return false;
    if (filter.status !== 'all') {
      // 「暂停」这一档把「未纳入监控」也收进来：对用户来说都是「这条现在没在探」。
      if (filter.status === 'paused' ? !(t.status === 'paused' || t.excluded) : (t.status !== filter.status || t.excluded)) return false;
    }
    if (!q) return true;
    const hay = [t.name, t.probeUrl || '', t.branchId, t.profileId, ...(t.tags || [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

export interface TargetGroup {
  source: ProbeSource;
  label: string;
  hint: string;
  targets: UptimeTargetSummary[];
  down: number;
}

export function groupTargetsBySource(targets: ReadonlyArray<UptimeTargetSummary>): TargetGroup[] {
  return SOURCE_ORDER
    .map((source) => {
      const members = targets.filter((t) => t.source === source);
      return {
        source,
        label: SOURCE_META[source].label,
        hint: SOURCE_META[source].hint,
        targets: members,
        down: members.filter((t) => t.status === 'down' && !t.excluded).length,
      };
    })
    .filter((group) => group.targets.length > 0);
}

/** 默认选中：保留当前选中；否则先选故障，再选待确认，最后第一条。 */
export function pickDefaultTargetId(
  targets: ReadonlyArray<UptimeTargetSummary>,
  currentId: string | null,
): string | null {
  if (currentId && targets.some((t) => t.id === currentId)) return currentId;
  const down = targets.find((t) => t.status === 'down' && !t.excluded);
  if (down) return down.id;
  const unknown = targets.find((t) => t.status === 'unknown' && !t.excluded);
  if (unknown) return unknown.id;
  return targets[0]?.id ?? null;
}

// ── 响应时间曲线 ──

export interface LatencyPoint {
  t: number;
  ms: number;
  status: BucketStatus;
}

export interface LatencySeries {
  points: LatencyPoint[];
  min: number | null;
  avg: number | null;
  max: number | null;
}

export function latencySeries(points: ReadonlyArray<UptimeBucket>): LatencySeries {
  const rows: LatencyPoint[] = [];
  for (const bucket of points) {
    if (bucket.avgLatencyMs === null || bucket.status === 'none') continue;
    rows.push({ t: (bucket.from + bucket.to) / 2, ms: bucket.avgLatencyMs, status: bucket.status });
  }
  if (rows.length === 0) return { points: [], min: null, avg: null, max: null };
  const values = rows.map((r) => r.ms);
  return {
    points: rows,
    min: Math.min(...values),
    avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    max: Math.max(...values),
  };
}

/** 范围内的可用率（按桶内成功 / 总数），给 7d / 30d 的顶部数字用。 */
export function availabilityOfBuckets(points: ReadonlyArray<UptimeBucket>): number | null {
  let up = 0;
  let total = 0;
  for (const bucket of points) {
    up += bucket.up;
    total += bucket.up + bucket.down;
  }
  return total > 0 ? up / total : null;
}
