import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  recordContainerSample,
  queryContainerSeries,
  forgetContainer,
  containerMetricsHistoryStats,
  __resetContainerMetricsHistory,
} from '../../src/services/container-metrics-history.js';

const T0 = 1_800_000_000_000;
const sample = (over: Partial<{ cpuPercent: number; memUsedBytes: number; memLimitBytes: number; netRxBytes: number; netTxBytes: number }> = {}) => ({
  cpuPercent: 1, memUsedBytes: 100, memLimitBytes: 1000, netRxBytes: 0, netTxBytes: 0, ...over,
});

beforeEach(() => __resetContainerMetricsHistory());

describe('速率由累计值差分算出', () => {
  it('两点之间的累计差除以间隔 = bytes/sec', () => {
    recordContainerSample('c1', sample({ netRxBytes: 0 }), T0);
    recordContainerSample('c1', sample({ netRxBytes: 10_000 }), T0 + 10_000);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 20_000, points: 10 }, T0 + 20_000);
    expect(series.c1.at(-1)?.rxRate).toBeCloseTo(1000, 3);
  });

  it('首点没有前一点，速率是 0 而不是 NaN', () => {
    recordContainerSample('c1', sample({ netRxBytes: 999 }), T0);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 1000, points: 4 }, T0 + 1000);
    expect(series.c1[0].rxRate).toBe(0);
  });

  /**
   * 容器重建后 docker 的累计计数器归零。差值为负不是「负流量」，是换了个容器。
   * 不钉住这条，图上会画出一根扎到底的负峰。
   */
  it('容器重建导致累计值回绕时记 0，不出负数', () => {
    recordContainerSample('c1', sample({ netRxBytes: 5_000_000 }), T0);
    recordContainerSample('c1', sample({ netRxBytes: 1_000 }), T0 + 5_000);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 10_000, points: 10 }, T0 + 10_000);
    for (const p of series.c1) expect(p.rxRate).toBeGreaterThanOrEqual(0);
  });

  /**
   * 中间断档（CDS 重启 / docker 不可用）后，用「大差值 ÷ 大间隔」算出来的速率
   * 是假的平均值，会把一段根本没有观测的时间画成平坦流量。
   */
  it('间隔超过上限就不算速率（断档不编数）', () => {
    recordContainerSample('c1', sample({ netRxBytes: 0 }), T0);
    recordContainerSample('c1', sample({ netRxBytes: 100_000_000 }), T0 + 30 * 60_000);
    const { series } = queryContainerSeries({ containers: ['c1'], after: T0 - 1000, before: T0 + 31 * 60_000, points: 50 }, T0 + 31 * 60_000);
    expect(series.c1.at(-1)?.rxRate).toBe(0);
  });

  it('同一毫秒或更旧的点被忽略（两路采集者可能同时落点）', () => {
    recordContainerSample('c1', sample({ cpuPercent: 1 }), T0);
    recordContainerSample('c1', sample({ cpuPercent: 99 }), T0);
    recordContainerSample('c1', sample({ cpuPercent: 98 }), T0 - 5_000);
    expect(containerMetricsHistoryStats().points).toBe(1);
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
    expect(r.after).toBe(now - 60_000);
    expect(r.before).toBe(now);
    for (const p of r.series.c1) expect(p.ts).toBeGreaterThanOrEqual(r.after);
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
    expect(r.series.c1.length).toBe(2);
    for (const p of r.series.c1) expect(p.cpuPercent).toBe(5);
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

  it('没有任何样本的容器返回空数组，不是 undefined', () => {
    const r = queryContainerSeries({ containers: ['never-seen'], after: -600 }, T0);
    expect(r.series['never-seen']).toEqual([]);
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

  it('容器删除后可以主动清掉', () => {
    recordContainerSample('c1', sample(), T0);
    forgetContainer('c1');
    expect(containerMetricsHistoryStats().containers).toBe(0);
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
