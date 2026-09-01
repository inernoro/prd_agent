/**
 * 容器指标历史（2026-09-01）。
 *
 * 病根：CDS 一直在采，但一直在扔。
 *   - `resource-usage-sampler` 每 45s 对全宿主跑一次 `docker stats`，
 *     结果只留**最新一帧**（`let latest`），而且只按项目汇总，不按容器；
 *   - 分支详情抽屉打开时，前端又每 5s 打一次 `/branches/:id/metrics`，
 *     把点攒在 React state 里 —— 关掉抽屉全丢，窗口最长 5 分钟。
 * 于是同一条昂贵命令有两个采集者，谁都没留下历史，图表只能画「近 5 分钟」。
 *
 * 这个模块是**唯一的落点**：两路采集都往这里写，读的一侧只认这里。
 * 存在内存里、有界、进程重启即丢 —— 这是观测视图不是审计账本，
 * 不值得为它引一张表（要长留存请走 Netdata / Prometheus 这类外部件）。
 *
 * 查询契约借 Netdata 的形状（after / before / points / group）：调用方说
 * 「我要多长的窗口、多少个点」，降采样在服务端做完再下发。前端因此不必
 * 自己攒点，也不会因为窗口一长就把几千个点搬到浏览器里。
 */

/** 单次采样的原始值。net / block 是**容器生命周期累计**，速率由本模块算。 */
export interface ContainerSample {
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  netRxBytes: number;
  netTxBytes: number;
}

/** 落库后的一点：速率已算好，调用方直接画。 */
interface StoredPoint {
  ts: number;
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  /** bytes/sec，由与上一点的累计差除以间隔得出；首点或计数器回绕时为 0。 */
  rxRate: number;
  txRate: number;
  /** 保留累计值，供下一点算速率。 */
  netRxBytes: number;
  netTxBytes: number;
}

/**
 * 一个桶。值为 null 表示**这个容器在这段时间里没有样本**（还没起来 / 已经停了 /
 * 采集断档），不是「用量为 0」——两者别混，调用方自己决定怎么呈现。
 */
export interface SeriesPoint {
  ts: number;
  cpuPercent: number | null;
  memUsedBytes: number | null;
  rxRate: number | null;
  txRate: number | null;
}

export interface SeriesQuery {
  containers: string[];
  /** 窗口起点。负数 = 相对现在的秒数（-3600 = 近一小时），正数 = 毫秒时间戳。 */
  after: number;
  /** 窗口终点，0 或省略 = 现在。语义同 after。 */
  before?: number;
  /** 期望点数；实际点数不会超过它。超过就按 group 降采样。 */
  points?: number;
  /** 降采样聚合方式。average 看趋势，max 找毛刺。 */
  group?: 'average' | 'max';
}

export interface SeriesResult {
  /** 实际覆盖到的窗口（可能比请求的窗）。空序列时两者相等。 */
  after: number;
  before: number;
  /** 共享时间轴：所有容器的 points 与它一一对应、长度相同。 */
  timestamps: number[];
  /** 每个点代表多长时间（毫秒）。降采样后 = 窗口 / 点数。 */
  groupSeconds: number;
  group: 'average' | 'max';
  series: Record<string, SeriesPoint[]>;
}

/**
 * 保留策略。默认两小时：45s 基线采样 ≈ 160 点/容器，抽屉打开期间 5s 采样会更密，
 * 所以再压一道点数上限兜底（一个容器最多 2000 点 ≈ 5s × 2.8h）。
 * 两道闸都必要：只按时间会被高频采样撑爆，只按点数会让低频容器留下上古数据。
 */
const RETENTION_MS = Math.max(
  5 * 60_000,
  Number.parseInt(process.env.CDS_METRICS_RETENTION_MS || '', 10) || 2 * 60 * 60_000,
);
const MAX_POINTS_PER_CONTAINER = 2000;
/** 容器总数上限：宿主上容器来来去去，防止早已删除的名字无限堆积。 */
const MAX_CONTAINERS = 400;
/** 两次采样间隔超过这个值就不算速率（中间断档，差值除以大间隔会得到假的低速率）。 */
const MAX_RATE_GAP_MS = 5 * 60_000;

