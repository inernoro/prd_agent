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
    ok: boolean;
  };
  targets: UptimeTargetSummary[];
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

/** 按采样次数加权的整体可用率：只算真正探过的目标，暂停 / 排除的不拉平均。 */
export function overallAvailability24h(targets: ReadonlyArray<UptimeTargetSummary>): number | null {
  let weight = 0;
  let sum = 0;
  for (const t of targets) {
    if (t.excluded || t.availability24h === null || t.sampleCount24h <= 0) continue;
    weight += t.sampleCount24h;
    sum += t.availability24h * t.sampleCount24h;
  }
  return weight > 0 ? sum / weight : null;
}

export function overallAvgLatency24h(targets: ReadonlyArray<UptimeTargetSummary>): number | null {
  let weight = 0;
  let sum = 0;
  for (const t of targets) {
    if (t.excluded || t.avgLatencyMs24h === null || t.sampleCount24h <= 0) continue;
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
  summary: Pick<UptimeSummary, 'enabled' | 'overall' | 'targets'>,
  incidents: ReadonlyArray<UptimeIncidentView>,
  now: number,
): MonitorHeadline {
  if (!summary.enabled) {
    return { tone: 'neutral', title: '存活监控已关闭', detail: '当前实例设置了 CDS_UPTIME_ENABLED=0，移除后重启 CDS 即可恢复周期探测。' };
  }
  const { overall } = summary;
  const active = summary.targets.filter((t) => !t.excluded);
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
  const availability = overallAvailability24h(active);
  const latency = overallAvgLatency24h(active);
  const recent = incidents.filter((i) => !i.ongoing && now - i.startedAt <= 24 * 3600 * 1000);
  const tail = recent.length > 0
    ? `24 小时内恢复了 ${recent.length} 次故障，最近一次是 ${recent[0].targetName}（持续 ${formatDuration(recent[0].durationMs)}）。`
    : '24 小时内没有故障。';
  const stats = [
    availability !== null ? `近 24h 整体可用率 ${formatPercent(availability)}` : null,
    latency !== null ? `平均响应 ${formatLatency(latency)}` : null,
  ].filter(Boolean).join('，');
  return {
    tone: overall.up > 0 ? 'ok' : 'neutral',
    title: overall.up > 0 ? `全部 ${overall.up} 个目标正常` : `${overall.paused} 个目标已暂停，暂无在探的目标`,
    detail: stats ? `${stats}。${tail}` : tail,
  };
}

// ── 列表：筛选 / 分组 / 默认选中 ──

export interface TargetFilter {
  query: string;
  status: StatusFilter;
  source: ProbeSource | 'all';
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
