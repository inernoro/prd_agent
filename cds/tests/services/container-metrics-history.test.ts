import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  recordContainerSample,
  queryContainerSeries,
  containerMetricsHistoryStats,
  __resetContainerMetricsHistory,
} from '../../src/services/container-metrics-history.js';

const T0 = 1_800_000_000_000;
const sample = (over: Partial<{
  containerId: string; cpuPercent: number; memUsedBytes: number; memLimitBytes: number;
  netRxBytes: number; netTxBytes: number; blockReadBytes: number; blockWriteBytes: number;
}> = {}) => ({
  containerId: 'aaaa1111', cpuPercent: 1, memUsedBytes: 100, memLimitBytes: 1000,
  netRxBytes: 0, netTxBytes: 0, blockReadBytes: 0, blockWriteBytes: 0, ...over,
});

beforeEach(() => __resetContainerMetricsHistory());

/**
 * 取「真的有样本」的那些桶。
 *
 * 时间轴恒等于请求窗口的全部桶（没数据的整桶给 null），所以 `[0]` / `.at(-1)`
 * 拿到的往往是窗口两端的空桶，而不是最早/最新的那次采样。速率相关的用例问的是
 * 差分算得对不对，跟轴上有多少空桶无关，所以先滤掉空桶再断言。
 */
const withData = (points: Array<{ cpuPercent: number | null }>) => points.filter((p) => p.cpuPercent != null);

/**
 * 「轴覆盖整个请求窗口」的判据。
 *
 * 早先这里写的是精确点数（toBe(60) / toBe(120)），那是把当时的实现锁死：
 * 点数是由请求值、采集节奏、样本数三者取小算出来的，任何一档收紧都会让这些
 * 断言变红，而轴该覆盖整个窗口这件事其实一点没变（形状 4a：反向锁死实现）。
 * 现在只问两端——第一个桶贴着窗口起点、最后一个桶贴着窗口终点。
 */
const expectSpansWindow = (r: { after: number; before: number; timestamps: number[] }): void => {
  const span = r.before - r.after;
  const tolerance = span / Math.max(1, r.timestamps.length);
  expect(r.timestamps.length).toBeGreaterThan(1);
  expect(r.timestamps[0] - r.after, '第一个桶没贴着窗口起点，轴被压缩了').toBeLessThanOrEqual(tolerance);
  expect(r.before - (r.timestamps.at(-1) ?? 0), '最后一个桶没贴着窗口终点').toBeLessThanOrEqual(tolerance);
};

describe('速率由累计值差分算出', () => {
  it('两点之间的累计差除以间隔 = bytes/sec', () => {
    recordContainerSample('c1', sample({ netRxBytes: 0 }), T0);
    recordContainerSample('c1', sample({ netRxBytes: 10_000 }), T0 + 10_000);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 20_000, points: 10 }, T0 + 20_000);
    expect(withData(series.c1).at(-1)?.rxRate).toBeCloseTo(1000, 3);
  });

  /**
   * 首点没有可减的前一点，速率**算不出来**——那是 null，不是 0（Codex P2，核对属实）。
   *
   * 这条原来断言 `toBe(0)`，等于把「没测到当成测到了 0」锁死成契约（形状 4a）：
   * 那一桶的 CPU 是有值的、桶被标成 present，于是吞吐图照着画出一次「掉到零又爬回来」
   * ——和最初那道谷是同一种谎，只是发生在速率这一维上。
   */
  it('首点算不出速率，给 null 而不是 0', () => {
    recordContainerSample('c1', sample({ netRxBytes: 999 }), T0);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 1000, points: 4 }, T0 + 1000);
    const first = withData(series.c1)[0];
    expect(first.cpuPercent, '这一桶本身是有样本的').not.toBeNull();
    expect(first.rxRate, '把「算不出来」写成 0，图上就会多一次凭空的掉零').toBeNull();
  });

  /**
   * 容器重建后 docker 的累计计数器归零。差值为负不是「负流量」，是换了个容器。
   * 不钉住这条，图上会画出一根扎到底的负峰。
   */
  it('容器重建导致累计值回绕时记 0，不出负数', () => {
    recordContainerSample('c1', sample({ netRxBytes: 5_000_000 }), T0);
    recordContainerSample('c1', sample({ netRxBytes: 1_000 }), T0 + 5_000);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 10_000, points: 10 }, T0 + 10_000);
    // 速率现在可能是 null（算不出来），断言只针对**算得出来**的那些：一个负数都不许有。
    const rates = withData(series.c1).map((p) => p.rxRate).filter((v): v is number => v != null);
    expect(rates.length, '一个算得出来的速率都没有，这条断言会空跑').toBeGreaterThan(0);
    for (const v of rates) expect(v).toBeGreaterThanOrEqual(0);
  });

  /**
   * 中间断档（CDS 重启 / docker 不可用）后，用「大差值 ÷ 大间隔」算出来的速率
   * 是假的平均值，会把一段根本没有观测的时间画成平坦流量。
   */
  it('间隔超过上限就不算速率（断档给 null，不编 0）', () => {
    recordContainerSample('c1', sample({ netRxBytes: 0 }), T0);
    recordContainerSample('c1', sample({ netRxBytes: 100_000_000 }), T0 + 30 * 60_000);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 31 * 60_000, points: 50 }, T0 + 31 * 60_000);
    const last = withData(series.c1).at(-1);
    expect(last?.cpuPercent).not.toBeNull();
    expect(last?.rxRate, '断档后的第一帧没有可减的前一点，是 null 不是 0').toBeNull();
  });

  it('同名重建后的第一帧也是 null（换了生命周期，没有可减的前一点）', () => {
    recordContainerSample('c1', sample({ containerId: 'aaaa1111', netRxBytes: 5_000 }), T0);
    recordContainerSample('c1', sample({ containerId: 'bbbb2222', netRxBytes: 9_000 }), T0 + 45_000);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 46_000, points: 20 }, T0 + 46_000);
    expect(withData(series.c1).at(-1)?.rxRate, '跨生命周期不能做差，也不能记 0').toBeNull();
  });

  it('同一毫秒或更旧的点被忽略（两路采集者可能同时落点）', () => {
    recordContainerSample('c1', sample({ cpuPercent: 1 }), T0);
    recordContainerSample('c1', sample({ cpuPercent: 99 }), T0);
    recordContainerSample('c1', sample({ cpuPercent: 98 }), T0 - 5_000);
    expect(containerMetricsHistoryStats().points).toBe(1);
  });
});