const store = new Map<string, StoredPoint[]>();

function trim(points: StoredPoint[], nowMs: number): StoredPoint[] {
  const cutoff = nowMs - RETENTION_MS;
  let start = 0;
  while (start < points.length && points[start].ts < cutoff) start += 1;
  const kept = start > 0 ? points.slice(start) : points;
  return kept.length > MAX_POINTS_PER_CONTAINER
    ? kept.slice(kept.length - MAX_POINTS_PER_CONTAINER)
    : kept;
}

/**
 * 记一次采样。两路采集者（45s 全宿主采样器、抽屉打开时的 5s 端点）都调这里。
 *
 * 同一毫秒重复写会被忽略：两路可能几乎同时落点，重复点会让速率计算除以 0。
 */
export function recordContainerSample(
  containerName: string,
  sample: ContainerSample,
  ts: number = Date.now(),
): void {
  if (!containerName) return;
  const existing = store.get(containerName) ?? [];
  const prev = existing.length > 0 ? existing[existing.length - 1] : null;
  if (prev && ts <= prev.ts) return;

  let rxRate = 0;
  let txRate = 0;
  if (prev) {
    const dtSec = (ts - prev.ts) / 1000;
    if (dtSec > 0 && ts - prev.ts <= MAX_RATE_GAP_MS) {
      // 容器重建后累计值归零，差为负 —— 这不是「负流量」，是换了个容器，记 0。
      rxRate = Math.max(0, (sample.netRxBytes - prev.netRxBytes) / dtSec);
      txRate = Math.max(0, (sample.netTxBytes - prev.netTxBytes) / dtSec);
    }
  }

  existing.push({
    ts,
    cpuPercent: sample.cpuPercent,
    memUsedBytes: sample.memUsedBytes,
    memLimitBytes: sample.memLimitBytes,
    rxRate,
    txRate,
    netRxBytes: sample.netRxBytes,
    netTxBytes: sample.netTxBytes,
  });
  store.set(containerName, trim(existing, ts));

  if (store.size > MAX_CONTAINERS) evictColdest();
}

/** 超出容器数上限时，丢掉最久没被写过的那些（容器已删 / 已停很久）。 */
function evictColdest(): void {
  const byLastSeen = [...store.entries()]
    .map(([name, points]) => ({ name, last: points.length ? points[points.length - 1].ts : 0 }))
    .sort((a, b) => a.last - b.last);
  const dropCount = store.size - MAX_CONTAINERS;
  for (let i = 0; i < dropCount; i += 1) store.delete(byLastSeen[i].name);
}

/** 容器被删除时主动清掉，不必等淘汰。 */
export function forgetContainer(containerName: string): void {
  store.delete(containerName);
}

function resolveBound(value: number | undefined, nowMs: number, fallback: number): number {
  if (value === undefined || value === 0) return fallback;
  // Netdata 的约定：负数是「相对现在往前多少秒」。
  return value < 0 ? nowMs + value * 1000 : value;
}

function aggregate(bucket: StoredPoint[], group: 'average' | 'max'): Omit<SeriesPoint, 'ts'> {
  if (group === 'max') {
    return {
      cpuPercent: Math.max(...bucket.map((p) => p.cpuPercent)),
      memUsedBytes: Math.max(...bucket.map((p) => p.memUsedBytes)),
      rxRate: Math.max(...bucket.map((p) => p.rxRate)),
      txRate: Math.max(...bucket.map((p) => p.txRate)),
    };
  }
  const n = bucket.length;
  return {
    cpuPercent: bucket.reduce((s, p) => s + p.cpuPercent, 0) / n,
    memUsedBytes: bucket.reduce((s, p) => s + p.memUsedBytes, 0) / n,
    rxRate: bucket.reduce((s, p) => s + p.rxRate, 0) / n,
    txRate: bucket.reduce((s, p) => s + p.txRate, 0) / n,
  };
}

