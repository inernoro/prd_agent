/**
 * uptime-metrics — 自建存活监控的纯函数 SSOT（Uptime Kuma 风格）。
 *
 * 本文件只做「算」，不做「发」：不碰网络、不碰磁盘、不碰计时器，
 * 所有可用率 / 去抖判定 / 环形缓冲 / 降采样 / 事件合成都在这里，
 * 供 services/uptime-monitor.ts（探测器）、routes/uptime.ts（API）
 * 与 tests/services/uptime-*.test.ts（回归门禁）三方共用。
 *
 * 设计约束（对应 .claude/rules/concurrency-gate-discipline.md 的「周期收敛」
 * 与 CLAUDE.md §8 的「不许无限增长」）：
 *   1. 每个 target 的原始采样是**环形缓冲**，条数硬上限，禁止无界增长；
 *   2. 超出采样窗口的历史靠**按天聚合**（daily rollup）承载，天数同样有上限；
 *   3. 任何对外的时序输出都先降采样到固定桶数，禁止一次吐几万点。
 */

/** 单次探测采样。字段用短名，因为要按 target 存上千条并落盘。 */
export interface UptimeSample {
  /** 采样时刻（epoch ms） */
  t: number;
  /** 该次探测是否判定为存活 */
  up: boolean;
  /** 响应耗时（毫秒）。探测未发出时为 0。 */
  ms: number;
  /** HTTP 状态码（HTTP 探测才有） */
  code?: number;
  /** 失败原因（简短英文/中文短语，仅 up=false 时有） */
  err?: string;
}

/** 按天聚合。采样窗口滚出去之后，7d / 30d 可用率靠它算。 */
export interface UptimeDailyRollup {
  /** UTC 日期键 YYYY-MM-DD */
  day: string;
  up: number;
  down: number;
  /** 成功采样的耗时累加，用于算日均响应 */
  sumMs: number;
  /** 参与 sumMs 的采样数 */
  msCount: number;
}

/** 一次由「连续失败」自动合成的故障事件。 */
export interface UptimeIncident {
  id: string;
  targetId: string;
  /** 判定 down 的时刻（epoch ms） */
  startedAt: number;
  /** 恢复时刻；仍在进行中为 null */
  endedAt: number | null;
  /** 触发原因（首次失败的 err / HTTP 状态） */
  cause: string;
}

/** 存活状态。paused = 分支被调度器降温或未运行，不计故障。 */
export type UptimeStatus = 'up' | 'down' | 'paused' | 'unknown';

