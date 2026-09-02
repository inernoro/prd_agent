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
  /**
   * 容器短 ID。同名重建时会变；省略则退化为「只靠计数器变小判重建」，
   * 那种判法在新容器抢先跑量时会漏，记出假尖峰。
   */
  containerId?: string;
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  /**
   * 块设备累计读写字节（docker stats 的 BlockIO）。
   *
   * 2026-09-02 补采：`docker stats` 一直在返回它、`ContainerStats` 一直在解析它，
   * 只有这里没收——白丢的一维。核对过不是常年 0：宿主 cgroup v2 的 io.stat 实测
   * `rbytes=7360512 wbytes=1200128`。
   */
  blockReadBytes?: number;
  blockWriteBytes?: number;
}

/** 落库后的一点：速率已算好，调用方直接画。 */
interface StoredPoint {
  ts: number;
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  /**
   * bytes/sec，由与上一点的累计差除以间隔得出。
   *
   * **算不出来时是 null，不是 0**（Codex P2，核对属实）：首点、同名重建换了生命周期、
   * 间隔超过 MAX_RATE_GAP_MS 这三种情况下都没有可减的前一点。记 0 等于说「这一刻
   * 一个字节都没走」，而吞吐图会照着画出一次「掉到零又爬回来」——和最初那道
   * 「掉到 0」的谷是同一种谎，只是发生在速率这一维上。
   */
  rxRate: number | null;
  txRate: number | null;
  /** bytes/sec，块设备读写。口径与 net 完全一致，算不出来同样是 null。 */
  readRate: number | null;
  writeRate: number | null;
  /** 保留累计值，供下一点算速率。 */
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  containerId: string;
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
  readRate: number | null;
  writeRate: number | null;
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

/**
 * 两次写入之间的最小间隔。比这更近的第二条直接丢弃。
 *
 * 有两个写入方在采同一批容器：45s 的常驻采样器，和抽屉打开时 5s 的端点。它们各自
 * 独立跑 `docker stats`，完全可能在相隔几毫秒时先后落点（Codex P2，核对属实）。
 * 原来的护栏只挡「时间戳没往前走」，挡不住「往前走了 1 毫秒」——而速率是
 * 累计差 / 间隔，除以 0.001 秒能把一次普通的字节增量放大成几十 MB/s 的假尖峰。
 * 反过来，两次快照若乱序到达，负增量会被 clamp 成 0，下一次差分又会被撑大。
 *
 * 相隔不到 1 秒的两条记录，测的本来就是同一个瞬间，留一条即可。取 1 秒而不是更大：
 * 两个写入方最密的是 5 秒那一档，1 秒既足够挡住撞车，又不会误伤任何真实节奏。
 */
const MIN_WRITE_INTERVAL_MS = 1_000;

const store = new Map<string, StoredPoint[]>();

/**
 * 全局过期清理的最小间隔。比这更密地扫全表没意义（保留期是小时级）。
 */
const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;

/**
 * 按保留期清掉**所有**容器的陈旧点，不只是这次写入的那个。
 *
 * 原来的修剪只在「同一个容器再次写入」时发生（Codex P2，核对属实）：容器一旦停掉
 * 或删掉，它那份数组就再也没人碰，最多 2000 个点会一直躺到「容器数超上限」才被整个
 * 挤掉。宿主上换过的容器名不到 400 个时那一天永远不来——**声称的两小时保留期对
 * 死掉的容器从来没有生效过**。
 *
 * 做成写入时顺带的惰性扫描，不起定时器：这个模块是纯内存的观测缓存，不值得为它
 * 引入一个需要在测试里 mock、在关停时清理的 timer。扫描本身 O(容器数)，且按
 * SWEEP_INTERVAL_MS 限流，代价可以忽略。
 */
function sweepExpired(nowMs: number): void {
  if (nowMs - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = nowMs;
  for (const [name, points] of store) {
    const kept = trim(points, nowMs);
    if (kept.length === 0) store.delete(name);
    else if (kept.length !== points.length) store.set(name, kept);
  }
}

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
  if (prev && ts - prev.ts < MIN_WRITE_INTERVAL_MS) return;

  // 算不出速率就是 null（首点 / 换生命周期 / 断档），不是 0。
  let rxRate: number | null = null;
  let txRate: number | null = null;
  let readRate: number | null = null;
  let writeRate: number | null = null;
  /*
   * 同名重建 = 新的生命周期，累计值从 0 重来，不能跨这条边界做差。
   *
   * 只靠「新值比旧值小」判重建是漏的：部署会复用容器名，若新容器在第一次采样前
   * 已经比旧容器最后一次读数跑得更多，差值仍为正，于是记出一个巨大的假速率尖峰
   * （Codex P2，核对属实）。容器短 ID 在重建时必变，是可靠的身份信号；它还能覆盖
   * CDS 之外的销毁（外部 docker rm、宿主重启），比在七八处销毁点逐个挂钩子稳。
   */
  const sameLifecycle = !prev
    || !sample.containerId
    || !prev.containerId
    || prev.containerId === sample.containerId;
  if (prev && sameLifecycle) {
    const dtSec = (ts - prev.ts) / 1000;
    if (dtSec > 0 && ts - prev.ts <= MAX_RATE_GAP_MS) {
      // 容器重建后累计值归零，差为负 —— 这不是「负流量」，是换了个容器，记 0。
      rxRate = Math.max(0, (sample.netRxBytes - prev.netRxBytes) / dtSec);
      txRate = Math.max(0, (sample.netTxBytes - prev.netTxBytes) / dtSec);
      readRate = Math.max(0, ((sample.blockReadBytes ?? 0) - prev.blockReadBytes) / dtSec);
      writeRate = Math.max(0, ((sample.blockWriteBytes ?? 0) - prev.blockWriteBytes) / dtSec);
    }
  }

  existing.push({
    ts,
    cpuPercent: sample.cpuPercent,
    memUsedBytes: sample.memUsedBytes,
    memLimitBytes: sample.memLimitBytes,
    rxRate,
    txRate,
    readRate,
    writeRate,
    netRxBytes: sample.netRxBytes,
    netTxBytes: sample.netTxBytes,
    blockReadBytes: sample.blockReadBytes ?? 0,
    blockWriteBytes: sample.blockWriteBytes ?? 0,
    containerId: sample.containerId ?? '',
  });
  store.set(containerName, trim(existing, ts));

  sweepExpired(ts);
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

function resolveBound(value: number | undefined, nowMs: number, fallback: number): number {
  if (value === undefined || value === 0) return fallback;
  // Netdata 的约定：负数是「相对现在往前多少秒」。
  return value < 0 ? nowMs + value * 1000 : value;
}

/**
 * 观测到的最粗采集节奏（毫秒）。
 *
 * 为什么需要它：图的分辨率不能比数据的节奏细。常驻采样器 45s 一帧，若按 120 点切
 * 30 分钟窗口（每桶 15s），三个桶里只有一个有样本，另外两个是空的——空桶在堆叠图里
 * 画成 0，于是整张图变成一片均匀锯齿：每个尖峰是一次真实采样，每个谷底是「没数据」
 * 被当成了「用量为零」。图画的是采集节奏，不是 CPU。
 *
 * 判据是「**忽略真实断档之后的最大常规间隔**」，取法：把 ≤ MAX_RATE_GAP_MS 的间隔
 * 降序排，取第 3 大（不足 3 个就取最大）。
 *
 * 为什么不是中位数、也不是 p90（2026-09-02 修）：抽屉打开时 5s 端点也在写，窗口里
 * 混着 5s 与 45s 两种节奏。**任何按数量取的分位数最终都会被密的那一档吞掉**——
 * 算一下就知道：30 分钟窗口里抽屉开 T 分钟，5s 样本 12T 个、45s 段 1.33(30−T) 个，
 * 5s 间隔占比超过 90% 只需要 T > 15。也就是说抽屉开够一刻钟，p90 就变成 5s，
 * 于是又切出 120 个 15s 的桶，老的那三分之二又空了——锯齿原样回来，
 * 恰恰是这段逻辑要防的东西。
 *
 * 所以改成按「最大」取，只做两处修剪：
 *   - 超过 MAX_RATE_GAP_MS 的间隔是**真实断档**，本来就该以 null 缺口的形式呈现，
 *     不参与定分辨率（否则一次重启就把整窗压成几个点）；
 *   - 取第 3 大而不是第 1 大，容忍最多两次偶发抖动（漏采一帧会造出一个双倍间隔，
 *     不该让它把整张图的分辨率减半）。
 *
 * 为什么取容器间的最大值：一条轴要同时画所有容器，分辨率由最稀疏的那条决定；
 * 对更密的那条只是多平均几个点，不会失真。
 *
 * 样本少于 2 个的容器不参与——**一个点没有间隔可言**。只要有两个点就有一个间隔，
 * 那个间隔就是目前能观测到的全部节奏信息，用它比不用强得多（见下面 bySamples 的死因）。
 * 全都算不出就返回 0 = 不做限制：此时任何容器最多只有 1 帧，前端本来就不画。
 */
/** 判一个间隔是不是「比邻居明显大」的相似带：超过邻居 1.5 倍才算突出。 */
const CADENCE_SIMILARITY = 1.5;

/**
 * 从**按时间排好**的间隔里挑出最粗的那一档真实节奏。
 *
 * 判据：**孤立的大间隔是抖动，处在边缘或挨着同量级邻居的大间隔是一档节奏。**
 * 具体说，一个间隔只有在「两侧都有邻居、且比两侧邻居里较大的那个还大 1.5 倍以上」
 * 时才算抖动（漏采一帧正是这个形状：前后都是 45s，中间冒出一个 90s）；其余一律算数。
 *
 * 这个判据换过三版，前两版都是**只看间隔的大小分布、不看它在时间上处在哪**，
 * 于是每一版都能被一个新的形状绕过去：
 *
 *   1. p90 —— 抽屉开满 15 分钟后 5s 样本占比超 90%，稀疏档被整个吞掉；
 *   2. 降序第 3 大 —— 稀疏档只出现 1-2 次时，正好被当成离群点丢掉；
 *   3. 「最大的那个要有同量级同伴」—— 抽屉在后台只写过两帧时打开，稀疏档**只有
 *      一个间隔**、找不到同伴，又被判成抖动（Codex P2，核对属实：实测切出 16s 的桶，
 *      前 10 个桶空了 8 个）。
 *
 * 三次都栽在同一件事上：**「大小分布」区分不了「一次漏采」和「一段更稀疏的历史」**，
 * 因为两者都可能只出现一次。真正能区分它们的是**位置**——漏采的那个间隔前后都是
 * 密的，而一段稀疏历史的间隔一定挨着窗口边缘或挨着同样稀疏的邻居。
 *
 * 代价：连续两帧都漏采时（造出一个 3 倍间隔且两侧仍是 45s），它仍会被当成抖动排除，
 * 分辨率不受影响；反过来若真有一段只含单个间隔的稀疏历史被误判……它挨着边缘，
 * 按本判据不会被误判。宁可偶尔画粗一点，也不要让整段历史变成一排空桶——
 * 前者只是少一点细节，后者是画面上看得见的梳齿。
 */
function coarsestSustained(gapsInTimeOrder: number[]): number {
  const n = gapsInTimeOrder.length;
  if (n === 1) return gapsInTimeOrder[0];
  let coarsest = 0;
  for (let i = 0; i < n; i += 1) {
    const g = gapsInTimeOrder[i];
    const atEdge = i === 0 || i === n - 1;
    if (!atEdge) {
      const neighbour = Math.max(gapsInTimeOrder[i - 1], gapsInTimeOrder[i + 1]);
      // 两侧都比它小得多 —— 这是一次漏采造出来的孤峰，不是一档节奏。
      if (g > neighbour * CADENCE_SIMILARITY) continue;
    }
    if (g > coarsest) coarsest = g;
  }
  // 全被判成抖动（例如恰好三个间隔、中间那个是孤峰）时退回最大值，不返回 0。
  return coarsest > 0 ? coarsest : Math.max(...gapsInTimeOrder);
}

function observedCadence(containers: string[], after: number, before: number): { cadenceMs: number } {
  let cadenceMs = 0;
  for (const name of containers) {
    const all = store.get(name);
    if (!all) continue;
    const ts: number[] = [];
    for (const p of all) if (p.ts >= after && p.ts <= before) ts.push(p.ts);
    if (ts.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i += 1) {
      const g = ts[i] - ts[i - 1];
      // 真实断档不参与定分辨率：它该以 null 缺口出现，而不是把整窗的桶撑粗。
      if (g <= MAX_RATE_GAP_MS) gaps.push(g);
    }
    if (gaps.length === 0) continue;
    // 不排序：判据要看每个间隔在**时间上**的邻居，排一次序这个信息就没了。
    const coarsest = coarsestSustained(gaps);
    if (coarsest > cadenceMs) cadenceMs = coarsest;
  }
  return { cadenceMs };
}

function aggregate(bucket: StoredPoint[], group: 'average' | 'max'): Omit<SeriesPoint, 'ts'> {
  /**
   * 速率可能为 null（首点 / 换生命周期 / 断档算不出来）。聚合时把 null **跳过**，
   * 一整桶都是 null 才给 null——不能当成 0 参与平均，否则「没测到」会被摊进读数里，
   * 把一个真实的速率往下拉。
   */
  const rate = (pick: (p: StoredPoint) => number | null): number | null => {
    const vals = bucket.map(pick).filter((v): v is number => v != null);
    if (vals.length === 0) return null;
    return group === 'max'
      ? Math.max(...vals)
      : vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  if (group === 'max') {
    return {
      cpuPercent: Math.max(...bucket.map((p) => p.cpuPercent)),
      memUsedBytes: Math.max(...bucket.map((p) => p.memUsedBytes)),
      rxRate: rate((p) => p.rxRate),
      txRate: rate((p) => p.txRate),
      readRate: rate((p) => p.readRate),
      writeRate: rate((p) => p.writeRate),
    };
  }
  const n = bucket.length;
  return {
    cpuPercent: bucket.reduce((s, p) => s + p.cpuPercent, 0) / n,
    memUsedBytes: bucket.reduce((s, p) => s + p.memUsedBytes, 0) / n,
    rxRate: rate((p) => p.rxRate),
    txRate: rate((p) => p.txRate),
    readRate: rate((p) => p.readRate),
    writeRate: rate((p) => p.writeRate),
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
  /*
   * 查询也触发一次过期清理（Codex P2，核对属实）。
   *
   * 上一版只在写入路径上扫。宿主上最后一个容器停掉之后**再也没有写入**，于是那些
   * 停掉的容器一个都扫不到，点全留在内存里——「只在还有人写的时候才清理」和它要
   * 治的那个洞（「只在这个容器还在写的时候才清理」）是同一个形状，只是范围大了一圈。
   *
   * 挂在查询上是有效的补充：sweepExpired 扫的是**全表**而不只是被查的那些容器，
   * 所以只要还有人打开抽屉看一眼，全部死容器就都会被清掉。两条路都限流到 60 秒一次。
   */
  sweepExpired(nowMs);
  const before = resolveBound(query.before, nowMs, nowMs);
  const after = resolveBound(query.after, nowMs, nowMs - 30 * 60_000);
  const group = query.group === 'max' ? 'max' : 'average';
  // 允许 points=1：这是「把整个窗口聚成一个数」的合法问法（顶部那个大数就用它）。
  const asked = Math.max(1, Math.min(1000, query.points ?? 120));
  const span = Math.max(1, before - after);

  /**
   * 分辨率不细于采集节奏：桶宽至少是观测节奏的 1.5 倍，否则必然出现空桶。
   *
   * 调用方要多少点是它的期望，不是它对数据密度的判断——密度只有这里知道。
   * 所以 points 是**上限**：能给的点数由 span / (节奏 × 余量) 决定，取两者较小的。
   * 1.5 倍是给采样抖动留的余量：45s 的采集器实际落点会有几秒漂移，桶宽正好 45s
   * 会让一部分桶落空、相邻桶吃到两帧。
   *
   * 下限 8 个点：观测到的节奏可能被一段异常稀疏的采样抬得很粗（比如 CDS 重启后
   * 窗口里只剩一段数据），不设下限的话它就能把整个窗口压成两三个点。
   */
  const { cadenceMs } = observedCadence(query.containers, after, before);
  const byCadence = cadenceMs > 0 ? Math.max(8, Math.ceil(span / (cadenceMs * 1.5))) : asked;
  /*
   * 这里曾有第二道闸「点数不超过样本数的 1.2 倍」，2026-09-02 拆掉（Codex P2，核对属实）。
   *
   * 它想防的是冷启动：节奏当时要三个样本才算得出来，重启后头两分钟算不出节奏，
   * 就会退回按请求值切 120 个桶。但它防的方式是**按样本个数**封顶，而桶宽 =
   * 窗口 / 桶数——窗口是完整的 30 分钟，样本却只覆盖了开头那几分钟。于是
   * 6 个 45s 样本（共覆盖 225s）得到 8 个桶、每桶 225s，6 帧全落进同一个桶：
   * `filled` 停在 1，前端继续藏图，骨架屏还在说「约还需 45 秒」——一个永远
   * 兑现不了的承诺。**封顶该按样本覆盖了多长时间，不是按样本有几个。**
   *
   * 而「覆盖了多长时间 / 有几个间隔」正是节奏本身，byCadence 已经在算它了。
   * 所以正解不是加第三道闸，是把节奏的门槛从 3 个样本降到 2 个（一个间隔就够）：
   *   - 有 ≥2 帧 → 节奏可知 → byCadence 给出正确的桶宽，冷启动不再有锯齿；
   *   - 只有 0-1 帧 → 桶数退回 asked，但前端此时 `filled ≤ 1` 本来就不画图，
   *     切多少个空桶都不会显示成锯齿。
   * 两道闸合成一道，少一个能各自漂移的判据。
   */
  const wanted = Math.min(asked, byCadence);

  /**
   * 桶边界吸附到绝对时间网格（Netdata 的做法），不跟着 `now` 漂。
   *
   * 2026-09-02 真人验收：「这个图一直在变」。病根不是动画，是**每次轮询都重新分桶**：
   * 前端每 5 秒问一次「最近 30 分钟」，`after` 跟着 `now` 走，于是所有桶边界整体
   * 平移 5 秒，同一个采样点这一次落在第 12 桶、下一次落到第 11 桶——整张图的形状
   * 每 5 秒重新洗一遍牌，看起来就是「一直在动，但动得没有道理」。
   *
   * Netdata 不这么做：它的桶宽是整秒，边界固定在「从纪元起算的整数倍」上，时间
   * 往前走时只是**在右边追加一个新桶**，已有的桶原地不动。所以图是往左推进的，
   * 不是每帧重画。这里照搬：桶宽先吸附到整秒，再把右端吸附到桶宽的整数倍，
   * 窗口从右端往回数 `wanted` 个桶。
   *
   * 锚在右端而不是左端：右端是「现在」，是唯一每次都在变的一侧；把它吸附住，
   * 新数据就只会进最后一个桶，前面的桶连内容带位置都不动。
   */
  /*
   * 桶宽按 `span / (wanted - 1)` 取，而不是 `span / wanted`。
   *
   * 右端吸附之后整条网格最多右移一个桶宽，所以要盖住请求窗口，需要的桶数是
   * `ceil((span + 位移) / 桶宽)`，最坏情况比 `span / 桶宽` 多一个。先把这一个桶的
   * 余量算进桶宽里，`wanted` 个桶就永远够用——**既不会少盖住左边（丢掉调用方要的
   * 样本），也不会多出一个桶突破 points 上限**（Codex P2，核对属实：上一版按
   * `span / wanted` 取，未对齐的窗口会返回 wanted + 1 个点）。
   *
   * points=1 是「整窗聚成一个数」的问法，它根本没有 x 轴，网格吸附对它没有意义，
   * 而吸附必然让它多出一个桶。这一档直接用请求的窗口原样。
   */
  const aligned = wanted > 1;
  const bucketMs = aligned
    ? Math.max(1_000, Math.ceil(span / (wanted - 1) / 1_000) * 1_000)
    : Math.max(1_000, span);
  const gridBefore = aligned ? Math.ceil(before / bucketMs) * bucketMs : before;
  /*
   * 桶数**恒等于 wanted**，不跟着窗口位置算（Codex P2，核对属实）。
   *
   * 上一版写的是 `min(wanted, ceil((gridBefore - after) / bucketMs))`，看着更"精确"，
   * 实际会在 wanted 与 wanted-1 之间来回跳：30 分钟窗口 / 45s 节奏这一档 wanted=27、
   * 桶宽 70s，1800/70 = 25.71，右端吸附的位移 δ 在 0..70s 之间循环，δ 小时算出 26 个、
   * δ 大时算出 27 个。而前端把返回的数组均摊到整个画幅、点数一变就关掉补间——
   * 于是每隔几十秒整张图重排一次。**我为了「图不再每 5 秒重洗牌」做的对齐，
   * 自己又造出了一个周期更长的重洗牌。**
   *
   * 固定成 wanted 是安全的：桶宽已经按 `span / (wanted - 1)` 取，所以
   * `wanted × 桶宽 ≥ span + 桶宽 > span + δ`，右端吸附再怎么位移都盖得住请求窗口。
   */
  const count = aligned ? wanted : 1;
  const gridAfter = gridBefore - count * bucketMs;

  // 先按桶归集每个容器的样本。桶边界对所有容器是同一套（同一个 gridAfter / bucketMs），
  // 这样下面才能拼出一条共享时间轴。
  const bucketsByContainer = new Map<string, Map<number, StoredPoint[]>>();
  for (const name of query.containers) {
    const all = store.get(name);
    const buckets = new Map<number, StoredPoint[]>();
    bucketsByContainer.set(name, buckets);
    if (!all) continue;
    for (const p of all) {
      /*
       * 收样本按**调用方问的那个区间**，不按吸附后的网格（Codex P2，核对属实）。
       *
       * 网格两端各自会溢出不到一个桶宽，那是为了让桶边界稳定；但它不该改变
       * 「这次查询覆盖哪段时间」。显式问一段历史时，`before` 之后十秒发生的采样
       * 若被算进最后一个桶，返回的就是**问的那一刻还没发生的数据**。
       * 网格只管几何（桶落在哪），区间只管事实（哪些样本算数），两件事分开。
       */
      if (p.ts < after || p.ts > before) continue;
      const idx = Math.min(count - 1, Math.floor((p.ts - gridAfter) / bucketMs));
      const list = buckets.get(idx);
      if (list) list.push(p); else buckets.set(idx, [p]);
    }
  }

  /**
   * 共享时间轴 = 请求窗口切出来的**全部**桶，一个不少。
   *
   * 两次缺陷叠出来的形状，两次都是「少给点」惹的祸：
   *
   * 1）容器各自跳过自己的空桶 → 全程在跑的拿 60 个点、中途停掉的拿 30 个点。
   *    前端按下标堆叠，短的那条读到 undefined → 累加成 NaN → SVG 整段不画，
   *    图上出现黑色缺口。长度不等本身就意味着下标对不上时间。
   * 2）改成「至少一个容器有数据的桶」之后仍然会少给：全员断档的桶被整个丢掉。
   *    前端只吃数值数组、把点均摊到固定宽度，于是轴被压缩——CDS 刚重启时
   *    3 分钟的数据被摊满「30 分钟」全宽，全员停机的那一段则从图上凭空消失，
   *    两侧曲线接在一起。x 轴在说谎。
   *
   * 所以轴长恒等于请求的 points：没数据的桶留在轴上，整桶给 null。
   * 「没有数据」与「用量为 0」由 null / 0 区分，不靠点数多少暗示。
   */
  const axis = Array.from({ length: count }, (_, idx) => idx);
  const timestamps = axis.map((idx) => Math.round(gridAfter + (idx + 0.5) * bucketMs));

  const series: Record<string, SeriesPoint[]> = {};
  for (const name of query.containers) {
    const buckets = bucketsByContainer.get(name);
    series[name] = axis.map((idx, i) => {
      const bucket = buckets?.get(idx);
      if (!bucket || bucket.length === 0) {
        return { ts: timestamps[i], cpuPercent: null, memUsedBytes: null, rxRate: null, txRate: null, readRate: null, writeRate: null };
      }
      return { ts: timestamps[i], ...aggregate(bucket, group) };
    });
  }

  /*
   * 返回吸附后的窗口，而不是调用方问的那个。差别不超过一个桶宽，但如实说出「这张图
   * 实际画的是哪一段」比复述提问更有用——最后一个桶通常只填了一半（它还在进行中），
   * 这也是 Netdata 的行为。
   */
  return { after: gridAfter, before: gridBefore, timestamps, groupSeconds: Math.round(bucketMs / 1000), group, series };
}

/** 测试用：清空全部历史。生产路径不调用。 */
export function __resetContainerMetricsHistory(): void {
  store.clear();
  lastSweepAt = 0;
}

/*
 * 测试用：当前跟踪多少容器、多少点。生产路径不调用（Codex P2，核对属实）。
 *
 * 原注释写着「用于排查内存增长」——那是一句兑现不了的承诺：全仓搜下来它只出现在
 * 定义和单测里，没有任何端点 / 监控 / 日志消费它，等于又建了半条线（形状 2）。
 * 真要接进诊断面是另一件事（本 PR 只做总览），已记进 doc/debt.cds.overview.md D8。
 * 在那之前，命名与注释都如实说它是测试用的，不假装生产可观测。
 */
export function __containerMetricsHistoryStats(): { containers: number; points: number } {
  let points = 0;
  for (const list of store.values()) points += list.length;
  return { containers: store.size, points };
}