describe('同名重建 = 新的生命周期（Codex P2，核对属实）', () => {
  /**
   * 部署会复用容器名。只靠「新累计值比旧的小」判重建是漏的：新容器若在第一次采样前
   * 已经比旧容器最后一次读数跑得更多，差值仍为正 —— 于是记出一个巨大的假速率尖峰。
   * 容器短 ID 在重建时必变，是可靠的身份信号。
   */
  it('容器 ID 变了就不跨生命周期做差，哪怕累计值是涨的', () => {
    recordContainerSample('c1', sample({ containerId: 'old', netRxBytes: 1_000 }), T0);
    // 新容器：ID 变了，而且累计值比旧容器**更大**（旧判据抓不到）
    recordContainerSample('c1', sample({ containerId: 'new', netRxBytes: 500_000 }), T0 + 5_000);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 10_000, points: 10 }, T0 + 10_000);
    const pts = series.c1.filter((p) => p.rxRate != null);
    for (const p of pts) {
      expect(p.rxRate, `跨生命周期做差会记出 ${(499000 / 5).toFixed(0)} B/s 的假尖峰`).toBe(0);
    }
  });

  it('容器 ID 没变时照常差分（别把正常采样也切断）', () => {
    recordContainerSample('c1', sample({ containerId: 'same', netRxBytes: 0 }), T0);
    recordContainerSample('c1', sample({ containerId: 'same', netRxBytes: 10_000 }), T0 + 10_000);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 20_000, points: 10 }, T0 + 20_000);
    expect(series.c1.filter((p) => p.rxRate != null).at(-1)?.rxRate).toBeCloseTo(1000, 3);
  });

  it('采样方没给 ID 时退化为旧行为，不因此把速率全判 0', () => {
    recordContainerSample('c1', { cpuPercent: 1, memUsedBytes: 1, memLimitBytes: 1, netRxBytes: 0, netTxBytes: 0 }, T0);
    recordContainerSample('c1', { cpuPercent: 1, memUsedBytes: 1, memLimitBytes: 1, netRxBytes: 10_000, netTxBytes: 0 }, T0 + 10_000);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 20_000, points: 10 }, T0 + 20_000);
    expect(series.c1.filter((p) => p.rxRate != null).at(-1)?.rxRate).toBeCloseTo(1000, 3);
  });
});

describe('磁盘 I/O（2026-09-02 补采：docker stats 一直在给，采集器一直在扔）', () => {
  it('块设备累计值差分出读写速率，口径与网络一致', () => {
    recordContainerSample('c1', sample({ blockReadBytes: 0, blockWriteBytes: 0 }), T0);
    recordContainerSample('c1', sample({ blockReadBytes: 20_000, blockWriteBytes: 5_000 }), T0 + 10_000);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 20_000, points: 10 }, T0 + 20_000);
    const pts = series.c1.filter((p) => p.readRate != null);
    expect(pts.at(-1)?.readRate).toBeCloseTo(2000, 3);
    expect(pts.at(-1)?.writeRate).toBeCloseTo(500, 3);
  });

  it('容器重建导致块设备累计值回绕时记 0，不出负数', () => {
    recordContainerSample('c1', sample({ blockReadBytes: 9_000_000 }), T0);
    recordContainerSample('c1', sample({ blockReadBytes: 1_000 }), T0 + 5_000);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 10_000, points: 10 }, T0 + 10_000);
    for (const p of series.c1) if (p.readRate != null) expect(p.readRate).toBeGreaterThanOrEqual(0);
  });

  it('空桶的磁盘速率也是 null，不是 0（与其它维度同一口径）', () => {
    recordContainerSample('c1', sample({ blockReadBytes: 1_000 }), T0);
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: T0 + 600_000, points: 20 }, T0 + 600_000);
    const empties = r.series.c1.filter((p) => p.cpuPercent == null);
    expect(empties.length).toBeGreaterThan(0);
    for (const p of empties) expect(p.readRate).toBeNull();
  });
});