/** 去抖判定的滚动计数，随 target 一起持久化。 */
export interface DebounceState {
  status: UptimeStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

export interface DebounceOptions {
  /** 连续失败多少次才判 down（默认 3，抗单次抖动误报） */
  failureThreshold?: number;
  /** 连续成功多少次才判恢复（默认 1，恢复要快） */
  recoveryThreshold?: number;
}

export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_RECOVERY_THRESHOLD = 1;

/** 每个 target 的原始采样条数：默认 60s 间隔覆盖 24 小时。 */
export const MAX_SAMPLES_PER_TARGET = 1440;
/**
 * 原始采样的绝对上限 = 最快支持档（10s 间隔）覆盖 24 小时。
 * 环形缓冲的容量必须**按实际探测间隔**推导：写死 1440 条时，把间隔调到 10s
 * 只剩最近 4 小时，可 summary 依旧按 24 小时口径计算并标注 availability24h，
 * 前面 20 小时被当成「没有数据」既不画也不计入百分比（Codex PR #1273 P2）。
 */
export const MAX_SAMPLES_HARD_CEILING = 8640;

/** 覆盖 24 小时所需的采样条数（按探测间隔推导，夹在 [60, 硬上限] 内）。 */
export function samplesForDayAtInterval(intervalMs: number): number {
  const needed = Math.ceil(86_400_000 / Math.max(1, intervalMs));
  return Math.min(MAX_SAMPLES_HARD_CEILING, Math.max(60, needed));
}
/** 按天聚合的保留天数上限。 */
export const MAX_DAILY_ROLLUPS = 30;
/** 每个 target 保留的故障事件条数上限。 */
export const MAX_INCIDENTS_PER_TARGET = 50;
/** 对外时序接口一次最多返回的点数（降采样硬闸）。 */
export const MAX_HISTORY_POINTS = 500;
/** 状态页可用率柱条的默认段数（Uptime Kuma 同款 90 段）。 */
export const DEFAULT_BAR_SEGMENTS = 90;

const DAY_MS = 24 * 3600 * 1000;

/**
 * 定长追加：把 item 推入 list 尾部，超出 max 时从头部丢弃最旧的。
 * 原地修改并返回同一引用（调用方普遍就是持久化结构本身）。
 */
export function appendCapped<T>(list: T[], item: T, max: number): T[] {
  list.push(item);
  const overflow = list.length - Math.max(1, max);
  if (overflow > 0) list.splice(0, overflow);
  return list;
}

/**
 * 去抖状态机：单次采样不足以翻转状态，必须连续 N 次。
 *
 * 这是「避免抖动误报」的唯一判定入口——探测器只负责产采样，
 * 判 up/down 全走这里。返回 transition 让调用方知道要不要开/关事件。
 */
export function nextDebounceState(
  prev: DebounceState,
  sample: UptimeSample,
  options: DebounceOptions = {},
): DebounceState & { transition: 'to-down' | 'to-up' | null } {
  const failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
  const recoveryThreshold = Math.max(1, options.recoveryThreshold ?? DEFAULT_RECOVERY_THRESHOLD);

  if (sample.up) {
    const consecutiveSuccesses = prev.consecutiveSuccesses + 1;
    const shouldBeUp = consecutiveSuccesses >= recoveryThreshold;
    const status: UptimeStatus = shouldBeUp ? 'up' : prev.status;
    return {
      status,
      consecutiveFailures: 0,
      consecutiveSuccesses,
      transition: status === 'up' && prev.status !== 'up' ? 'to-up' : null,
    };
  }

  const consecutiveFailures = prev.consecutiveFailures + 1;
  const shouldBeDown = consecutiveFailures >= failureThreshold;
  const status: UptimeStatus = shouldBeDown ? 'down' : prev.status === 'up' ? 'up' : prev.status;
  return {
    status,
    consecutiveFailures,
    consecutiveSuccesses: 0,
    transition: status === 'down' && prev.status !== 'down' ? 'to-down' : null,
  };
}

/** UTC 日期键。聚合与查询共用同一口径，避免时区漂移导致对不上。 */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 把一条采样并进按天聚合，并把天数裁到 MAX_DAILY_ROLLUPS。
 * 原地修改并返回同一引用。
 */
export function applyDailyRollup(
  daily: UptimeDailyRollup[],
  sample: UptimeSample,
  maxDays: number = MAX_DAILY_ROLLUPS,
): UptimeDailyRollup[] {
  const key = dayKey(sample.t);
  let bucket = daily.length > 0 && daily[daily.length - 1].day === key
    ? daily[daily.length - 1]
    : daily.find((d) => d.day === key);
  if (!bucket) {
    bucket = { day: key, up: 0, down: 0, sumMs: 0, msCount: 0 };
    daily.push(bucket);
    daily.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }
  if (sample.up) {
    bucket.up += 1;
    bucket.sumMs += sample.ms;
    bucket.msCount += 1;
  } else {
    bucket.down += 1;
  }
  const overflow = daily.length - Math.max(1, maxDays);
  if (overflow > 0) daily.splice(0, overflow);
  return daily;
}

export interface AvailabilityResult {
  /** 可用率 0-1；窗口内无数据时为 null（前端渲染成「无数据」而不是 0%） */
  ratio: number | null;
  upCount: number;
  downCount: number;
  /** 成功采样的平均响应耗时；无数据为 null */
  avgLatencyMs: number | null;
}

/** 从原始采样算窗口可用率（含 from、含 to）。 */
export function availabilityFromSamples(
  samples: ReadonlyArray<UptimeSample>,
  fromMs: number,
  toMs: number,
): AvailabilityResult {
  let upCount = 0;
  let downCount = 0;
  let sumMs = 0;
  let msCount = 0;
  for (const s of samples) {
    if (s.t < fromMs || s.t > toMs) continue;
    if (s.up) {
      upCount += 1;
      sumMs += s.ms;
      msCount += 1;
    } else {
      downCount += 1;
    }
  }
  const total = upCount + downCount;
  return {
    ratio: total === 0 ? null : upCount / total,
    upCount,
    downCount,
    avgLatencyMs: msCount === 0 ? null : Math.round(sumMs / msCount),
  };
}

/** 从按天聚合算窗口可用率（按 UTC 日期键闭区间过滤）。 */
export function availabilityFromDaily(
  daily: ReadonlyArray<UptimeDailyRollup>,
  fromDay: string,
  toDay: string,
): AvailabilityResult {
  let upCount = 0;
  let downCount = 0;
  let sumMs = 0;
  let msCount = 0;
  for (const d of daily) {
    if (d.day < fromDay || d.day > toDay) continue;
    upCount += d.up;
    downCount += d.down;
    sumMs += d.sumMs;
    msCount += d.msCount;
  }
  const total = upCount + downCount;
  return {
    ratio: total === 0 ? null : upCount / total,
    upCount,
    downCount,
    avgLatencyMs: msCount === 0 ? null : Math.round(sumMs / msCount),
  };
}

/**
 * 窗口可用率统一入口。
 *
 * - 窗口 ≤ 一天：走原始采样，是**精确到秒**的滚动窗口。
 * - 更长的窗口：只能走按天聚合（原始采样已被环形缓冲滚掉），因此口径必然是
 *   **自然日（UTC）**，边界那天是整天进来的，没法再细分。
 *
 * 但「口径只能到自然日」不等于「天数可以对不上」。旧写法
 * `dayKey(now - 7d) .. dayKey(now)` 在 now 不是 UTC 零点时**跨了 8 个自然日**：
 * 7 月 28 日中午查 7d，now-7d 落在 7 月 21 日中午 → 起始 dayKey 是 07-21，
 * 于是 07-21 一整天（含窗口外的前半天）都被算进「最近 7 天」。
 * 取 `now - (N-1) 天` 才是**恰好 N 个自然日**（含今天这个尚未过完的当天）。
 */
/**
 * 跨天窗口的**自然日边界**（唯一判定源）。
 *
 * 跨天口径只有按天聚合可用（原始采样已被环形缓冲滚掉），所以窗口必然按自然日
 * 对齐。但天数必须对得上标签：直接拿 `now - N天` 去 floor 到自然日，在 now 不是
 * UTC 零点时会**多带出一整天**（7 月 28 日中午查 7d，起点落到 07-21，07-21..07-28
 * 共 8 天，窗口外的前半天也被算进来）。取 `今天 - (N-1) 天` 才是恰好 N 个自然日。
 *
 * 两个消费方必须都走它：可用率（availabilityOverRange）与历史曲线
 * （dailyRollupPoints 的调用方）。此前两处各算各的，修了可用率没修曲线
 * ——判定分散必然漂移（Codex PR #1273 P1/P2 连续两轮同一病根）。
 */
export function calendarDayWindow(rangeMs: number, nowMs: number): { fromMs: number; days: number } {
  const days = Math.max(1, Math.round(rangeMs / DAY_MS));
  const startDayIndex = Math.floor(nowMs / DAY_MS) - (days - 1);
  return { fromMs: startDayIndex * DAY_MS, days };
}

export function availabilityOverRange(
  target: { samples: ReadonlyArray<UptimeSample>; daily: ReadonlyArray<UptimeDailyRollup> },
  rangeMs: number,
  nowMs: number,
): AvailabilityResult {
  if (rangeMs <= DAY_MS) {
    return availabilityFromSamples(target.samples, nowMs - rangeMs, nowMs);
  }
  const { fromMs } = calendarDayWindow(rangeMs, nowMs);
  return availabilityFromDaily(target.daily, dayKey(fromMs), dayKey(nowMs));
}

/** 降采样后的一个时间桶。status=none 表示该桶内没有采样（灰段）。 */
export interface UptimeBucket {
  from: number;
  to: number;
  up: number;
  down: number;
  avgLatencyMs: number | null;
  status: 'up' | 'down' | 'partial' | 'none';
}

/** 把请求的桶数收敛到 [1, MAX_HISTORY_POINTS]，非法值回落到 fallback。 */
export function resolveBucketCount(requested: unknown, fallback: number): number {
  const n = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(n) || n <= 0) return Math.min(fallback, MAX_HISTORY_POINTS);
  return Math.min(Math.floor(n), MAX_HISTORY_POINTS);
}