/**
 * 按窗口取序列，必要时降采样到 `points` 个点。
 *
 * 降采样按**时间等宽分桶**，不是按「每 N 个点取一个」：两路采集者的间隔不一样
 * （45s 与 5s 混在一条序列里），按个数抽样会让时间轴疏密不均，图上看着像流量
 * 突然变化，其实只是采样率变了。等宽分桶让 x 轴恒等间隔。
 * 空桶不补零 —— 补零会画出并不存在的「掉到 0」。
 */
export function queryContainerSeries(query: SeriesQuery, nowMs: number = Date.now()): SeriesResult {
  const before = resolveBound(query.before, nowMs, nowMs);
  const after = resolveBound(query.after, nowMs, nowMs - 30 * 60_000);
  const group = query.group === 'max' ? 'max' : 'average';
  // 允许 points=1：这是「把整个窗口聚成一个数」的合法问法（顶部那个大数就用它）。
  const wanted = Math.max(1, Math.min(1000, query.points ?? 120));
  const span = Math.max(1, before - after);
  const bucketMs = span / wanted;

  // 先按桶归集每个容器的样本。桶边界对所有容器是同一套（同一个 after / bucketMs），
  // 这样下面才能拼出一条共享时间轴。
  const bucketsByContainer = new Map<string, Map<number, StoredPoint[]>>();
  const usedBuckets = new Set<number>();
  for (const name of query.containers) {
    const all = store.get(name);
    const buckets = new Map<number, StoredPoint[]>();
    bucketsByContainer.set(name, buckets);
    if (!all) continue;
    for (const p of all) {
      if (p.ts < after || p.ts > before) continue;
      const idx = Math.min(wanted - 1, Math.floor((p.ts - after) / bucketMs));
      const list = buckets.get(idx);
      if (list) list.push(p); else buckets.set(idx, [p]);
      usedBuckets.add(idx);
    }
  }

  /**
   * 共享时间轴 = 至少有一个容器有数据的那些桶。
   *
   * 这一步是 2026-09-01 的缺陷修复：以前每个容器各自跳过自己的空桶，于是
   * 「全程在跑的容器」拿到 60 个点、「中途停掉的容器」只拿到 30 个点。
   * 前端按数组下标堆叠，短的那条读到 undefined → 累加成 NaN → SVG 路径带
   * NaN 坐标 → 画面上出现黑色缺口。长度不一致本身就意味着下标对不上时间：
   * 停机容器的第 0 个点和其它容器的第 0 个点根本不是同一时刻。
   * 所以对齐必须由服务端保证，且缺口用 null 显式表达，不能靠"少给几个点"暗示。
   */
  const axis = [...usedBuckets].sort((a, b) => a - b);
  const timestamps = axis.map((idx) => Math.round(after + (idx + 0.5) * bucketMs));

  const series: Record<string, SeriesPoint[]> = {};
  for (const name of query.containers) {
    const buckets = bucketsByContainer.get(name);
    series[name] = axis.map((idx, i) => {
      const bucket = buckets?.get(idx);
      if (!bucket || bucket.length === 0) {
        return { ts: timestamps[i], cpuPercent: null, memUsedBytes: null, rxRate: null, txRate: null };
      }
      return { ts: timestamps[i], ...aggregate(bucket, group) };
    });
  }

  return { after, before, timestamps, groupSeconds: Math.round(bucketMs / 1000), group, series };
}

/** 测试用：清空全部历史。生产路径不调用。 */
export function __resetContainerMetricsHistory(): void {
  store.clear();
}

/** 观测自身：当前跟踪多少容器、多少点。用于排查内存增长。 */
export function containerMetricsHistoryStats(): { containers: number; points: number } {
  let points = 0;
  for (const list of store.values()) points += list.length;
  return { containers: store.size, points };
}