describe('查询窗口与降采样（借 Netdata 的 after / points / group 形状）', () => {
  const fill = (n: number, stepMs: number) => {
    for (let i = 0; i < n; i += 1) {
      recordContainerSample('c1', sample({ cpuPercent: i % 10, netRxBytes: i * 1000 }), T0 + i * stepMs);
    }
  };

  it('after 为负数表示「相对现在往前多少秒」', () => {
    fill(60, 5_000);
    const now = T0 + 60 * 5_000;
    const r = queryContainerSeries({ containers: ['c1'], after: -60, points: 100 }, now);
    /*
     * 返回的窗口是**吸附到桶网格之后**的那一个，不是逐字复述提问：桶边界固定在
     * 桶宽的整数倍上（Netdata 的做法，见 queryContainerSeries 里的说明），
     * 所以两端各自最多偏移一个桶宽。早先这里断言 `toBe(now - 60_000)`，那是把
     * 「边界跟着 now 漂」这件事当成契约锁死了（形状 4a）——正是它让图每 5 秒
     * 重新洗一次牌。这里改成断言语义：窗口确实盖住了请求的那 60 秒。
     */
    const bucketMs = r.groupSeconds * 1_000;
    expect(r.after, '窗口起点没盖住请求的 60 秒前').toBeLessThanOrEqual(now - 60_000);
    expect(now - 60_000 - r.after, '起点偏出去超过一个桶宽').toBeLessThan(bucketMs);
    expect(r.before, '窗口终点没盖住现在').toBeGreaterThanOrEqual(now);
    expect(r.before - now, '终点偏出去超过一个桶宽').toBeLessThan(bucketMs);
    for (const p of r.series.c1) expect(p.ts).toBeGreaterThanOrEqual(r.after);
  });

  /**
   * 2026-09-02 真人验收：「这个图一直在变」。
   *
   * 病根是每次轮询都跟着 `now` 重新分桶——同一个采样点这一次落第 12 桶、
   * 5 秒后落第 11 桶，整张图每 5 秒重洗一次牌。Netdata 把桶边界钉在绝对时间
   * 网格上，时间往前走只是在右边追加新桶。
   */
  it('时间往前走时桶边界不动，已有的桶原地不动（图往左推进，不是每帧重画）', () => {
    for (let t = 0; t <= 30 * 60_000; t += 45_000) recordContainerSample('c1', sample({ cpuPercent: 3 }), T0 + t);
    const base = T0 + 30 * 60_000;
    const first = queryContainerSeries({ containers: ['c1'], after: -1800, points: 120 }, base);
    // 5 秒后再问一次（前端就是这个节奏）——还没跨过一个桶宽。
    const later = queryContainerSeries({ containers: ['c1'], after: -1800, points: 120 }, base + 5_000);
    expect(later.groupSeconds).toBe(first.groupSeconds);
    expect(
      later.timestamps[0] - first.timestamps[0],
      '桶边界跟着 now 漂了：同一个采样点会在两次查询里落进不同的桶，图因此每 5 秒重新洗牌',
    ).toBe(0);
    expect(later.timestamps.at(-1)).toBe(first.timestamps.at(-1));
  });

  it('点数不超过请求值，且窗口被等宽切分（x 轴恒等间隔）', () => {
    fill(200, 1_000);
    const now = T0 + 200_000;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 20 }, now);
    expect(r.series.c1.length).toBeLessThanOrEqual(20);
    const gaps = r.series.c1.slice(1).map((p, i) => p.ts - r.series.c1[i].ts);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 0);
  });

  /**
   * 两路采集者间隔不同（45s 与 5s），按「每 N 个点抽一个」降采样会让时间轴疏密不均——
   * 图上看着像流量突变，其实只是采样率变了。所以必须按时间等宽分桶。
   */
  it('混合采样率下按时间分桶，不是按点数抽样', () => {
    // 前 450s 是 45s 一帧（10 点，cpu=1），后 300s 是 5s 一帧（60 点，cpu=9）。
    // 稀疏段占了窗口的 60% 时间，却只占 14% 的点数。
    // 按时间分桶 → 约 60% 的桶是 cpu=1；按点数抽样 → 只有约 14%。
    // 断言只看「时间轴等间隔」是抓不到的：桶的时间戳由 after+idx*bucket 算出，
    // 无论怎么分桶都必然等间隔（那种断言是被构造方式喂饱的，不是真判据）。
    for (let i = 0; i < 10; i += 1) recordContainerSample('c1', sample({ cpuPercent: 1 }), T0 + i * 45_000);
    for (let i = 0; i < 60; i += 1) recordContainerSample('c1', sample({ cpuPercent: 9 }), T0 + 450_000 + i * 5_000);
    const now = T0 + 750_000;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 20 }, now);
    const sparseShare = r.series.c1.filter((p) => p.cpuPercent < 5).length / r.series.c1.length;
    expect(sparseShare, `稀疏段占了 60% 的时间，桶占比却是 ${(sparseShare * 100).toFixed(0)}%`).toBeGreaterThan(0.45);
  });

  it('空桶不补零（补零会画出并不存在的「掉到 0」）', () => {
    recordContainerSample('c1', sample({ cpuPercent: 5 }), T0);
    recordContainerSample('c1', sample({ cpuPercent: 5 }), T0 + 100_000);
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: T0 + 100_000, points: 20 }, T0 + 100_000);
    // 断言的是「空桶给 null 而不是 0」这件事本身。
    // 早先这里写的是 `length === 2`——那是把「空桶被从轴上删掉」这个缺陷
    // 当成契约锁死了（形状 4a：反向锁死 bug），修缺陷时它会变红。
    const withData = r.series.c1.filter((p) => p.cpuPercent != null);
    expect(withData.length).toBe(2);
    for (const p of withData) expect(p.cpuPercent).toBe(5);
    for (const p of r.series.c1) expect(p.cpuPercent).not.toBe(0);
  });

  /**
   * 2026-09-01 第二个真实缺陷（Codex review 报出，核对属实）。
   *
   * 病象：CDS 刚重启，历史里只有 3 分钟数据，图却画满整个「30 分钟」宽度——
   * 12 个点被摊开铺满全宽，看着像 30 分钟一直有量。全员停机的那一段同理：
   * 那段时间直接从轴上消失，两侧的曲线接在一起，停机在图上看不出来。
   *
   * 病根：时间轴只由「至少有一个容器有数据」的桶拼出来（usedBuckets），
   * 全员空的桶被整个丢掉。前端只吃数值数组、把点均摊到固定宽度上，
   * 于是轴被压缩，x 轴在说谎。
   *
   * 修法：请求窗口内的每一个桶都出现在轴上，没数据就整桶给 null。
   */
  it('全员断档的那一段仍留在轴上（否则时间轴被压缩，停机看不出来）', () => {
    // 窗口 1200s / 60 桶 = 每桶 20s。前 200s 与后 200s 有量，中间 800s 全员停机。
    for (let i = 0; i < 20; i += 1) recordContainerSample('a', sample({ cpuPercent: 2 }), T0 + i * 10_000);
    for (let i = 0; i < 20; i += 1) recordContainerSample('b', sample({ cpuPercent: 3 }), T0 + i * 10_000);
    for (let i = 0; i < 20; i += 1) recordContainerSample('a', sample({ cpuPercent: 4 }), T0 + 1_000_000 + i * 10_000);
    for (let i = 0; i < 20; i += 1) recordContainerSample('b', sample({ cpuPercent: 5 }), T0 + 1_000_000 + i * 10_000);
    const now = T0 + 1_200_000;
    const r = queryContainerSeries({ containers: ['a', 'b'], after: T0, before: now, points: 60 }, now);

    expectSpansWindow(r);
    // 中间那 800s 必须真的以 null 的形式留在轴上。
    // 按**时间**挑，不按下标挑：点数是算出来的，写死下标等于把当时的实现锁进断言。
    // 两端各让开一个桶宽，避免边界桶同时吃到有数据的那一侧。
    const bucketMs = (r.before - r.after) / r.timestamps.length;
    const holeA = r.series.a.filter((p) => p.ts > T0 + 200_000 + bucketMs && p.ts < T0 + 1_000_000 - bucketMs);
    expect(holeA.length, '断档区间里一个桶都没有，判据挑空了').toBeGreaterThan(0);
    for (const p of holeA) expect(p.cpuPercent).toBeNull();
    /*
     * 两端有量的那两段还在——**按时间挑，不挑第 0 个桶**。
     *
     * 轴是右端对齐的固定桶数网格，左端因此会比请求起点早最多一两个桶（这是固定桶数
     * 换来的代价，见 queryContainerSeries 里的说明），第 0 个桶可能正好落在数据开始
     * 之前。原来那句 `series.a[0] 不为 null` 断言的是「轴恰好从数据处起头」，那是
     * 实现细节不是契约（形状 4a）。这里问的是真正在意的事：前后两段各自有数据。
     */
    const headHasData = r.series.a.some((p) => p.ts >= T0 && p.ts < T0 + 200_000 && p.cpuPercent != null);
    const tailHasData = r.series.a.some((p) => p.ts > T0 + 1_000_000 && p.cpuPercent != null);
    expect(headHasData, '窗口前段（有量的那 200 秒）在轴上没有任何数据').toBe(true);
    expect(tailHasData, '窗口后段（有量的那 200 秒）在轴上没有任何数据').toBe(true);
  });

  /**
   * 2026-09-02 真人验收报出的缺陷（截图：一片均匀锯齿林）。
   *
   * 病象：常驻采样器 45s 一帧，前端按 120 点要 30 分钟窗口 → 每桶 15s → 三个桶里
   * 只有一个有样本。空桶在堆叠图里画成 0，于是每个尖峰是一次真实采样、每个谷底是
   * 「没数据」。**图画的是采集节奏，不是 CPU。**
   *
   * 修法：分辨率不细于观测到的采集节奏——points 只是上限，桶宽至少是节奏的 1.5 倍。
   */
  it('分辨率不细于采集节奏：45s 采样要 120 点也不会切出成片空桶', () => {
    const cadence = 45_000;
    const windowMs = 30 * 60_000;
    for (let t = 0; t <= windowMs; t += cadence) {
      recordContainerSample('c1', sample({ cpuPercent: 3 }), T0 + t);
    }
    const now = T0 + windowMs;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 120 }, now);

    const empty = r.series.c1.filter((p) => p.cpuPercent == null).length;
    const emptyShare = empty / r.series.c1.length;
    expect(
      emptyShare,
      `${r.series.c1.length} 个桶里 ${empty} 个是空的（桶宽 ${r.groupSeconds}s，采集节奏 ${cadence / 1000}s）——空桶会被画成 0，成片锯齿`,
    ).toBeLessThan(0.1);
    expect(r.groupSeconds, '桶宽必须不小于采集节奏').toBeGreaterThanOrEqual(cadence / 1000);
    expect(r.series.c1.length).toBeLessThanOrEqual(120);
  });

  /**
   * 抽屉打开时 5s 端点也在写，窗口里混着两种间隔。取中位数会被密的那段拉过去
   * （开着抽屉五分钟就够了），稀疏段照样锯齿——所以判据取 p90「常规最大间隔」。
   */
  it('混着 5s 与 45s 两种采集节奏时，分辨率跟稀疏的那一档走', () => {
    const windowMs = 30 * 60_000;
    for (let t = 0; t <= 25 * 60_000; t += 45_000) recordContainerSample('c1', sample({ cpuPercent: 2 }), T0 + t);
    for (let t = 25 * 60_000; t <= windowMs; t += 5_000) recordContainerSample('c1', sample({ cpuPercent: 4 }), T0 + t);
    const now = T0 + windowMs;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 120 }, now);

    expect(r.groupSeconds, '被 5s 那段带偏就会退回锯齿').toBeGreaterThanOrEqual(45);
    // 稀疏段（前 25 分钟）里不该有成片空桶。
    const sparse = r.series.c1.filter((p) => p.ts < T0 + 25 * 60_000);
    const emptyInSparse = sparse.filter((p) => p.cpuPercent == null).length;
    expect(emptyInSparse / sparse.length).toBeLessThan(0.1);
  });

  /**
   * Codex P2（核对属实）：冷启动那道闸按**样本个数**封顶，把仅有的几帧压进同一个桶。
   *
   * 桶宽 = 窗口 / 桶数，而窗口恒是完整的 30 分钟、样本却只覆盖开头那几分钟。
   * 于是 6 个 45s 样本（共覆盖 225s）拿到 8 个桶、每桶 225s，6 帧全落进一个桶：
   * 前端的 `filled >= 2` 永远不成立，图一直藏着，骨架屏还在说「约还需 45 秒」。
   *
   * 封顶该按**样本覆盖了多长时间**，不是按样本有几个——而那正是采集节奏本身。
   */
  it('攒够六帧就必须落进至少两个桶（冷启动不许把仅有的几帧压成一个）', () => {
    const now = T0 + 30 * 60_000;
    for (let i = 5; i >= 0; i -= 1) {
      recordContainerSample('c1', sample({ cpuPercent: 2 + i }), now - i * 45_000);
    }
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 120 }, now);
    const filled = r.series.c1.filter((p) => p.cpuPercent != null).length;
    expect(
      filled,
      `6 帧 45s 样本只落进 ${filled} 个桶（桶宽 ${r.groupSeconds}s）——前端要两个非空桶才画图，`
      + '压成一个就等于图永远出不来',
    ).toBeGreaterThanOrEqual(2);
  });

  /**
   * 上面那条放宽了桶数，这条守住它放宽之后仍不该越的线：**桶宽不细于观测节奏**。
   * 两者一起才是完整判据——只放宽会退回锯齿，只收紧会把几帧压成一个桶。
   */
  it('只有两帧时，桶宽仍不细于观测到的节奏', () => {
    recordContainerSample('c1', sample({ cpuPercent: 3 }), T0 + 29 * 60_000);
    recordContainerSample('c1', sample({ cpuPercent: 4 }), T0 + 29 * 60_000 + 45_000);
    const now = T0 + 30 * 60_000;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 120 }, now);
    expect(r.groupSeconds, '两帧之间就是 45s，桶宽比它还细必然切出成片空桶').toBeGreaterThanOrEqual(45);
    expect(r.series.c1.filter((p) => p.cpuPercent != null).length).toBeGreaterThan(0);
  });

  /**
   * Codex P2（核对属实）：抽屉开够一刻钟，按数量取的分位数会被密的那一档吞掉。
   *
   * 30 分钟窗口里抽屉开 T 分钟：5s 样本 12T 个、45s 段 1.33(30−T) 个，
   * 5s 间隔占比超过 90% 只需要 T > 15。也就是说 p90 到 16 分钟就变成 5s，
   * 又切出 120 个 15s 的桶，老的那三分之二全空——锯齿原样回来。
   */
  it('抽屉开满 16 分钟后，稀疏那一档仍然决定分辨率（分位数会在这里失效）', () => {
    const windowMs = 30 * 60_000;
    const liveMs = 16 * 60_000;             // 抽屉开着的这一段是 5s 一帧
    const sparseEnd = windowMs - liveMs;
    for (let t = 0; t <= sparseEnd; t += 45_000) recordContainerSample('c1', sample({ cpuPercent: 2 }), T0 + t);
    for (let t = sparseEnd; t <= windowMs; t += 5_000) recordContainerSample('c1', sample({ cpuPercent: 4 }), T0 + t);
    const now = T0 + windowMs;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 120 }, now);

    expect(r.groupSeconds, '被 5s 那一档吞掉就会退回锯齿').toBeGreaterThanOrEqual(45);
    const sparse = r.series.c1.filter((p) => p.ts < T0 + sparseEnd);
    const empty = sparse.filter((p) => p.cpuPercent == null).length;
    expect(
      empty / sparse.length,
      `稀疏段 ${sparse.length} 个桶里空了 ${empty} 个（桶宽 ${r.groupSeconds}s）`,
    ).toBeLessThan(0.1);
  });

  it('偶发漏采一帧不会把整张图的分辨率减半（容忍两次抖动）', () => {
    const windowMs = 30 * 60_000;
    let t = 0;
    let i = 0;
    while (t <= windowMs) {
      recordContainerSample('c1', sample({ cpuPercent: 3 }), T0 + t);
      // 第 5 帧后漏采一次，造出一个 90s 的双倍间隔
      t += (i === 5 ? 90_000 : 45_000);
      i += 1;
    }
    const now = T0 + windowMs;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 120 }, now);
    expect(r.groupSeconds, '一次抖动不该让桶宽翻倍').toBeLessThan(45 * 1.5 * 1.6);
  });

  /**
   * Codex P2（核对属实）：抽屉在后台采样器攒够 4 帧之前就打开。
   *
   * 此时窗口里只有 1-2 个 45s 间隔，后面全是 5s 的。上一版判据是「降序取第 3 大」
   * （容忍两次抖动），这两个稀疏间隔正好被当成离群点丢掉，节奏又变成 5s——
   * 于是 30 分钟切 120 个 15s 的桶，前面那段稀疏数据三分之二是空桶。
   *
   * 「出现次数少」不等于「是异常」：一档节奏可以只出现两次。
   */
  it('稀疏档只出现两次也算一档节奏，不许当离群点丢掉', () => {
    // 后台采样器只来得及写 3 帧（造出**恰好 2 个** 45s 间隔），随后抽屉打开、5s 端点接管。
    // 三帧写在 0 / 45s / 90s，密集档紧接着从 95s 开始——中间不能再留出第三个 45s 间隔，
    // 否则就凑够三个、连旧判据都能挑中，这条用例会变成永远绿的摆设。
    for (const t of [0, 45_000, 90_000]) recordContainerSample('c1', sample({ cpuPercent: 3 }), T0 + t);
    for (let t = 95_000; t <= 30 * 60_000; t += 5_000) recordContainerSample('c1', sample({ cpuPercent: 4 }), T0 + t);
    const now = T0 + 30 * 60_000;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 120 }, now);
    expect(
      r.groupSeconds,
      `桶宽 ${r.groupSeconds}s 比稀疏档的 45s 还细——那两个 45s 间隔被当成离群点丢了`,
    ).toBeGreaterThanOrEqual(45);
  });

  /**
   * Codex P2（核对属实）：两个写入方（45s 采样器 / 5s 端点）可能相隔几毫秒落点。
   *
   * 速率 = 累计差 / 间隔。除以 0.001 秒能把一次普通增量放大成几十 MB/s 的假尖峰。
   */
  it('相隔不到 1 秒的第二次写入被丢弃（否则除出天文数字的假速率）', () => {
    recordContainerSample('c1', sample({ netRxBytes: 0 }), T0);
    recordContainerSample('c1', sample({ netRxBytes: 100_000 }), T0 + 45_000);
    // 另一个写入方在 3 毫秒后也落了一条：累计值只多了一点点，间隔却是 0.003 秒。
    recordContainerSample('c1', sample({ netRxBytes: 100_300 }), T0 + 45_003);
    const now = T0 + 45_010;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 60 }, now);
    const peak = Math.max(...r.series.c1.map((p) => p.rxRate ?? 0));
    expect(
      peak,
      `峰值 ${Math.round(peak)} B/s——300 字节除以 3 毫秒造出来的假尖峰，真实速率只有约 2222 B/s`,
    ).toBeLessThan(10_000);
  });

  it('相隔正好 1 秒的写入仍然收下（去重不许误伤真实节奏）', () => {
    recordContainerSample('c1', sample({ cpuPercent: 1 }), T0);
    recordContainerSample('c1', sample({ cpuPercent: 9 }), T0 + 1_000);
    expect(containerMetricsHistoryStats().points).toBe(2);
  });

  /**
   * Codex P2（核对属实）：网格吸附不许突破 points 上限。
   *
   * `before` 默认是 `Date.now()`，几乎不可能正好落在桶边界上；右端向上吸附之后
   * 整条网格右移不到一个桶宽，若桶宽仍按 `span / points` 取，就需要 points + 1 个桶
   * 才能盖住请求窗口——上一版正是这样，未对齐的 30 分钟查询 points=1 返回 2 个点、
   * points=120 返回 121 个。
   */
  it('窗口未对齐到桶边界时，点数仍不超过请求值', () => {
    for (let t = 0; t <= 30 * 60_000; t += 45_000) recordContainerSample('c1', sample({ cpuPercent: 3 }), T0 + t);
    // 故意让 before 落在桶边界之间（+1234ms），这是真实调用的常态。
    const now = T0 + 30 * 60_000 + 1_234;
    for (const points of [1, 5, 20, 120]) {
      const r = queryContainerSeries({ containers: ['c1'], after: now - 30 * 60_000, before: now, points }, now);
      expect(
        r.series.c1.length,
        `points=${points} 却返回了 ${r.series.c1.length} 个点（桶宽 ${r.groupSeconds}s）`,
      ).toBeLessThanOrEqual(points);
      // 同时仍要盖住请求窗口，不能靠砍点数达标。
      expect(r.after).toBeLessThanOrEqual(now - 30 * 60_000);
      expect(r.before).toBeGreaterThanOrEqual(now);
    }
  });

  /**
   * Codex P2（核对属实）：网格两端会溢出不到一个桶宽，但那只该影响几何，不该
   * 改变「这次查询覆盖哪段时间」。显式问一段历史时，`before` 之后发生的采样若被
   * 算进最后一个桶，返回的就是问的那一刻还没发生的数据。
   */
  it('显式指定的历史区间外的样本不算数（网格溢出只管几何，不管事实）', () => {
    recordContainerSample('c1', sample({ cpuPercent: 5 }), T0 + 10_000);
    /*
     * 这一帧发生在 before 之后——问「到 T0+60.5s 为止」时它还没发生。
     *
     * 60_500 与 62_000 都是**量出来的**，不是随手写的：这一档桶宽 4s、右端吸附到
     * T0+64s，网格溢出区间是 (60.5s, 64s]。第一版把 before 写成整 60s、把这一帧
     * 放在 +10s，结果两端都正好落在桶边界上、根本没有溢出，**旧写法也会把它排除**
     * ——用例永远绿，什么都没测（形状 4b：空跑的绿灯）。实测确认：改成这组数值后，
     * 旧写法读到峰值 99，新写法读到 5。
     */
    recordContainerSample('c1', sample({ cpuPercent: 99 }), T0 + 62_000);
    const r = queryContainerSeries(
      { containers: ['c1'], after: T0, before: T0 + 60_500, points: 20, group: 'max' },
      T0 + 120_000,
    );
    const peak = Math.max(...r.series.c1.map((p) => p.cpuPercent ?? 0));
    expect(peak, '截止时刻之后的采样被算进来了').toBe(5);
  });

  /**
   * Codex P2（核对属实）：桶数不能跟着窗口位置在 wanted 与 wanted-1 之间跳。
   *
   * 前端把返回的数组均摊到整个画幅、点数一变就关掉补间。桶数每隔几十秒变一次，
   * 整张图就每隔几十秒重排一次——我为了「不再每 5 秒重洗牌」做的网格对齐，
   * 自己造出了一个周期更长的重洗牌。
   */
  it('时间在一个桶宽内推进时，点数一个都不变（否则整张图周期性重排）', () => {
    for (let t = 0; t <= 40 * 60_000; t += 45_000) recordContainerSample('c1', sample({ cpuPercent: 3 }), T0 + t);
    const base = T0 + 40 * 60_000;
    const first = queryContainerSeries({ containers: ['c1'], after: -1800, points: 120 }, base);
    const bucketMs = first.groupSeconds * 1_000;
    // 扫过一整个桶宽：如果桶数跟位置有关，这一圈里必然出现不同的长度。
    for (let step = 1; step <= 10; step += 1) {
      const at = base + Math.round((step * bucketMs) / 10);
      const r = queryContainerSeries({ containers: ['c1'], after: -1800, points: 120 }, at);
      expect(
        r.series.c1.length,
        `now 前进 ${at - base}ms 后点数从 ${first.series.c1.length} 变成 ${r.series.c1.length}——图会整张重排`,
      ).toBe(first.series.c1.length);
      expect(r.groupSeconds).toBe(first.groupSeconds);
      // 变不变都不许丢掉请求窗口。
      expect(r.after).toBeLessThanOrEqual(at - 1800_000);
      expect(r.before).toBeGreaterThanOrEqual(at);
    }
  });

  /**
   * Codex P2（核对属实）：保留期修剪原本只在「同一个容器再次写入」时发生。
   * 容器一停，它那份数组就再没人碰，最多 2000 个点一直躺到「容器数超上限」——
   * 宿主上换过的容器名不到 400 个时那一天永远不来，声称的保留期对死掉的容器从未生效。
   */
  it('宿主再也没有写入时，一次查询也能把死容器清掉', () => {
    recordContainerSample('dead', sample({ cpuPercent: 1 }), T0);
    expect(containerMetricsHistoryStats().containers).toBe(1);
    // 之后**再没有任何写入**（最后一个容器也停了），只有人打开抽屉看了一眼。
    queryContainerSeries({ containers: ['dead'], after: -60, points: 20 }, T0 + 3 * 60 * 60_000);
    expect(
      containerMetricsHistoryStats().containers,
      '没有写入就永远清不掉——「只在还有人写时才清理」和它要治的洞是同一个形状',
    ).toBe(0);
  });

  it('停掉的容器也会按保留期过期，不是只在它自己再写入时才清', () => {
    recordContainerSample('dead', sample({ cpuPercent: 1 }), T0);
    expect(containerMetricsHistoryStats().containers).toBe(1);
    // 'dead' 再也不写了；另一个容器在保留期之后继续写。
    recordContainerSample('alive', sample({ cpuPercent: 2 }), T0 + 3 * 60 * 60_000);
    expect(
      containerMetricsHistoryStats().containers,
      '停掉的容器还占着内存——保留期只对还在写的容器生效',
    ).toBe(1);
  });

  /**
   * Codex P2（核对属实）：稀疏档**只有一个间隔**的情形。
   *
   * 抽屉在后台采样器只写过两帧时打开——窗口里恰好一个 45s 间隔，后面全是 5s 的。
   * 「最大的那个要有同量级同伴」那一版判据在这里找不到同伴，把它当成抖动丢掉，
   * 于是又切出十几秒的桶，前面那段全是空桶。
   *
   * 三版判据都栽在同一件事上：只看间隔的大小分布，区分不了「一次漏采」和
   * 「一段更稀疏的历史」——两者都可能只出现一次。能区分的是**位置**。
   */
  it('稀疏档只有一个间隔（挨着窗口边缘）也算一档节奏', () => {
    for (const t of [0, 45_000]) recordContainerSample('c1', sample({ cpuPercent: 3 }), T0 + t);
    for (let t = 50_000; t <= 30 * 60_000; t += 5_000) recordContainerSample('c1', sample({ cpuPercent: 4 }), T0 + t);
    const now = T0 + 30 * 60_000;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 120 }, now);
    expect(
      r.groupSeconds,
      `桶宽 ${r.groupSeconds}s 比稀疏档的 45s 还细——那唯一一个 45s 间隔被当成抖动丢了`,
    ).toBeGreaterThanOrEqual(45);
  });

  it('夹在密集档中间的孤峰仍算抖动（不能为了上一条把漏采也当成节奏）', () => {
    // 45s 一帧，中间漏采一帧造出 90s 的孤峰，前后邻居都是 45s。
    let t = 0;
    for (let i = 0; t <= 30 * 60_000; i += 1) {
      recordContainerSample('c1', sample({ cpuPercent: 3 }), T0 + t);
      t += i === 8 ? 90_000 : 45_000;
    }
    const now = T0 + 30 * 60_000;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 120 }, now);
    expect(r.groupSeconds, '一次漏采把桶宽顶到了 90s 那一档').toBeLessThan(45 * 1.5 * 1.6);
  });

  it('真实断档不参与定分辨率（否则一次重启就把整窗压成几个点）', () => {
    const windowMs = 30 * 60_000;
    // 前 5 分钟有量，然后断 12 分钟（> MAX_RATE_GAP_MS），再恢复
    for (let t = 0; t <= 5 * 60_000; t += 45_000) recordContainerSample('c1', sample({ cpuPercent: 2 }), T0 + t);
    for (let t = 17 * 60_000; t <= windowMs; t += 45_000) recordContainerSample('c1', sample({ cpuPercent: 3 }), T0 + t);
    const now = T0 + windowMs;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 120 }, now);
    expect(r.groupSeconds, '12 分钟的断档不该被当成采集节奏').toBeLessThan(180);
    // 断档本身仍以 null 缺口呈现
    const hole = r.series.c1.filter((p) => p.ts > T0 + 7 * 60_000 && p.ts < T0 + 15 * 60_000);
    expect(hole.length).toBeGreaterThan(0);
    for (const p of hole) expect(p.cpuPercent).toBeNull();
  });

  it('points=1（整窗聚成一个数）不受分辨率下限影响', () => {
    for (let t = 0; t <= 30 * 60_000; t += 45_000) recordContainerSample('c1', sample({ cpuPercent: 3 }), T0 + t);
    const now = T0 + 30 * 60_000;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 1 }, now);
    expect(r.series.c1.length).toBe(1);
  });

  it('历史只覆盖窗口末尾时，轴仍是完整窗口（冷启动不许把 3 分钟摊成 30 分钟）', () => {
    // 只有最后 180s 有数据，窗口却要 1800s。
    for (let i = 0; i < 36; i += 1) {
      recordContainerSample('c1', sample({ cpuPercent: 7 }), T0 + 1_620_000 + i * 5_000);
    }
    const now = T0 + 1_800_000;
    const r = queryContainerSeries({ containers: ['c1'], after: T0, before: now, points: 120 }, now);
    expectSpansWindow(r);
    expect(r.series.c1[0].cpuPercent, '窗口开头没有数据，必须是 null 而不是被裁掉').toBeNull();
    expect(r.series.c1.at(-1)?.cpuPercent).not.toBeNull();
    // 有数据的桶只该占窗口末尾的一小段（180/1800 = 10%）。
    const withData = r.series.c1.filter((p) => p.cpuPercent != null).length;
    expect(withData / r.series.c1.length).toBeLessThan(0.2);
  });

  /**
   * 2026-09-01 真实缺陷的回归。
   *
   * 病象：图上出现黑色缺口，色带断成一截一截。
   * 病根：以前每个容器各自跳过自己的空桶——全程在跑的拿到 60 个点，中途停掉的
   * 只拿到 30 个点。前端按数组下标堆叠，短的那条读到 undefined，累加成 NaN，
   * SVG 路径带 NaN 坐标就整段不画。而且长度不等本身就意味着下标对不上时间：
   * 停机容器的第 0 个点和别人的第 0 个点根本不是同一时刻。
   */
  it('所有容器共享同一条时间轴，长度必须一致', () => {
    for (let i = 0; i < 120; i += 1) recordContainerSample('alive', sample({ cpuPercent: 2 }), T0 + i * 10_000);
    for (let i = 0; i < 60; i += 1) recordContainerSample('died', sample({ cpuPercent: 3 }), T0 + i * 10_000);
    const now = T0 + 1_200_000;
    const r = queryContainerSeries({ containers: ['alive', 'died'], after: T0, before: now, points: 60 }, now);
    expect(r.series.alive.length).toBe(r.series.died.length);
    expect(r.timestamps.length).toBe(r.series.alive.length);
    for (let i = 0; i < r.timestamps.length; i += 1) {
      expect(r.series.alive[i].ts).toBe(r.timestamps[i]);
      expect(r.series.died[i].ts).toBe(r.timestamps[i]);
    }
  });

  it('停掉之后的桶给 null，不是 0——「没数据」与「用量为 0」不是一回事', () => {
    for (let i = 0; i < 120; i += 1) recordContainerSample('alive', sample({ cpuPercent: 2 }), T0 + i * 10_000);
    for (let i = 0; i < 60; i += 1) recordContainerSample('died', sample({ cpuPercent: 3 }), T0 + i * 10_000);
    const now = T0 + 1_200_000;
    const r = queryContainerSeries({ containers: ['alive', 'died'], after: T0, before: now, points: 60 }, now);
    expect(r.series.died.at(-1)?.cpuPercent).toBeNull();
    expect(r.series.alive.at(-1)?.cpuPercent).not.toBeNull();
  });

  it('按下标堆叠不再产生 NaN（前端就是这么画的）', () => {
    for (let i = 0; i < 120; i += 1) recordContainerSample('alive', sample({ cpuPercent: 2 }), T0 + i * 10_000);
    for (let i = 0; i < 60; i += 1) recordContainerSample('died', sample({ cpuPercent: 3 }), T0 + i * 10_000);
    const now = T0 + 1_200_000;
    const r = queryContainerSeries({ containers: ['alive', 'died'], after: T0, before: now, points: 60 }, now);
    const rows = [r.series.alive, r.series.died].map((pts) => pts.map((p) => p.cpuPercent ?? 0));
    const n = rows[0].length;
    const cum = new Array<number>(n).fill(0);
    for (const row of rows) for (let i = 0; i < n; i += 1) cum[i] += row[i];
    expect(cum.some((v) => Number.isNaN(v)), '堆叠结果里出现 NaN —— SVG 会画出黑色缺口').toBe(false);
  });

  it('group=max 取桶内峰值，average 取均值', () => {
    recordContainerSample('c1', sample({ cpuPercent: 1 }), T0);
    recordContainerSample('c1', sample({ cpuPercent: 99 }), T0 + 1_000);
    const q = { containers: ['c1'], after: T0, before: T0 + 2_000, points: 1 };
    expect(queryContainerSeries({ ...q, group: 'max' }, T0 + 2_000).series.c1[0].cpuPercent).toBe(99);
    expect(queryContainerSeries({ ...q, group: 'average' }, T0 + 2_000).series.c1[0].cpuPercent).toBe(50);
  });

  /**
   * 早先这里断言的是「返回空数组」。空数组会让这个容器的序列长度与其它容器不等，
   * 而前端是按数组下标堆叠的——长度不等正是黑色缺口那个缺陷的成因。
   * 所以从没见过的容器也必须落在同一条轴上，只是每个桶都是 null。
   */
  it('没有任何样本的容器也对齐到共享时间轴，每个桶都是 null', () => {
    recordContainerSample('has-data', sample({ cpuPercent: 3 }), T0 - 60_000);
    const r = queryContainerSeries({ containers: ['never-seen', 'has-data'], after: -600, points: 60 }, T0);
    expect(r.series['never-seen']).toBeDefined();
    expect(r.series['never-seen'].length).toBe(r.series['has-data'].length);
    expect(r.series['never-seen'].length).toBe(r.timestamps.length);
    for (const p of r.series['never-seen']) expect(p.cpuPercent).toBeNull();
  });
});