/**
 * 降采样：把 [fromMs, toMs) 均分为 bucketCount 个桶，逐桶汇总采样。
 * 桶数恒等于 bucketCount（含无数据的空桶），前端柱条可以直接映射。
 */
export function bucketizeSamples(
  samples: ReadonlyArray<UptimeSample>,
  fromMs: number,
  toMs: number,
  bucketCount: number,
): UptimeBucket[] {
  const count = resolveBucketCount(bucketCount, DEFAULT_BAR_SEGMENTS);
  const span = Math.max(1, toMs - fromMs);
  const width = span / count;
  const buckets: UptimeBucket[] = [];
  const sums: number[] = [];
  const msCounts: number[] = [];
  for (let i = 0; i < count; i++) {
    buckets.push({
      from: Math.round(fromMs + i * width),
      to: Math.round(fromMs + (i + 1) * width),
      up: 0,
      down: 0,
      avgLatencyMs: null,
      status: 'none',
    });
    sums.push(0);
    msCounts.push(0);
  }
  for (const s of samples) {
    if (s.t < fromMs || s.t >= toMs) continue;
    const idx = Math.min(count - 1, Math.max(0, Math.floor((s.t - fromMs) / width)));
    if (s.up) {
      buckets[idx].up += 1;
      sums[idx] += s.ms;
      msCounts[idx] += 1;
    } else {
      buckets[idx].down += 1;
    }
  }
  for (let i = 0; i < count; i++) {
    const b = buckets[i];
    b.avgLatencyMs = msCounts[i] === 0 ? null : Math.round(sums[i] / msCounts[i]);
    if (b.up === 0 && b.down === 0) b.status = 'none';
    else if (b.down === 0) b.status = 'up';
    else if (b.up === 0) b.status = 'down';
    else b.status = 'partial';
  }
  return buckets;
}

/**
 * 按状态翻转维护故障事件账本：
 *   to-down 开一条新事件；to-up 关掉最近一条未结束的事件。
 * 条数上限 MAX_INCIDENTS_PER_TARGET，超出丢最旧的。
 */
export function applyIncidentTransition(
  incidents: UptimeIncident[],
  transition: 'to-down' | 'to-up' | null,
  ctx: { targetId: string; at: number; cause?: string },
  maxIncidents: number = MAX_INCIDENTS_PER_TARGET,
): UptimeIncident[] {
  if (transition === 'to-down') {
    const open = incidents.find((i) => i.endedAt === null);
    if (open) return incidents; // 已经在故障中，不重复开
    appendCapped(incidents, {
      id: `inc_${ctx.targetId}_${ctx.at}`,
      targetId: ctx.targetId,
      startedAt: ctx.at,
      endedAt: null,
      cause: ctx.cause || '探测连续失败',
    }, maxIncidents);
    return incidents;
  }
  if (transition === 'to-up') {
    for (let i = incidents.length - 1; i >= 0; i--) {
      if (incidents[i].endedAt === null) {
        incidents[i].endedAt = ctx.at;
        break;
      }
    }
  }
  return incidents;
}

/** 事件时长（进行中的事件按 now 计算）。 */
export function incidentDurationMs(incident: UptimeIncident, nowMs: number): number {
  return Math.max(0, (incident.endedAt ?? nowMs) - incident.startedAt);
}

/** range 查询串 → 毫秒。非法值回落 24h。 */
export function parseRange(range: unknown): { key: '24h' | '7d' | '30d'; ms: number } {
  const raw = typeof range === 'string' ? range.trim().toLowerCase() : '';
  if (raw === '7d') return { key: '7d', ms: 7 * DAY_MS };
  if (raw === '30d') return { key: '30d', ms: 30 * DAY_MS };
  return { key: '24h', ms: DAY_MS };
}