describe('有界：不许无限长', () => {
  it('超过保留时长的点被裁掉', () => {
    recordContainerSample('c1', sample(), T0);
    recordContainerSample('c1', sample(), T0 + 3 * 60 * 60_000);
    expect(containerMetricsHistoryStats().points).toBe(1);
  });

  it('单容器点数有上限（高频采样撑不爆）', () => {
    for (let i = 0; i < 2500; i += 1) recordContainerSample('c1', sample(), T0 + i * 100);
    expect(containerMetricsHistoryStats().points).toBeLessThanOrEqual(2000);
  });

});

describe('接线：两路采集者都写同一个存储（形状 2 —— 建了一半不会红）', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

  it('45s 常驻采样器把整帧喂给历史（以前它把 net/limit 直接扔了）', () => {
    const src = read('src/services/resource-usage-sampler.ts');
    expect(src).toContain("from './container-metrics-history.js'");
    expect(src).toMatch(/recordContainerSample\(/);
    expect(src).toContain('netRxBytes');
  });

  it('抽屉打开时的 5s 端点也写进同一个存储', () => {
    const src = read('src/routes/branches.ts');
    expect(src).toMatch(/recordContainerSample\(/);
  });

  it('series 端点存在，且窗口参数按 Netdata 形状命名', () => {
    const src = read('src/routes/branches.ts');
    expect(src).toContain("'/branches/:id/metrics/series'");
    expect(src).toContain('req.query.after');
    expect(src).toContain('req.query.points');
    expect(src).toContain('req.query.group');
  });

  it('前端用服务端历史铺底，不再只靠自己攒点', () => {
    const drawer = read('../cds/web/src/components/BranchDetailDrawer.tsx');
    const panel = read('../cds/web/src/components/branch/OverviewPanel.tsx');
    expect(drawer).toContain('metrics/series');
    expect(drawer).toContain('seedMetricSeries');
    expect(panel).toContain('export function seedMetricSeries');
    // 窗口长度由服务端说了算，不再用「点数 × 5s」倒推
    expect(panel).toContain('windowMinutes');
    expect(panel).not.toContain('(sampleCount * 5) / 60');
  });
});
