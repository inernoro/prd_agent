import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { areaPath, stackAreas, seedMetricSeries, OverviewPanel } from '@/components/branch/OverviewPanel';
import { sameOperationKind, describeMetricsFailure } from '@/components/BranchDetailDrawer';
import { ApiError } from '@/lib/api';

/**
 * 总览面板（2026-09-01 视觉化重排）的三条守卫。
 *
 * 三条都属于「改坏了照样编译、照样渲染、通读也挑不出」的那一类，只有真人盯着
 * 看五秒才发现，所以必须机械钉住（predicate-and-wiring-discipline）。
 */

const SRC = path.resolve(process.cwd(), '../cds/web/src');
const PANEL = fs.readFileSync(path.join(SRC, 'components/branch/OverviewPanel.tsx'), 'utf8');
const DRAWER = fs.readFileSync(path.join(SRC, 'components/BranchDetailDrawer.tsx'), 'utf8');
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');

/**
 * 去掉注释的源码视图。
 *
 * 扫源码的守卫必须扫**真正会执行的那部分**：注释里为了讲清病根，往往会原样引用
 * 那个错误写法（本文件里就有一条守卫因此自己把自己判红）。这正是
 * predicate-and-wiring-discipline 形状 6——判据读到的不是真正生效的那个值。
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const PANEL_CODE = stripComments(PANEL);

describe('总览面板接线（形状 2：建了一半不会红）', () => {
  it('抽屉真的在渲染 OverviewPanel，不是只 import 不用', () => {
    expect(DRAWER).toContain("from '@/components/branch/OverviewPanel'");
    expect(DRAWER).toMatch(/<OverviewPanel\s/);
  });

  it('旧的八方块与「每服务一张大卡」已经删掉，不是新旧并存', () => {
    expect(DRAWER).not.toContain('OverviewTile');
    // 旧监控面板整块搬走后，抽屉里不该再留 ServiceMetricCard / Sparkline 这套
    expect(DRAWER).not.toMatch(/function\s+ServiceMetricCard\s*\(/);
    expect(DRAWER).not.toMatch(/function\s+Sparkline\s*\(/);
  });

  it('入口卡只有一处（原先抽屉头部与总览计数各说各话）', () => {
    expect(DRAWER).not.toContain('应用已上线');
    expect(PANEL).toContain('function EntryCards');
  });
});

describe('打开即出图（2026-09-02 真人验收：打开之后卡了很长时间）', () => {
  /**
   * 病根：图表闸门曾写成 `!metricsReady || !hasPlot`。metricsReady 要等
   * `/api/branches/:id/metrics` 返回，而那个接口跑 `docker stats --no-stream`，
   * 十个容器、超时上限 5 秒；与此同时纯内存的 `/metrics/series` 早就把整段历史
   * 返回来了，图完全画得出来，却被按住不画。
   *
   * 这条守卫钉住「闸门只看有没有历史」。改回去会立刻变红。
   */
  it('图表闸门不依赖实时快照，只看有没有画得出来的历史', () => {
    /*
     * 缺陷的确切形态是把 metricsReady 或进闸门（`!metricsReady || !hasPlot`）。
     * 早先这条按「metricsError 文案之后的第一个三元」定位闸门，文案一改就找不着了
     * ——判据不该挂在文案上。改成直接钉住那个形态本身。
     */
    expect(PANEL_CODE, '实时快照（docker stats，可能要 5 秒）不该挡住已经拿到的历史').not.toMatch(/!metricsReady\s*\|\|/);
    expect(PANEL_CODE).not.toMatch(/\|\|\s*!metricsReady/);
    expect(PANEL_CODE, '图表分支应当由 hasPlot 决定').toMatch(/!hasPlot\s*\?/);
  });

  it('抽屉一进总览就取服务端历史铺底，不是打开后自己攒点', () => {
    expect(stripComments(DRAWER)).toMatch(/metrics\/series\?after=/);
  });
});

describe('图的时间轴只有一个口径（2026-09-02：X 轴在说谎）', () => {
  /**
   * 病象：抽屉开得越久，X 轴越离谱——而那恰好就是真人验收时的姿势。
   * 病根：铺底用服务端的桶（自适应后每桶数十秒），前端又每 5 秒往数组尾巴 append
   * 一个点；图按下标等距画，于是开 5 分钟后右边 60 个点占 69% 宽度只代表 5 分钟，
   * 左边 27 个点占 31% 却代表 30 分钟，横跨全宽差七倍。
   * 与最初那片锯齿是同一类病（图的几何与数据的时间对不上），只是藏在实时更新那条路上。
   */
  it('前端不再把实时点追加进图的数组', () => {
    expect(stripComments(DRAWER), 'pushMetricRing 会把 5 秒粒度混进数十秒的桶里').not.toContain('pushMetricRing');
    expect(PANEL_CODE, '这个函数已无人调用，留着就是形状 2 的死接线').not.toContain('export function pushMetricRing');
  });

  it('series 端点是被轮询的，不是只在打开时取一次', () => {
    const code = stripComments(DRAWER);
    const idx = code.indexOf('metrics/series?after=');
    expect(idx, '找不到 series 请求，选择器过时了').toBeGreaterThan(0);
    // 该请求所在的 loadSeries 必须被挂进一个 setInterval
    expect(code).toMatch(/loadSeries[\s\S]{0,400}setInterval\(\(\)\s*=>\s*void\s+loadSeries/);
  });

  /*
   * 这条守卫的第一版扫的是源码里有没有 `liveStats` / `readLive(live)` 这两个名字
   * （Codex P1，核对属实）：把 `readLive` 改个名它就红——虽然行为一个字没变；
   * 反过来，保留这两个名字却把实时值算错（比如 `readLive(live) * 0`），它照样绿。
   * 判据钉在实现的字面上，正好把两种错都判反了（形状 4a）。
   *
   * 改成从渲染结果进：喂一组「最后一个真样本 ≠ 实时快照」的数据，看图例上到底
   * 印的是哪个数字。这样重命名不影响它，算错值一定红。
   */
  it('图例的当前值走实时快照，不是序列最后一个桶（桶是数十秒的平均，慢一拍）', () => {
    const legend = (live?: Record<string, { cpuPercent: number; memUsedBytes: number }>): string => {
      const html = renderToStaticMarkup(createElement(OverviewPanel, {
        services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
        running: true,
        branchName: 'demo',
        entries: [],
        deployments: [],
        // 两帧真样本够画图（filled >= 2），最后一个真样本是 4%。
        metricSeries: {
          api: seedMetricSeries([
            { cpuPercent: 4, memUsedBytes: 100, rxRate: 0, txRate: 0 },
            { cpuPercent: 4, memUsedBytes: 100, rxRate: 0, txRate: 0 },
          ]),
        },
        liveStats: live,
        metricsReady: true,
        replicaSummary: '1 个副本',
        infraSummary: '无',
        now: Date.now(),
        windowMinutes: 30,
        onRefreshMetrics: () => {},
      }));
      const cpuAt = html.indexOf('CPU 占用');
      const memAt = html.indexOf('内存占用');
      expect(cpuAt, 'CPU 卡没渲染出来，切片会是空的（空切片必然绿）').toBeGreaterThan(-1);
      expect(memAt).toBeGreaterThan(cpuAt);
      return html.slice(cpuAt, memAt);
    };

    // 有实时快照：印 42.00（快照），不是 4.00（最后一个桶）。
    const withLive = legend({ api: { cpuPercent: 42, memUsedBytes: 100 } });
    expect(withLive, '图例印的是桶的平均值，慢一拍').toContain('42.00');
    expect(withLive, '实时快照在手上却仍印着旧桶').not.toContain('4.00');

    // 没有实时快照：退回最后一个**真有样本**的桶，印 4.00。
    const noLive = legend(undefined);
    expect(noLive, '没有快照时应当退回最后一个真样本').toContain('4.00');
  });
});

describe('等待与变化（2026-09-02 真人验收：第一屏空白 / 不丝滑）', () => {
  /** CLAUDE.md §6：静止反馈超过 2 秒即缺陷。artifact-is-experience 要的是产物形状的骨架。 */
  it('出图前是图的骨架，不是虚线空盒', () => {
    // 断言它**被渲染**，不只是「源码里出现过这几个字」——
    // 第一版写的是 toContain('function MetricsSkeleton')，把它改名成
    // MetricsSkeletonX 照样包含这个子串，守卫不会红（判据太松）。
    expect(PANEL_CODE).toMatch(/<MetricsSkeleton\s/);
    expect(PANEL_CODE).toMatch(/function MetricsSkeleton\(/);
    expect(PANEL_CODE, '旧的虚线空框已经不该存在').not.toContain('正在读取指标历史…');
    // 骨架必须给出「还要等多久」，不能只写「加载中」
    expect(PANEL_CODE).toMatch(/约还需/);
    /*
     * 而且那个秒数必须按**服务端实际用的桶宽**算，不许写死采样器的标称节奏
     * （Codex P2）：抽屉开着时 5s 端点也在写，桶宽会自己收窄到十几秒，拿 45s
     * 去算就把 30 秒说成 90 秒。守卫钉住「常量已经不存在」+「用的是传进来的桶宽」。
     */
    expect(PANEL_CODE, '写死的采样器节奏常量应该已经删掉').not.toContain('SAMPLER_CADENCE_SECONDS');
    expect(PANEL_CODE).toMatch(/need \* bucketSeconds/);
  });

  it('桶宽真的从 series 响应接到了骨架屏（不是只在面板里留个参数）', () => {
    const code = stripComments(DRAWER);
    expect(code, 'loadSeries 没有读响应里的 groupSeconds').toMatch(/groupSeconds\?:\s*number/);
    expect(code, '读到了却没存').toMatch(/setSeriesMeta\(/);
    // 切到这个元素的收尾，而不是拍一个字符数：属性一多就切不到最后几个，
    // 守卫会在「代码明明是对的」时候变红，然后被人放宽成永远绿的样子。
    const at = code.indexOf('<OverviewPanel');
    const call = code.slice(at, code.indexOf('/>', at));
    expect(call, '存了却没传给面板——典型的建了一半').toMatch(/bucketSeconds=\{seriesMeta\?\.groupSeconds\}/);
    /*
     * 轴长同样要用服务端**实际返回**的窗口：网格吸附会把 30 分钟撑成 31.5 分钟，
     * 写死请求值会让峰值对不上刻度（Codex P2，核对属实）。
     */
    expect(call, 'x 轴写死了请求值，没用服务端实际返回的窗口').toMatch(
      /windowMinutes=\{seriesMeta[\s\S]{0,200}seriesMeta\.before - seriesMeta\.after/,
    );
  });

  it('骨架说的帧数来自真样本数，不是把 null 当成有数据', () => {
    expect(PANEL_CODE).toContain('filledSamples');
    expect(PANEL_CODE).toMatch(/filled:\s*tail\.filter/);
  });

  /**
   * 渲染取证抓到的：冷启动只有 1 个真样本、轴上却有 2 个桶（另一个 null），
   * 按数组长度判「够画图了」，于是画出一个从左上斜到零的大三角——那条下降沿
   * 是 null 被映射成 0 画出来的，纯属虚构。判据必须落在真数据上。
   */
  /**
   * Codex P2（核对属实）：filledSamples 是全局最大值。老服务攒了 27 帧、新起的只有
   * 1 帧时，hasPlot 全局判真，新服务照样进图——它那唯一一个真值加一堆 null→0，
   * 画出来就是一个虚构的三角尖峰。与「整屏一个大三角」同病，只是降到单条序列粒度。
   */
  it('每条序列按自己的真样本数入选，不看数组长度', () => {
    const picked = PANEL_CODE.slice(PANEL_CODE.indexOf('const picked = useMemo'), PANEL_CODE.indexOf('const sampleCount'));
    expect(picked.length, '找不到序列选取，选择器过时了').toBeGreaterThan(0);
    expect(picked, '数组长度是对齐后的桶数，所有容器都一样长，判不出谁有数据').not.toContain('cpu.length >= 2');
    expect(picked).toMatch(/filled\b/);
  });

  it('「够不够画图」看真有数据的桶数，不看数组长度', () => {
    const gate = PANEL_CODE.match(/const hasPlot = [^;]+;/)?.[0];
    expect(gate, '找不到 hasPlot，选择器过时了').toBeTruthy();
    expect(gate, 'sampleCount 是数组长度，null 桶也算在内').not.toContain('sampleCount');
    expect(gate).toContain('filledSamples');
  });

  /** miduo-review-lens 镜头 4：变化要看得见，一帧切过去等于没看见。 */
  it('数据更新走补间，且尊重 prefers-reduced-motion', () => {
    expect(PANEL_CODE).toContain('function useTweenedSeries');
    expect(PANEL_CODE).toContain('prefers-reduced-motion');
    // 形状变了（服务上下线 / 分辨率重算）必须直接切，不能在两组不同含义的数之间连线
    expect(PANEL_CODE).toContain('sameShape');
  });
});

describe('两个数据源就有两个错误面（Codex P2，核对属实）', () => {
  /**
   * 把图（服务端分桶）和数字（实时快照）劈成两个源之后，聚合与错误处理都得跟上。
   * 这三条盯的正是「没跟上」的三种形态。
   */
  it('合计与构成条宽度走 nowValue，不再取桶末值', () => {
    const totals = PANEL_CODE.match(/const (cpu|mem)TotalNow = [^;]+;/g) ?? [];
    expect(totals.length, '找不到合计的计算，选择器过时了').toBe(2);
    for (const t of totals) {
      expect(t, '桶末值是数十秒的平均，比旁边每服务的实时数字慢一拍').not.toContain('values.at(-1)');
      expect(t).toContain('nowValue');
    }
    const bar = PANEL_CODE.slice(PANEL_CODE.indexOf('function CompositionBar'), PANEL_CODE.indexOf('function SeriesLegend'));
    expect(bar, '条按旧桶画、数字按实时写 = 同屏自相矛盾').not.toContain('values.at(-1)');
  });

  /*
   * 这条原本要求 `catch` 之后 300 字符内出现 `setSeriesError`——一个按**字符距离**
   * 写的判据。catch 里多加两行守卫（会话号、水位）就把它挤出窗口，行为一个字没变
   * 却误红。改成钉「catch 块里到底做没做那件事」：按花括号配对切出块，再看内容。
   */
  it('历史端点失败不再被静默吞掉', () => {
    const code = stripComments(DRAWER);
    const at = code.indexOf('const loadSeries');
    expect(at, '找不到 loadSeries，选择器过时了').toBeGreaterThan(0);
    const catchAt = code.indexOf('catch', at);
    expect(catchAt, 'loadSeries 里没有 catch —— 失败会变成未捕获拒绝').toBeGreaterThan(at);
    // 从 catch 的 `{` 起按配对切出整个块，不依赖长度
    let i = code.indexOf('{', catchAt);
    let depth = 0;
    let end = i;
    for (; end < code.length; end += 1) {
      if (code[end] === '{') depth += 1;
      else if (code[end] === '}') { depth -= 1; if (depth === 0) break; }
    }
    const block = code.slice(i, end + 1);
    expect(block, 'catch 全吞会让骨架屏永远承诺一条不会出现的曲线').toContain('setSeriesError');
    expect(PANEL_CODE).toContain('seriesError');
  });

  /**
   * Codex P2（核对属实）：漏掉了「先成功、后持续失败」那条路——`metricSeries` 还留着
   * 上一次的结果，`hasPlot` 仍为真，于是两个错误分支都被 `!hasPlot` 挡掉，一条过期
   * 曲线顶着「近 30 分钟」的标签无限期挂着，一句提示都没有。
   */
  /*
   * 这条原本扫的是源码：`{seriesError` 之后 200 字符里不许出现 `seriesError && !hasPlot ?`，
   * 外加 `toContain('已经不再更新')` 逐字钉那句文案（Codex P1，核对属实）。两头都不对——
   * 把提示挪进一个 helper、或者只是改改措辞，行为没变它却红；反过来，把这两个字符串
   * 留在一段永远走不到的代码里，它照样绿。本文件里这已经是第四条同病的守卫。
   *
   * 改成渲染两种状态直接看输出：有旧图时必须说曲线是旧的、且图还在；没图时必须说
   * 画不出来了、且没有面积路径。
   */
  it('历史失败的提示不被 hasPlot 挡住：有旧图时也要说这条曲线是旧的', () => {
    const render = (plottable: boolean): string => renderToStaticMarkup(createElement(OverviewPanel, {
      services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
      running: true,
      branchName: 'demo',
      entries: [],
      deployments: [],
      // 两帧 => hasPlot 为真（先成功后失败那条路）；零帧 => 压根没图
      metricSeries: plottable
        ? {
          api: seedMetricSeries([
            { cpuPercent: 4, memUsedBytes: 100, rxRate: 0, txRate: 0 },
            { cpuPercent: 4, memUsedBytes: 100, rxRate: 0, txRate: 0 },
          ]),
        }
        : {},
      seriesError: '指标历史服务暂时不可用，稍后会自动重试。',
      metricsReady: true,
      replicaSummary: '1 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));

    // 先成功、后持续失败：提示必须出现，且旧图仍在——这正是被 !hasPlot 挡掉的那一档
    const stale = render(true);
    expect(stale, '有旧图时提示被 hasPlot 门住了，用户看着一条过期曲线毫不知情')
      .toContain('指标历史服务暂时不可用');
    expect(stale, '必须说清这条曲线不是当前的').toMatch(/不再更新|不是当前/);
    const staleAreas = [...stale.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]).filter((d) => d.includes('Z'));
    expect(staleAreas.length, '旧图应当还画着——它是仅有的历史，不该连同提示一起消失').toBeGreaterThan(0);

    // 压根没图：提示同样要出现，并说明这一项不会自己好
    const empty = render(false);
    expect(empty).toContain('指标历史服务暂时不可用');
    expect(empty, '没图时要说画不出来了，别让骨架屏继续承诺曲线').toMatch(/画不出来/);
  });

  it('实时采样失败不藏历史图：两个错误面互不牵连', () => {
    // metricsError 那一支必须是「提示条」而不是「取代整段」——判据是它之后仍会走到 hasPlot 分支
    const section = PANEL_CODE.slice(PANEL_CODE.indexOf('{metricsError ?'));
    const head = section.slice(0, 900);
    expect(head, 'docker stats 挂了不该把还好好的历史图一起藏掉').not.toMatch(/metricsError \?[\s\S]{0,400}\) : !hasPlot \?/);
    expect(head).toContain('实时采样失败');
  });
});

describe('成员集合与状态同源且新鲜（Codex P2 ×2，均核对属实）', () => {
  /**
   * 同一个洞栽过两次，两次都只补了一半：
   *   1. 先是拿抽屉打开时的快照判 status——刚启动完的服务有实时读数却被标「停止」
   *      并被排除出合计，被外部停掉的服务还挂着停机前的旧值；
   *   2. 修完 status 之后，**成员集合**仍留在陈快照里——部署期间新增的 profile 在
   *      总览上根本不存在，删掉的 profile 赖着不走。
   *
   * 所以守卫钉的不是「status 新鲜」，而是「成员集合和状态出自同一处新鲜来源」。
   */
  it('面板的服务清单整份来自 overviewServices，不是在调用处现拼', () => {
    const code = stripComments(DRAWER);
    const call = code.slice(code.indexOf('<OverviewPanel'), code.indexOf('<OverviewPanel') + 400);
    expect(call, '服务清单必须整份传入，不能在调用处从 branch.services 现拼').toMatch(
      /services=\{overviewServices\}/,
    );
    expect(call).not.toContain('Object.values(branch.services');
  });

  it('metrics 就绪时，成员集合与状态都取自 /metrics 的这一帧', () => {
    const code = stripComments(DRAWER);
    const at = code.indexOf('const overviewServices');
    expect(at, '找不到 overviewServices').toBeGreaterThan(-1);
    const memo = code.slice(at, at + 900);
    const ok = memo.slice(0, memo.indexOf('return Object.values('));
    /*
     * 断言的是「成员集合整份来自 /metrics 的响应」，不是某一句的字面写法。
     * 这条第一版逐字要求 `metricsState.data.services`，后来加「失败时退回最后一次
     * 成功的那一帧」时那句被拆成了 `fresh = ... ? metricsState.data : lastGoodMetrics`
     * 再 `fresh.services`——代码更对了，守卫却红了（形状 4a：锁死了实现的写法）。
     */
    expect(ok, '成员集合必须来自 /metrics 的响应，而不只是拿它补 status').toMatch(
      /metricsState\.data/,
    );
    expect(ok).toMatch(/\.services\.map/);
    expect(ok).toMatch(/profileId:\s*svc\.profileId/);
    expect(ok).toMatch(/containerName:\s*svc\.containerName/);
    expect(ok).toMatch(/status:\s*svc\.status/);
  });

  it('metrics 未就绪时退回 branch.services 兜底，首帧不空白', () => {
    const code = stripComments(DRAWER);
    const at = code.indexOf('const overviewServices');
    const memo = code.slice(at, at + 900);
    expect(memo, '没有兜底会让抽屉刚打开那一两秒整块总览是空的').toMatch(
      /return Object\.values\(branch\??\.services/,
    );
  });
});

describe('计数必须数实体，不数渲染出来的行（Codex P2，核对属实）', () => {
  /**
   * `${cpuSeries.length} 个服务合计` 数的是渲染行数：超过 5 个服务时尾部全折进
   * 一条「其他 N 个」，那个数组长度**恒等于 6**，不管实际是 6 个还是 20 个。
   *
   * 这是本模块反复出现的同一个形状——数格子，不数数据。这条守卫连同
   * 「hasPlot 看 filled」「序列入选看 filled」一起，把它钉在三个粒度上。
   */
  it('大数旁边的服务数来自实体，不是系列数组长度', () => {
    const suffixes = PANEL_CODE.match(/headlineSuffix=\{`[^`]*`\}/g) ?? [];
    expect(suffixes.length, '找不到 headlineSuffix，选择器过时了').toBeGreaterThan(0);
    for (const x of suffixes) {
      expect(x, 'Series 数组长度在折叠「其他」之后恒为 6，不是服务数').not.toMatch(/(cpu|mem)Series\.length/);
    }
    expect(PANEL_CODE).toContain('totalledServiceCount');
  });

  it('这个数与合计口径一致：只数还在跑的（合计也只加还在跑的）', () => {
    const decl = PANEL_CODE.slice(PANEL_CODE.indexOf('const totalledServiceCount'), PANEL_CODE.indexOf('const cpuTotalNow'));
    expect(decl.length).toBeGreaterThan(0);
    expect(decl, "「12 个服务合计」里那个 12 不能包含没计入的").toMatch(/status === 'running'/);
    // 三个来源都要数到，漏一个就会低报
    expect(decl).toContain('picked.head');
    expect(decl).toContain('picked.tail');
    expect(decl).toContain('picked.liveOnly');
  });
});

describe('尾部聚合与陈旧序列（Codex P2，核对属实）', () => {
  /**
   * 「其他 N 个」是多个服务的合并项，带不了 stopped 标记，后面那道
   * `s.stopped ? 0 : s.nowValue` 的过滤够不着它——于是已停容器停机前的旧读数
   * 会一直算进「其他」和顶部合计，谎称它还在吃资源。
   */
  it('尾部聚合的当前值只算还在跑的服务', () => {
    const tail = PANEL_CODE.slice(PANEL_CODE.indexOf('const tailNow'), PANEL_CODE.indexOf('const [nowLabel, nowUnit] = label(tailNow)'));
    expect(tail.length, '找不到尾部聚合，选择器过时了').toBeGreaterThan(0);
    expect(tail, '尾部当前值必须跳过已停容器').toMatch(/status !== 'running'/);
  });

  /**
   * Codex P2（核对属实），而且是上一个修复直接造出来的：把序列入选收紧到
   * `filled >= 2` 之后，刚起来的服务进不了 cpuSeries，而合计正是在 cpuSeries 上
   * 求和的——头部大数少报，要等 90 秒第二帧到了才对。
   *
   * 根因还是把两个问题混成一个：**能不能画是几何安全问题，当前是多少是事实问题。**
   * 这些服务归进「其他」：当前值照算（实时快照就在手上），几何不参与
   * （确实还没有它们的历史，凭空补一段才是撒谎）。
   */
  it('还在跑但历史不够画的服务，当前值仍计入合计', () => {
    const picked = PANEL_CODE.slice(PANEL_CODE.indexOf('const picked = useMemo'), PANEL_CODE.indexOf('const sampleCount'));
    expect(picked, '找不到 liveOnly，选择器过时了').toContain('liveOnly');
    expect(picked).toMatch(/status === 'running' && !plottable\.has/);

    const tail = PANEL_CODE.slice(PANEL_CODE.indexOf('const tailNow'), PANEL_CODE.indexOf('const otherCount'));
    expect(tail, '当前值必须把它们加进来').toContain('picked.liveOnly.reduce');
  });

  it('这些服务不贡献几何：merged 只累加有历史的那些', () => {
    const merged = PANEL_CODE.slice(PANEL_CODE.indexOf('const merged ='), PANEL_CODE.indexOf('const tailNow'));
    expect(merged, '没有历史却补一段几何就是撒谎').not.toContain('liveOnly');
  });

  it('历史那一条仍包含全部尾部服务（画的是过去，过去它确实在跑）', () => {
    const merged = PANEL_CODE.slice(PANEL_CODE.indexOf('const merged ='), PANEL_CODE.indexOf('const tailNow'));
    expect(merged.length).toBeGreaterThan(0);
    expect(merged, '历史几何不该按当前状态裁剪').not.toMatch(/status !== 'running'/);
  });

  /**
   * 「非空才替换」是「铺底不覆盖已追加点」那套逻辑的遗留。留着它，
   * loadSeries 成功返回空（服务全删 / 历史过期）时会跳过 setState，
   * 上一次的曲线就一直挂在屏幕上冒充当前数据。
   */
  it('series 拉取成功后无条件整体替换，不保留上一次的曲线', () => {
    const code = stripComments(DRAWER);
    const load = code.slice(code.indexOf('const loadSeries'), code.indexOf('const loadSeries') + 1800);
    expect(load).toContain('setMetricSeries(next)');
    expect(load, '「非空才替换」会让旧曲线冒充当前数据').not.toMatch(/Object\.keys\(next\)\.length\s*>\s*0\s*\)\s*setMetricSeries/);
  });
});

describe('图形与配色（2026-09-02 真人验收：太丑、非常乱）', () => {
  /**
   * 内存几乎不随时间变，画成 30 分钟面积图就是几条水平直线，白占半屏，
   * 而全部信息（谁占多少）图例里的数字早就说完了。
   * dataviz 形式表：这份数据的 job 是 part-to-whole → stacked bar，
   * 且「go horizontal for many / long-named categories」。
   */
  it('内存用构成条（part-to-whole），不是时间序列面积图', () => {
    expect(PANEL_CODE).toContain('function CompositionBar');
    const memCard = PANEL_CODE.slice(PANEL_CODE.indexOf('title="内存占用"'), PANEL_CODE.indexOf('<NetworkChart'));
    expect(memCard, '内存卡不该再画时间序列').not.toContain('StackedAreaChart');
    expect(memCard).toContain('CompositionBar');
  });

  /**
   * 本面板自己声明的不变量：语义四色 ok / warn / bad / info 是状态专用，不参与系列配色
   * （dataviz 同款硬规则：Status colors are reserved）。
   * 网络图此前用了 --info 与 --primary，正好违反它——这条守卫钉住不许再犯。
   */
  it('图形取色不使用语义四色与品牌色', () => {
    /*
     * 扫的是「图形从哪里取色」这几处，不是全文件：
     * 判断行、健康环、失败柱用状态色是**对的**（那正是状态）。
     * 第一版守卫按引号字面量找 `fill: '...'`，而填充早就是常量引用了，
     * 一个都没匹配到——靠下面这句「找不到就红」才没变成空跑的绿灯（形状 4b）。
     */
    const pick = (from: string, to: string): string =>
      PANEL_CODE.slice(PANEL_CODE.indexOf(from), PANEL_CODE.indexOf(to));
    const regions = [
      PANEL_CODE.slice(PANEL_CODE.indexOf('const seriesColor'), PANEL_CODE.indexOf('const STACK_GAP')),
      pick('const NET_COLOR', 'function NetworkChart'),
      pick('function StackedAreaChart', 'function CompositionBar'),
      pick('function CompositionBar', 'function SeriesLegend'),
    ];
    expect(regions.every((r) => r.length > 0), '取色区域一个都没定位到，选择器过时了').toBe(true);
    for (const region of regions) {
      const tokens = region.match(/--[a-z-]+/g) ?? [];
      for (const t of tokens) {
        expect(t, `${t} 是保留色：状态色与品牌色不参与系列配色`).not.toMatch(/^--(info|primary|ok|warn|bad)$/);
      }
    }
  });

  it('网络专用色在两个主题都有定义（缺一个主题会静默失效）', () => {
    const dark = CSS.slice(CSS.indexOf("[data-theme='dark']"), CSS.indexOf("[data-theme='light']"));
    const light = CSS.slice(CSS.indexOf("[data-theme='light']"));
    expect(dark).toContain('--series-net:');
    expect(light).toContain('--series-net:');
  });

  /** 堆叠段之间靠表面色的缝分开，不靠给每段描边（dataviz: the gap is the mechanism）。 */
  it('堆叠段之间留缝，不描边', () => {
    expect(PANEL_CODE).toContain('STACK_GAP');
    const chart = PANEL_CODE.slice(PANEL_CODE.indexOf('function StackedAreaChart'), PANEL_CODE.indexOf('function CompositionBar'));
    expect(chart, '分隔应该靠缝，不该给面积描边').not.toMatch(/stroke=/);
  });

  /** 刻度取整：小数位由步长定一次，逐值判断会打出 15 / 10 / 5.0 / 0.0 这种混排。 */
  it('Y 轴刻度落在整数步长上', () => {
    expect(PANEL_CODE).toContain('niceScale');
    expect(PANEL_CODE, '旧的「上限 × 0.66 / 0.33」会打出不整的刻度').not.toMatch(/\[1,\s*0\.66,\s*0\.33,\s*0\]/);
  });
});

describe('系列色跟实体走，不跟名次走', () => {
  /**
   * 真实缺陷的回归：第一版按当前 CPU 排名选取并赋色，指标每 5s 刷一次，
   * 两个服务用量一接近，颜色 / 图例列序 / 堆叠层序就跟着名次来回换——
   * 同一个服务这一秒橙色下一秒蓝色，图一直在抖，也没法拿颜色认服务。
   */
  it('排序判据是服务名字典序，不是用量', () => {
    expect(PANEL).toContain('a.svc.profileId.localeCompare(b.svc.profileId)');
    const pickedBlock = PANEL.slice(PANEL.indexOf('const picked = useMemo'), PANEL.indexOf('const sampleCount'));
    expect(pickedBlock).not.toMatch(/sort\([^)]*ring\.cpu/);
    expect(pickedBlock).not.toMatch(/sort\([^)]*ring\.mem/);
  });

  it('色位固定五档、不循环；第 6 个及以后并入「其他」', () => {
    expect(PANEL).toContain('const SERIES_SLOTS = 5');
    expect(PANEL).toContain('其他');
    // 取模循环会让第 6 个服务和第 1 个撞成同一个色
    expect(PANEL).not.toMatch(/SERIES_SLOTS\s*\]/);
    expect(PANEL).not.toMatch(/%\s*SERIES_VARS\.length/);
  });

  it('语义四色不参与系列配色（否则「第 4 个服务」会跟「警告」撞色）', () => {
    const seriesDef = PANEL.slice(PANEL.indexOf('const seriesColor'), PANEL.indexOf('const seriesColor') + 200);
    for (const status of ['--ok', '--warn', '--bad', '--info']) {
      expect(seriesDef).not.toContain(status);
    }
  });
});

describe('系列色 token 两个主题都定义', () => {
  it('--series-1..5 各出现两次（dark 一次、light 一次）', () => {
    for (let i = 1; i <= 5; i += 1) {
      const count = (CSS.match(new RegExp(`--series-${i}:`, 'g')) || []).length;
      expect(count, `--series-${i} 应在 dark 与 light 各定义一次，实际 ${count} 次`).toBe(2);
    }
  });

  it('图表用的是 token，不是写死的十六进制', () => {
    expect(PANEL).toContain('hsl(var(--series-');
    // 面积 / 图例色条不许出现裸 hex
    expect(PANEL.match(/#[0-9a-fA-F]{6}\b/g) ?? []).toEqual([]);
  });
});

describe('停掉的容器不许显示停机前的旧读数', () => {
  /**
   * 演示时逮到的真缺陷：portal 已经 error、容器不在跑了，序列尾巴停在它停机那一刻，
   * 而图例取 values.at(-1)，于是「当前值」位上摆着停机前的 2.34% —— 看起来它还活着。
   * 合计同理，会把这份旧读数算进去虚报占用。
   */
  /*
   * 这条原本钉着 `stopped: x.svc.status !== 'running'` 这段字面量。分支级判据接进来
   * 之后（停掉的分支整体不报当前值），那一行合理地变成
   * `!anyRunning || x.svc.status !== 'running'`，于是它误红——锁的是实现不是行为
   * （形状 4a，本文件里这已经是第三条同病的守卫）。改成从渲染结果断言。
   */
  it('图例按 status 判停，不是拿末值当现值', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [
        { profileId: 'api', containerName: 'api-x', status: 'running' },
        { profileId: 'web', containerName: 'web-x', status: 'stopped' },
      ],
      running: true,
      branchName: 'demo',
      entries: [],
      deployments: [],
      metricSeries: {
        api: seedMetricSeries([
          { cpuPercent: 5, memUsedBytes: 100, rxRate: 0, txRate: 0 },
          { cpuPercent: 5, memUsedBytes: 100, rxRate: 0, txRate: 0 },
        ]),
        // web 停机前跑到 2.34%，序列尾巴就停在那里
        web: seedMetricSeries([
          { cpuPercent: 2.34, memUsedBytes: 100, rxRate: 0, txRate: 0 },
          { cpuPercent: 2.34, memUsedBytes: 100, rxRate: 0, txRate: 0 },
        ]),
      },
      metricsReady: true,
      replicaSummary: '2 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));
    expect(html, '已停容器的图例摆着停机前的读数，看起来它还活着').not.toContain('2.34');
    expect(html, '已停容器的图例该写「停止」').toContain('停止');
    expect(html, '在跑的那个仍要照常显示').toContain('5.00');
  });

  it('当前合计跳过已停容器', () => {
    /*
     * 断言的是「合计里跳过停机的」这件事，不是它当时那一行字面量。
     * 第一版写的是 toContain('s.stopped ? 0 : s.values.at(-1)')——后来「当前值」
     * 合理地从桶末值改成实时快照（nowValue），这条就误红了：它锁的是实现不是行为
     * （形状 4a）。现在只要求两个合计都带 stopped 分支。
     */
    const totals = PANEL_CODE.match(/const (cpu|mem)TotalNow = [^;]+;/g) ?? [];
    expect(totals.length, '找不到合计的计算，选择器过时了').toBe(2);
    for (const t of totals) expect(t, '停机容器的旧读数不能算进当前合计').toMatch(/stopped\s*\?\s*0\s*:/);
  });
});

describe('图表对齐与入口排布（都是演示时用户一眼看出来的）', () => {
  it('堆叠取各序列最短长度并逐点兜底，长度不齐也吐不出 NaN 路径', () => {
    expect(PANEL).toContain('Math.min(...values.map((row) => row.length))');
    expect(PANEL).toContain('cum[i] += row[i] ?? 0;');
    // 回到「以第一条的长度为准」就是原缺陷
    expect(PANEL).not.toContain('const n = values[0]?.length');
  });

  it('服务端的缺口（null）在前端落成 0，不是 undefined', () => {
    expect(PANEL).toContain('cpuPercent: number | null');
    expect(PANEL).toContain('x == null ? 0 : x');
  });

  /**
   * 两处都是演示时用户一眼看出来的。
   *
   * 第一版：固定两列 + 主入口用 grid-column: 1 / -1 跨满。
   * 结果 3 个次要入口剩一张半宽的孤儿卡；换成 auto-fit 后仍然不对——
   * 主入口跨满所有轨道，等于每条轨道都有项目，auto-fit 便不折叠空轨道，
   * 右边空出一整列。真正的修法是把主入口移出网格。
   */
  it('次要入口按可用宽度自适应分列', () => {
    expect(PANEL).toMatch(/repeat\(auto-fit, minmax\(min\(100%, \d+px\), 1fr\)\)/);
    expect(PANEL).not.toContain('md:grid-cols-2');
  });

  it('主入口不在那个网格里（跨满轨道会让 auto-fit 失效）', () => {
    // 主入口与次要入口各自渲染，共用同一个 EntryCard
    expect(PANEL).toContain('const rest = entries.filter((e) => e !== primary)');
    expect(PANEL).toContain('{primary ? <EntryCard e={primary}');
    // 跨满整行的写法一旦回来，auto-fit 就又失效了
    expect(PANEL).not.toContain("gridColumn: '1 / -1'");
    expect(PANEL).not.toContain('md:col-span-2');
  });
});

describe('内存按绝对值展示（百分比在没配 mem_limit 的机器上恒为 0）', () => {
  it('环形缓冲存了绝对字节', () => {
    expect(PANEL).toContain('memBytes');
    expect(DRAWER).toContain('stats.memUsedBytes');
  });

  it('脚注解释了为什么不给百分比', () => {
    expect(PANEL).toContain('mem_limit');
  });
});

/**
 * 缺口必须是缺口（2026-09-02 真人验收）。
 *
 * 线上截图里出现「掉到 0 又冲上去」的深谷，而那一刻没有任何服务空闲过——谷底是
 * 一个没采到样本的桶被映射成 0 画出来的。Netdata 从不画自己没有的值：缺口就是
 * 缺口，几何在那里断开。这几条断言的是几何本身，不是源码里写了什么。
 */
describe('缺口不入几何（Netdata 的画法）', () => {
  it('中间一个空桶把面积切成两段，而不是画一条掉到 0 的谷', () => {
    const vals = [3, 3, 3, 3, 3];
    const present = [true, true, false, true, true];
    const d = areaPath(vals, present, 4, 100);
    expect((d.match(/M/g) ?? []).length, '空桶没有把路径切断，缺口被连了过去').toBe(2);
    // 空桶在 x=500（5 个点均分 0..1000），任何一段都不该落点在那里。
    expect(d, '几何落到了没有数据的那个桶上').not.toMatch(/(^|[ML])500\.0,/);
  });

  it('全都有数据时就是一整段，不会被无谓切碎', () => {
    const d = areaPath([1, 2, 3], [true, true, true], 4, 100);
    expect((d.match(/M/g) ?? []).length).toBe(1);
  });

  it('堆叠图同样断开，且每层断在同一处（层与层的下标不许错开）', () => {
    const present = [true, false, true, true];
    const paths = stackAreas([[1, 1, 1, 1], [2, 2, 2, 2]], present, 8, 100);
    for (const d of paths) {
      expect((d.match(/M/g) ?? []).length, '某一层没有在缺口处断开').toBe(2);
      expect(d).not.toMatch(/(^|[ML])333\.3,/);
    }
  });

  it('孤零零一个桶画成一个桶宽的方块，而不是宽度为 0 的隐形路径', () => {
    const d = areaPath([5, 0, 0], [true, false, false], 8, 100);
    expect(d, '单点没有被展开成可见宽度').not.toBe('');
    const xs = [...d.matchAll(/([ML])(\d+\.\d)/g)].map((m) => Number(m[2]));
    expect(Math.max(...xs) - Math.min(...xs), '单桶孤岛宽度为 0，等于没画').toBeGreaterThan(0);
  });

  it('seedMetricSeries 把 null 记进 present，而不是只留一个计数', () => {
    const seeded = seedMetricSeries([
      { cpuPercent: 1, memUsedBytes: 1, rxRate: 0, txRate: 0 },
      { cpuPercent: null, memUsedBytes: null, rxRate: null, txRate: null },
      { cpuPercent: 2, memUsedBytes: 2, rxRate: 0, txRate: 0 },
    ]);
    expect(seeded.present).toEqual([true, false, true]);
    expect(seeded.filled).toBe(2);
  });
});

/**
 * 渲染冒烟：把带缺口的序列真的渲染一遍。
 *
 * 上面那几条测的是几何函数本身，证明不了「组件真的把掩码传下去了」——那正是
 * 形状 2（建了一半：函数改对了、调用处没接上，编译过、测试绿、图照旧撒谎）。
 * 这一条从组件顶层进，只看最终 SVG。
 */
describe('总览渲染冒烟：缺口真的没被画成 0', () => {
  const seriesWithGap = seedMetricSeries([
    { cpuPercent: 4, memUsedBytes: 100, rxRate: 0, txRate: 0 },
    { cpuPercent: 4, memUsedBytes: 100, rxRate: 0, txRate: 0 },
    // 中间这一桶没采到样本 —— 线上截图里那道「掉到 0」的谷就是它。
    { cpuPercent: null, memUsedBytes: null, rxRate: null, txRate: null },
    { cpuPercent: 4, memUsedBytes: 100, rxRate: 0, txRate: 0 },
    { cpuPercent: 4, memUsedBytes: 100, rxRate: 0, txRate: 0 },
  ]);

  const render = (): string => renderToStaticMarkup(createElement(OverviewPanel, {
    services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
    running: true,
    branchName: 'demo',
    entries: [],
    deployments: [],
    metricSeries: { api: seriesWithGap },
    metricsReady: true,
    replicaSummary: '1 个副本',
    infraSummary: '无',
    now: Date.now(),
    windowMinutes: 30,
    onRefreshMetrics: () => {},
  }));

  it('CPU 堆叠面积在缺口处断成两段', () => {
    const html = render();
    /*
     * 必须只看 CPU 那一段。第一版这里数的是**整页**的多段路径，于是吞吐图（它另有
     * 一条接线）一个人就能让断言成立——把 CPU 图的掩码拆掉照样绿。判据要回答
     * 「这张图断没断」，不是「这一页上有没有哪张图断了」。
     */
    const cpuAt = html.indexOf('CPU 占用');
    const memAt = html.indexOf('内存占用');
    expect(cpuAt, 'CPU 卡没渲染出来，下面的切片会是空的（空切片必然绿）').toBeGreaterThan(-1);
    expect(memAt, '内存卡没渲染出来，切不出 CPU 那一段').toBeGreaterThan(cpuAt);
    const cpuSection = html.slice(cpuAt, memAt);
    const paths = [...cpuSection.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    const areas = paths.filter((d) => d.includes('Z'));
    expect(areas.length, 'CPU 卡里一条面积路径都没有').toBeGreaterThan(0);
    const multi = areas.filter((d) => (d.match(/M/g) ?? []).length >= 2);
    expect(
      multi.length,
      'CPU 面积是一整段——缺口被补 0 连了过去，组件没把 present 掩码传给几何',
    ).toBeGreaterThan(0);
  });
});

/**
 * 历史只有 1 帧的服务，不许在合计里被当成 0（2026-09-02，Codex P2，核对属实）。
 *
 * `liveOnly` 的判据是 `filled < 2`——那是**几何**判据（画不出线），不是「没有数据」。
 * 1 帧也在 liveOnly 里。`/metrics` 挂着或还没回来时，上一版让它整个贡献 0，于是
 * 顶部大数一边写着「合计 2 个服务」，一边把其中一个当成不存在。
 */
/**
 * 分支停了，CPU / 内存也不许再报「当前值」（2026-09-02，Codex P2，核对属实）。
 *
 * `running` 来自 SSE 的分支状态，权威且新鲜；每条序列的 `stopped` 却取自
 * `services[].status`，而那份清单在 `/metrics` 轮询失败时会一直停在
 * `lastGoodMetrics` 的旧值上。两者分岔时上一版是：判断句已经写着「分支未运行」，
 * 同屏的 CPU 大数、内存大数、构成条还在按停机前的残值报「当前」，而且只要轮询
 * 一直失败就无限期这么报。
 *
 * 上一轮只把吞吐接上了这个判据，CPU / 内存两条还各用各的陈旧状态——同一个缺陷
 * 在隔壁又被抓一次，正是「只改被指出的那一处」。
 */
/**
 * 没有曲线时的兜底读数，也要看分支运行态（2026-09-02，Codex P2，核对属实）。
 *
 * 分支停在「还没攒够两桶」或「series 端点正挂着」的时候，`hasPlot` 为假、
 * `liveStats` 里却留着停机前的残值，于是判断句写着「分支未运行」，下面并排摆着
 * 一组标着「当前读数」的旧数字。
 *
 * 这是同一个判据第四次没接上（前三次：吞吐、CPU/内存大数、图例）。守卫直接钉住
 * 「停了就不渲染这块」，别再靠我记得。
 */
describe('分支停了，兜底的实时读数也不端', () => {
  const oneFrame = { api: seedMetricSeries([{ cpuPercent: 7, memUsedBytes: 2048, rxRate: 0, txRate: 0 }]) };
  const base = {
    services: [{ profileId: 'api', containerName: 'api-x', status: 'running' as const }],
    branchName: 'demo',
    entries: [],
    deployments: [],
    metricSeries: oneFrame,          // 只有 1 帧 => hasPlot 为假
    liveStats: { api: { cpuPercent: 7, memUsedBytes: 2048 } },
    metricsReady: true,
    replicaSummary: '1 个副本',
    infraSummary: '无',
    windowMinutes: 30,
    onRefreshMetrics: () => {},
  };

  it('分支已停时不渲染「当前读数」那块', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      ...base, running: false, now: Date.now(),
    }));
    expect(html, '前提没成立：这一屏本该判定为未运行').toContain('分支未运行');
    expect(html, '判断句说停了，下面却并排摆着标「当前读数」的停机前残值').not.toContain('当前读数');
    expect(html, '停机前的 7% 不该以「当前」的名义出现').not.toContain('7.00');
  });

  it('分支在跑、曲线还在攒时照常端出来（防守卫写死成永不渲染）', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      ...base, running: true, now: Date.now(),
    }));
    expect(html, '攒曲线期间该端出已有读数，藏起来比不做还差一档').toContain('当前读数');
    expect(html).toContain('7.00');
  });
});

/**
 * 就绪计数也归一（2026-09-02，Codex P2，核对属实，同一判据第五次）。
 *
 * 分支停掉而 `/metrics` 正挂着时，陈旧清单里每个服务都还写着 running，于是健康环
 * 写「2 / 2 个服务就绪」、底部写「2 个在跑」、合计后缀写「2 个在跑服务合计」，
 * 而同一屏的判断句写着「分支未运行」。
 *
 * 前四次我都是在**用到的那一处**补 `anyRunning`，补一处漏一处。这条守卫钉的是
 * 归一化本身：状态在入口就按分支运行态修正，下面所有读它的地方自动一致。
 */
/**
 * 错误文案不许把内部诊断端到用户脸上（2026-09-02，Codex P1，核对属实）。
 *
 * `ApiError.message` 是 api.ts 拼给开发者的串：
 * `GET /_cds/api/branches/xxx/metrics/series?after=-1800 失败：… (HTTP 500) · requestId=…`
 * 之前直接存进 seriesError / metricsError 并原样渲染，普通用户就在总览上看到内部
 * 路径、HTTP 状态和 requestId。违反 .Codex/rules/user-readable-errors.md 第 1、2、9 条。
 */
describe('取指标失败给的是人话，不是诊断串', () => {
  const raw = 'GET /_cds/api/branches/demo/metrics/series?after=-1800 失败：boom (HTTP 500) · requestId=abc123';

  const leaks = (msg: string): string[] => ['/_cds/', 'HTTP ', 'requestId', 'metrics/series', 'GET ']
    .filter((k) => msg.includes(k));

  it('5xx 映射成人话，且不泄漏端点/状态码/requestId', () => {
    const msg = describeMetricsFailure(new ApiError(500, null, raw, 'abc123'), '指标历史');
    expect(leaks(msg), `诊断信息泄漏到用户文案：${msg}`).toEqual([]);
    expect(msg, '必须说清是什么失败了').toContain('指标历史');
    expect(msg, '必须给恢复动作（规则第 4 条）').toMatch(/重试|重新登录|更新 CDS|刷新/);
  });

  it('权限、缺接口、限流各有分类，不是一句「失败」了事', () => {
    expect(describeMetricsFailure(new ApiError(403, null, raw), '指标历史')).toMatch(/权限/);
    expect(describeMetricsFailure(new ApiError(404, null, raw), '指标历史')).toMatch(/更新 CDS/);
    expect(describeMetricsFailure(new ApiError(429, null, raw), '实时指标')).toMatch(/频繁/);
  });

  it('非 ApiError（网络中断等）也不 String(err) 直出', () => {
    const msg = describeMetricsFailure(new TypeError('Failed to fetch'), '实时指标');
    expect(msg, '把原始异常字符串化直出正是规则第 9 条禁止的').not.toContain('Failed to fetch');
    expect(msg).toMatch(/网络/);
  });

  it('面板渲染的是映射后的文案（端到端，不只测函数）', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
      running: true,
      branchName: 'demo',
      entries: [],
      deployments: [],
      metricSeries: {},
      seriesError: describeMetricsFailure(new ApiError(500, null, raw, 'abc123'), '指标历史'),
      metricsReady: true,
      replicaSummary: '1 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));
    expect(leaks(html.slice(html.indexOf('读取指标历史失败'), html.indexOf('读取指标历史失败') + 400)),
      '渲染出来的那段里仍有诊断信息').toEqual([]);
  });
});

/**
 * 部署在途不等于「分支未运行」（2026-09-02，Codex P2，核对属实）。
 *
 * 分支状态是七档枚举（idle / building / starting / running / restarting /
 * stopping / error），抽屉却把它折叠成一个布尔 `running` 传下来。折叠之后
 * 「正在部署」和「已停机」变成同一个 false —— 部署途中打开总览，判断句说
 * 「分支未运行」、就绪计数被清成 0/N、当前值全被抹掉，而它明明正在起。
 *
 * 这是入口归一那一版**放大出来的**：归一之前各服务还留着自己的 status，环上
 * 至少是真的；归一之后被一刀切成 stopped。修法是把原始状态传下来，不再只给布尔。
 */
/**
 * 轮询的并发取舍已抽成 `lib/latest-wins.ts`，**行为**由
 * `tests/web/latest-wins.test.ts` 用受控延迟响应真正跑一遍（Codex P2，核对属实）。
 *
 * 这里只留一条接线守卫：抽出去的东西必须真的被用上，否则就是「建了一半」
 * （形状 2）——闸门写得再对，抽屉不调它也白搭。
 */
describe('历史轮询走 latest-wins 闸门（接线）', () => {
  it('抽屉真的在用这个闸门，不是各写一套', () => {
    const code = stripComments(DRAWER);
    expect(code, '没接上就等于没修').toContain("from '@/lib/latest-wins'");
    expect(code, '换分支要开新会话').toMatch(/seriesGateRef\.current\.newSession\(\)/);
    const at = code.indexOf('const loadSeries');
    expect(at).toBeGreaterThan(0);
    const body = code.slice(at, at + 2600);
    expect(body, 'loadSeries 要领票').toMatch(/seriesGateRef\.current\.begin\(\)/);
    const accepts = body.match(/seriesGateRef\.current\.accept\(ticket\)/g) ?? [];
    expect(accepts.length, '成功与失败两条路都要过闸门').toBeGreaterThanOrEqual(2);
  });
});

describe('部署在途不谎报「分支未运行」', () => {
  const render = (lifecycle?: string): string => renderToStaticMarkup(createElement(OverviewPanel, {
    services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
    running: lifecycle === 'running',
    lifecycle,
    branchName: 'demo',
    entries: [],
    deployments: [],
    metricSeries: {
      api: seedMetricSeries([
        { cpuPercent: 12, memUsedBytes: 4096, rxRate: 0, txRate: 0 },
        { cpuPercent: 12, memUsedBytes: 4096, rxRate: 0, txRate: 0 },
      ]),
    },
    liveStats: { api: { cpuPercent: 12, memUsedBytes: 4096 } },
    metricsReady: true,
    replicaSummary: '1 个副本',
    infraSummary: '无',
    now: Date.now(),
    windowMinutes: 30,
    onRefreshMetrics: () => {},
  }));

  for (const st of ['building', 'starting', 'restarting']) {
    it(`${st} 时不说「分支未运行」，也不把读数抹掉`, () => {
      const html = render(st);
      expect(html, `${st} 是部署在途，不是停机`).not.toContain('分支未运行');
      expect(html, '就绪计数被清零了').not.toContain('0 / 1 个服务就绪');
      expect(html, '当前值被抹掉了——容器可能正好好跑着').toContain('12.0%');
      expect(html, '应当说清正在部署').toContain('正在部署');
    });
  }

  it('真的停了（stopping / idle）仍按停机处理，归一化没被架空', () => {
    for (const st of ['stopping', 'idle', 'error']) {
      const html = render(st);
      expect(html, `${st} 应当仍判为未运行`).toContain('分支未运行');
      expect(html, `${st} 不该再报当前值`).not.toContain('12.0%');
    }
  });

  /*
   * 入口卡的标签也要分开说（Codex P2，核对属实）。
   * `reachable` 原本吃的是 allServicesReady，而那里含 running，于是重新部署时同一屏
   * 出现三句话：「当前服务仍在运行」「1 / 1 个服务就绪」「服务未就绪，暂不可达」。
   * 服务就绪与否是一件事，部署在途是另一件事，压进一个布尔就会互相打脸。
   * 按 Codex 的要求，这条用例带一个非空 entry。
   */
  it('在途且服务已就绪时，入口卡不说「服务未就绪」', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
      running: false,
      lifecycle: 'restarting',
      branchName: 'demo',
      entries: [{ name: '主入口', url: 'https://example.test', primary: true }],
      deployments: [],
      metricSeries: {
        api: seedMetricSeries([
          { cpuPercent: 12, memUsedBytes: 4096, rxRate: 0, txRate: 0 },
          { cpuPercent: 12, memUsedBytes: 4096, rxRate: 0, txRate: 0 },
        ]),
      },
      metricsReady: true,
      replicaSummary: '1 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));
    expect(html, '服务明明就绪，入口卡却说未就绪').not.toContain('服务未就绪');
    expect(html, '在途该说的是入口可能短暂不可达').toContain('正在部署，入口可能短暂不可达');
  });

  it('一个服务没起来时，入口卡仍如实说「服务未就绪」', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [
        { profileId: 'api', containerName: 'api-x', status: 'running' },
        { profileId: 'web', containerName: 'web-x', status: 'idle' },
      ],
      running: false,
      lifecycle: 'building',
      branchName: 'demo',
      entries: [{ name: '主入口', url: 'https://example.test', primary: true }],
      deployments: [],
      metricSeries: {},
      metricsReady: true,
      replicaSummary: '2 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));
    expect(html, '真没就绪时这句是真话，不能连真话一起改掉').toContain('服务未就绪');
  });

  it('running 时一切正常（防修成永远「正在部署」）', () => {
    const html = render('running');
    expect(html).toContain('一切正常');
    expect(html).toContain('12.0%');
  });

  /*
   * 骨架屏那条注解走同一个判据（Codex P2，核对属实）。
   * 上一版只改了判断句，注解还留着 `!running`——首次部署（在途 + 历史不足两桶）
   * 同屏一句「正在部署」、一句「分支未运行」，后者正是这次要消灭的那句假话。
   */
  it('首次部署（在途且历史不足两桶）时，骨架屏也不说「分支未运行」', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
      running: false,
      lifecycle: 'building',
      branchName: 'demo',
      entries: [],
      deployments: [],
      metricSeries: {},            // 零帧 => 走骨架屏
      metricsReady: true,
      replicaSummary: '1 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));
    expect(html, '骨架屏注解仍在说「分支未运行」，与同屏的「正在部署」打架')
      .not.toContain('分支未运行');
    expect(html, '在途应当说清是在等容器起来').toContain('正在部署');
  });

  /*
   * 状态空间摊开测（Codex P2 ×2，核对属实）。前两轮我按单一维度加分支，于是
   * 「在途 × 服务已就绪」这一格连着出了两个假话：判断句说「0 个服务还没起来」，
   * 骨架屏说「容器起来后开始采样」——而那一刻服务就绪、读数也在。
   */
  it('在途但服务已全就绪时，判断句不说「0 个服务还没起来」', () => {
    const html = render('building');   // services 里那一个是 running
    expect(html, '缺口是 0 还说「0 个服务还没起来」，与下面「1 / 1 就绪」打架')
      .not.toContain('0 个服务还没起来');
    expect(html).toContain('正在部署');
    expect(html, '应当如实说当前服务仍在跑').toContain('当前服务仍在运行');
  });

  it('在途但服务已就绪、且还没攒够历史时，骨架屏不说「容器起来后开始采样」', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
      running: false,
      lifecycle: 'restarting',
      branchName: 'demo',
      entries: [],
      deployments: [],
      metricSeries: {},          // 零帧 => 骨架屏
      metricsReady: true,
      replicaSummary: '1 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));
    expect(html, '容器就绪却说采样还没开始').not.toContain('容器起来后开始采样');
    expect(html).not.toContain('分支未运行');
  });

  it('在途且一个容器都没起来时，才说「容器起来后开始采样」', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [{ profileId: 'api', containerName: 'api-x', status: 'idle' }],
      running: false,
      lifecycle: 'building',
      branchName: 'demo',
      entries: [],
      deployments: [],
      metricSeries: {},
      metricsReady: true,
      replicaSummary: '1 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));
    expect(html, '这一格才是那句话成立的时候').toContain('容器起来后开始采样');
  });

  it('真停且无历史时，骨架屏仍如实说「分支未运行」', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
      running: false,
      lifecycle: 'idle',
      branchName: 'demo',
      entries: [],
      deployments: [],
      metricSeries: {},
      metricsReady: true,
      replicaSummary: '1 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));
    expect(html, '停机时这句是真话，不该被一起改掉').toContain('分支未运行');
  });
});

describe('分支停了，就绪计数也不算陈旧的 running', () => {
  const render = (running: boolean): string => renderToStaticMarkup(createElement(OverviewPanel, {
    services: [
      { profileId: 'api', containerName: 'api-x', status: 'running' },
      { profileId: 'web', containerName: 'web-x', status: 'running' },
    ],
    running,
    branchName: 'demo',
    entries: [],
    deployments: [],
    metricSeries: {
      api: seedMetricSeries([
        { cpuPercent: 3, memUsedBytes: 100, rxRate: 0, txRate: 0 },
        { cpuPercent: 3, memUsedBytes: 100, rxRate: 0, txRate: 0 },
      ]),
    },
    metricsReady: true,
    replicaSummary: '2 个副本',
    infraSummary: '无',
    now: Date.now(),
    windowMinutes: 30,
    onRefreshMetrics: () => {},
  }));

  it('分支已停时不写「2 / 2 个服务就绪」，也不写「2 个在跑」', () => {
    const html = render(false);
    expect(html, '前提没成立：这一屏本该判定为未运行').toContain('分支未运行');
    expect(html, '健康环仍按陈旧清单报满员，和判断句同屏打架').not.toContain('2 / 2 个服务就绪');
    expect(html, '底部仍写「2 个在跑」').not.toContain('2 个在跑');
    expect(html, '应当如实写 0 个就绪').toContain('0 / 2 个服务就绪');
  });

  it('分支在跑时照常满员（防归一化写成永远清零）', () => {
    const html = render(true);
    expect(html).toContain('2 / 2 个服务就绪');
    expect(html).toContain('一切正常');
  });
});

describe('分支停了，CPU 与内存也不报当前值', () => {
  const stale = (): string => renderToStaticMarkup(createElement(OverviewPanel, {
    // 陈旧的 lastGoodMetrics：状态还写着 running
    services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
    running: false,                      // SSE 权威：分支已停
    branchName: 'demo',
    entries: [],
    deployments: [],
    metricSeries: {
      api: seedMetricSeries([
        { cpuPercent: 33, memUsedBytes: 4096, rxRate: 0, txRate: 0 },
        { cpuPercent: 33, memUsedBytes: 4096, rxRate: 0, txRate: 0 },
      ]),
    },
    liveStats: { api: { cpuPercent: 33, memUsedBytes: 4096 } },  // 停机前的残值
    metricsReady: true,
    replicaSummary: '1 个副本',
    infraSummary: '无',
    now: Date.now(),
    windowMinutes: 30,
    onRefreshMetrics: () => {},
  }));

  it('判断句说「分支未运行」时，同屏不会还写着 33% CPU', () => {
    const html = stale();
    expect(html, '前提没成立：这一屏本该判定为未运行').toContain('分支未运行');
    expect(html, '一屏之内自相矛盾：上面说停了，下面还在报当前用量').not.toContain('33.0%');
    expect(html, '每服务图例同样不许端出停机前的残值').not.toContain('33.00');
  });

  it('分支在跑时照常报（防我把判据写死成永远不报）', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
      running: true,
      branchName: 'demo',
      entries: [],
      deployments: [],
      metricSeries: {
        api: seedMetricSeries([
          { cpuPercent: 33, memUsedBytes: 4096, rxRate: 0, txRate: 0 },
          { cpuPercent: 33, memUsedBytes: 4096, rxRate: 0, txRate: 0 },
        ]),
      },
      liveStats: { api: { cpuPercent: 33, memUsedBytes: 4096 } },
      metricsReady: true,
      replicaSummary: '1 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));
    expect(html, '在跑却不报，等于把守卫写成永远绿').toContain('33.0%');
  });
});

describe('分支停了就没有「当前速率」', () => {
  const withRates = seedMetricSeries([
    { cpuPercent: 4, memUsedBytes: 100, rxRate: 1024, txRate: 2048 },
    { cpuPercent: 4, memUsedBytes: 100, rxRate: 1024, txRate: 2048 },
  ]);
  const render = (status: 'running' | 'stopped', running: boolean): string =>
    renderToStaticMarkup(createElement(OverviewPanel, {
      services: [{ profileId: 'api', containerName: 'api-x', status }],
      running,
      branchName: 'demo',
      entries: [],
      deployments: [],
      metricSeries: { api: withRates },
      metricsReady: true,
      replicaSummary: '1 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));

  /** 只看吞吐卡那一段，别让别处的数字替这条断言作证。 */
  const throughput = (html: string): string => {
    const at = html.indexOf('吞吐');
    expect(at, '吞吐卡没渲染出来（空切片必然绿）').toBeGreaterThan(-1);
    return html.slice(at);
  };

  it('在跑时照常报当前速率', () => {
    const t = throughput(render('running', true));
    expect(t, '1024 B/s 应当出现在读数里').toContain('1.00 KiB');
    expect(t).not.toContain('暂不可用');
  });

  it('停了之后大数与两行读数都说暂不可用，而不是端出停机前的速率', () => {
    const t = throughput(render('stopped', false));
    expect(t, '分支没在跑却仍在报当前速率').not.toContain('1.00 KiB/s');
    expect(t, '大数应当说暂不可用').toContain('暂不可用');
    expect(t, '网络与磁盘两行读数也该跟着').toContain('当前速率暂不可用');
  });

  it('历史几何仍然画出来（过去它确实在跑）', () => {
    const t = throughput(render('stopped', false));
    const paths = [...t.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    expect(paths.filter((d) => d.includes('Z')).length, '把历史一起抹掉就过头了').toBeGreaterThan(0);
  });
});

/**
 * 同一次部署不许在柱状图里出现两根柱子（2026-09-02，Codex P2，核对属实）。
 *
 * 「部署并打开」的实时记录 kind 是 `preview`，它落库后回来却恒为 `deploy`；
 * 按 kind 严格相等去重就两条都留下 —— 抽屉一 reload，中位线、成功率、趋势
 * 全被同一次部署算了两遍。这条与「open 不算构建」是**同一个 kind 别名问题的
 * 另一半**：那半管「不该进来的别进来」，这半管「同一件事别算两遍」。
 */
describe('构建类 kind 别名在去重时归一', () => {
  it('preview 与 deploy 视作同一件事（这正是「部署并打开」的两种叫法）', () => {
    expect(sameOperationKind('preview', 'deploy')).toBe(true);
    expect(sameOperationKind('deploy', 'rebuild')).toBe(true);
    expect(sameOperationKind('deploy', 'deploy')).toBe(true);
  });

  it('open 不是构建，不与构建类归并', () => {
    expect(sameOperationKind('open', 'deploy'), 'open 只打开、不构建').toBe(false);
    expect(sameOperationKind('open', 'preview')).toBe(false);
    expect(sameOperationKind('open', 'open'), '同类仍应相等').toBe(true);
  });

  it('非构建类之间仍按严格相等', () => {
    expect(sameOperationKind('restart', 'stop')).toBe(false);
    expect(sameOperationKind('restart', 'restart')).toBe(true);
  });
});

describe('只有一帧历史的服务，合计里照样算它', () => {
  const render = (live?: Record<string, { cpuPercent: number; memUsedBytes: number }>): string =>
    renderToStaticMarkup(createElement(OverviewPanel, {
      services: [
        { profileId: 'api', containerName: 'api-x', status: 'running' },
        // web 只有 1 帧：filled=1 < 2，进 liveOnly，不参与几何。
        { profileId: 'web', containerName: 'web-x', status: 'running' },
      ],
      running: true,
      branchName: 'demo',
      entries: [],
      deployments: [],
      metricSeries: {
        api: seedMetricSeries([
          { cpuPercent: 10, memUsedBytes: 100, rxRate: 0, txRate: 0 },
          { cpuPercent: 10, memUsedBytes: 100, rxRate: 0, txRate: 0 },
        ]),
        web: seedMetricSeries([{ cpuPercent: 7, memUsedBytes: 100, rxRate: 0, txRate: 0 }]),
      },
      liveStats: live,
      metricsReady: true,
      replicaSummary: '2 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));

  /** 「其他 N 个」那条图例就是 liveOnly 的去处，两位小数，切出来单独看。 */
  const otherLegend = (html: string): string => {
    const at = html.indexOf('其他 1 个');
    expect(at, '没渲染出「其他 1 个」——liveOnly 整个没进图例').toBeGreaterThan(-1);
    return html.slice(at, at + 240);
  };

  it('/metrics 没回来时，那一帧照样算（其他 = 7.00，合计 17.0%）', () => {
    const html = render(undefined);
    expect(otherLegend(html), 'web 那 1 帧被当成 0').toContain('7.00');
    expect(html, '顶部大数跟着少报').toContain('CPU 合计 17.0%');
  });

  it('实时快照在手上时优先用快照（其他 = 9.00，合计 19.0%）', () => {
    const html = render({
      api: { cpuPercent: 10, memUsedBytes: 100 },
      web: { cpuPercent: 9, memUsedBytes: 100 },
    });
    expect(otherLegend(html)).toContain('9.00');
    expect(html).toContain('CPU 合计 19.0%');
  });
});

/**
 * 「打开正在跑的预览」失败，不算一次构建失败（2026-09-02，Codex P2，核对属实）。
 *
 * openRunningPreview 一行都不构建，只拼 URL 跳过去；它失败时（最常见：缺预览域名
 * 配置）此前落的是一条 finished + error 的 `preview` 记录，而柱状图按 kind 收，
 * 于是成功率和「上次构建耗时」被一次根本没发生的构建污染。
 */
describe('部署统计只收真的构建', () => {
  const LIST = fs.readFileSync(path.join(SRC, 'pages/BranchListPage.tsx'), 'utf8');

  it('openRunningPreview 用的是 open，不是 preview', () => {
    const code = stripComments(LIST);
    const at = code.indexOf('const openRunningPreview');
    expect(at, '找不到 openRunningPreview，选择器过时了').toBeGreaterThan(0);
    const body = code.slice(at, code.indexOf('const openBranchDetail', at));
    expect(body, '成功/失败两处 kind 都该是 open').not.toMatch(/Action\([^)]*'preview'/);
    expect(body, '失败时应落 open 记录').toMatch(/finishAction\([^)]*'open'/);
  });

  it('柱状图的 kind 白名单不含 open', () => {
    const code = stripComments(DRAWER);
    const at = code.indexOf('const overviewDeployments');
    expect(at).toBeGreaterThan(0);
    const filter = code.slice(at, code.indexOf('[combinedDeployments]', at));
    expect(filter, 'open 混进来就等于没修').not.toContain("kind === 'open'");
    expect(filter, "构建类三种要还在").toContain("kind === 'deploy'");
  });
});

/**
 * 一屏之内不许自相矛盾（2026-09-02，Codex P2，核对属实）。
 *
 * 入口卡的绿灯此前判 `badServices.length === 0`，判断句判「全部就绪」。一个服务
 * 只是 idle / stopped（不是 error）时两者分岔：顶上写「还有 1 个服务没起来」，
 * 下面的入口卡却是绿的、写着可直达——而没起来的那个很可能正是入口指向的那个。
 */
describe('入口卡的绿灯与顶部判断句同源', () => {
  it('一个服务没起来时，入口卡不再说可直达', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [
        { profileId: 'api', containerName: 'api-x', status: 'running' },
        { profileId: 'web', containerName: 'web-x', status: 'stopped' },
      ],
      running: true,
      branchName: 'demo',
      entries: [{ name: '主入口', url: 'https://example.test', primary: true }],
      deployments: [],
      metricSeries: {},
      metricsReady: true,
      replicaSummary: '2 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));
    expect(html, '判断句应该说还有服务没起来').toContain('还有 1 个服务没起来');
    expect(html, '入口卡仍在说可直达，和上面那句话互相打脸').not.toContain('已就绪');
  });

  it('全部就绪时入口卡才给绿灯', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
      running: true,
      branchName: 'demo',
      entries: [{ name: '主入口', url: 'https://example.test', primary: true }],
      deployments: [],
      metricSeries: {},
      metricsReady: true,
      replicaSummary: '1 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));
    expect(html).toContain('一切正常');
    expect(html, '全部就绪却没给绿灯——守卫会因此变成永远绿的摆设').toContain('已就绪');
  });
});

/**
 * 曲线还在攒的时候，手上已有的实时读数不许藏起来（2026-09-02，Codex P2，核对属实）。
 *
 * 冷启动 / 刚部署的分支上，每个服务的历史都不足两帧，`hasPlot` 为假，此前就只剩
 * 一个骨架屏——而 `liveStats` 里明明已经有真实的 CPU 与内存读数。为了等一条曲线
 * 把手上已有的数字也藏起来，比不做还差一档。
 */
describe('没有曲线时也要端出当前读数', () => {
  const oneFrame = seedMetricSeries([{ cpuPercent: 4, memUsedBytes: 1048576, rxRate: 0, txRate: 0 }]);
  const props = {
    services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
    running: true,
    branchName: 'demo',
    entries: [],
    deployments: [],
    metricsReady: true,
    replicaSummary: '1 个副本',
    infraSummary: '无',
    now: Date.now(),
    windowMinutes: 30,
    onRefreshMetrics: () => {},
  };

  it('历史还在攒时，实时读数与骨架屏同时在场', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      ...props,
      metricSeries: { api: oneFrame },
      liveStats: { api: { cpuPercent: 12.5, memUsedBytes: 3145728 } },
    }));
    expect(html, '骨架屏应该还在（它给的是「还要等多久」）').toMatch(/约还需|攒够两帧/);
    expect(html, '手上已有的实时读数被藏起来了').toContain('当前读数');
    expect(html).toContain('实时快照 · 曲线还在攒');
    expect(html, '真实读数没渲染出来').toContain('12.50');
  });

  it('历史端点挂了时，副标题说的是「无历史曲线」而不是「还在攒」', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      ...props,
      metricSeries: {},
      liveStats: { api: { cpuPercent: 7, memUsedBytes: 1048576 } },
      seriesError: '端点 500',
    }));
    expect(html).toContain('实时快照 · 无历史曲线');
    expect(html, '这一档不该说「还在攒」——它不会自己好').not.toContain('实时快照 · 曲线还在攒');
  });

  it('连实时读数都没有时不渲染这块空壳', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      ...props,
      metricSeries: { api: oneFrame },
      liveStats: {},
    }));
    expect(html).not.toContain('当前读数');
  });
});

/**
 * 两条接线守卫（2026-09-02，Codex P2，均核对属实）。
 *
 * 都是「编译过、测试绿、通读也看不出」的那一类：一个是整张卡从来没渲染过，
 * 一个是一次网络抖动就把界面打回更陈的快照。
 */
describe('总览的数据源接对了地方', () => {
  it('部署柱状图吃的是带历史的那一份，不是一个分支最多一条的那份', () => {
    const code = stripComments(DRAWER);
    const at = code.indexOf('const overviewDeployments');
    expect(at, '找不到 overviewDeployments').toBeGreaterThan(-1);
    const memo = code.slice(at, at + 600);
    expect(
      memo,
      'visibleDeployments 来自按分支 id 作键的 actions，一个分支最多一条，'
      + '而柱状图要 3 条才画——接它等于这张卡永远不渲染',
    ).not.toMatch(/=>\s*visibleDeployments/);
    expect(memo).toMatch(/=>\s*combinedDeployments/);
    // 依赖顺序：combinedDeployments 必须在它之前定义，否则运行时直接炸。
    expect(code.indexOf('const combinedDeployments')).toBeLessThan(at);
  });

  it('一次轮询失败不会把服务清单打回打开时的快照', () => {
    const code = stripComments(DRAWER);
    expect(code, '没有保留最后一次成功的响应').toMatch(/setLastGoodMetrics\(data\)/);
    expect(code, '切分支时没清空，会把上一个分支的服务挂到新分支上').toMatch(/setLastGoodMetrics\(null\)/);
    const at = code.indexOf('const overviewServices');
    const memo = code.slice(at, at + 700);
    /*
     * 断言它出现在**兜底那一侧**，不是只出现在依赖数组里。
     * 第一版写的是 toContain('lastGoodMetrics')——把三元的 else 改回 null，
     * 依赖数组里那个名字还在，守卫照样绿（形状 4b：空跑的绿灯）。
     */
    expect(memo, '失败时没有退回最后一次成功的那一帧').toMatch(/:\s*lastGoodMetrics/);
  });
});

/**
 * 三条（2026-09-02，Codex P2，均核对属实）。
 *
 * 第一条又是「掉到 0」那种谎，只是发生在速率这一维上——上一轮只把 CPU 那条路修好了。
 */
describe('速率算不出来时不许当成 0', () => {
  it('首帧的速率是 null，掩码上也标成没有', () => {
    const seeded = seedMetricSeries([
      { cpuPercent: 3, memUsedBytes: 100, rxRate: null, txRate: null },
      { cpuPercent: 3, memUsedBytes: 100, rxRate: 2048, txRate: 1024 },
    ]);
    expect(seeded.present, '这两桶都有样本').toEqual([true, true]);
    expect(seeded.ratePresent, '首帧算不出速率，速率掩码必须与样本掩码分开').toEqual([false, true]);
  });

  it('吞吐图吃的是速率掩码，不是样本掩码', () => {
    const code = stripComments(PANEL);
    const at = code.indexOf('<ThroughputChart');
    expect(at).toBeGreaterThan(-1);
    const call = code.slice(at, code.indexOf('/>', at));
    expect(call, '用样本掩码画吞吐图，算不出速率的那几帧会被画成测到了 0').toMatch(
      /present=\{axisRatePresent\}/,
    );
  });
});

describe('分支状态与部署来源', () => {
  it('running 优先用实时状态，不是「有一边说在跑就算在跑」', () => {
    const code = stripComments(DRAWER);
    const at = code.indexOf('<OverviewPanel');
    const call = code.slice(at, code.indexOf('/>', at));
    expect(call, '或运算会让停掉的分支因为陈快照继续显示为运行中').not.toMatch(
      /running=\{[^}]*\|\|[^}]*\}/,
    );
    expect(call).toMatch(/running=\{branchStatus \? branchStatus === 'running'/);
  });

  it('两个部署来源合并时去重，否则最近那次会出现两根柱子', () => {
    const code = stripComments(DRAWER);
    const at = code.indexOf('const combinedDeployments');
    const memo = code.slice(at, at + 1400);
    expect(memo, '直接拼接会让同一次部署出现两次，带偏中位线与成功率').not.toMatch(
      /const all\s*=\s*\[\.\.\.visibleDeployments,\s*\.\.\.legacy\]/,
    );
    expect(memo).toMatch(/START_TOLERANCE_MS/);
    /*
     * 这里原本钉的是 `kept.kind === item.kind` 这段字面量——而那正是下一条要修的
     * 缺陷本身（preview / deploy 是同一次部署的两种叫法，严格相等留成两条）。
     * 判据钉在实现字面上，就会变成「谁修这个 bug 谁的 CI 红」（形状 4a）。
     * 改成：比较必须走归一化函数，函数的行为另有直接断言。
     */
    expect(memo, '按 kind 严格相等去重，别名对留不住').toMatch(/sameOperationKind\(/);
  });
});

/**
 * 两条（2026-09-02，Codex P2，均核对属实）。
 * 第一条是我上一轮加速率掩码时留下的；第二条是一屏内数字与图形自相矛盾。
 */
describe('合计要么完整要么不画', () => {
  it('本桶有样本却算不出速率的服务，会把这一桶的合计判为不完整', () => {
    const code = stripComments(PANEL);
    const at = code.indexOf('const axisRatePresent');
    expect(at, '找不到 axisRatePresent').toBeGreaterThan(-1);
    const memo = code.slice(at, at + 700);
    expect(
      memo,
      '用 some 只要有一个服务算得出速率就判有数据，而 sumOf 会把算不出的那个当 0 加进去——'
      + '端出一份残缺的合计',
    ).not.toMatch(/axisRatePresent[\s\S]{0,200}\.some\(/);
    expect(memo).toMatch(/\.every\(/);
  });
});

describe('构成条不画不存在的占用', () => {
  const base = {
    running: true,
    branchName: 'demo',
    entries: [],
    deployments: [],
    metricSeries: {},
    metricsReady: true,
    replicaSummary: '1 个副本',
    infraSummary: '无',
    now: Date.now(),
    windowMinutes: 30,
    onRefreshMetrics: () => {},
  };

  it('服务全停时构成条不是一整条彩色，旁边的大数也是 0', () => {
    const code = stripComments(PANEL);
    const bar = code.slice(code.indexOf('function CompositionBar'), code.indexOf('function SeriesLegend'));
    expect(
      bar,
      'total 为 0 时给每行等分，会在「0 B」旁边画出一整条画满的彩色条',
    ).not.toMatch(/total > 0 \?[\s\S]{0,80}: '1 0 0'/);
    expect(bar, '值为 0 的行不该进条').toMatch(/filter\(\(r\) => r\.value > 0\)/);
  });

  it('渲染冒烟：停掉的服务在清单里写「停止」，不给它一段颜色', () => {
    /*
     * 要让构成条真的渲染出来，得先有画得出来的历史（hasPlot 要两帧真样本）——
     * 只给一个 status 而不给序列，整段图区会被换成骨架屏，这条就成了空跑的绿灯。
     */
    const twoFrames = seedMetricSeries([
      { cpuPercent: 1, memUsedBytes: 2_000_000, rxRate: 1, txRate: 1 },
      { cpuPercent: 1, memUsedBytes: 2_000_000, rxRate: 1, txRate: 1 },
    ]);
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      ...base,
      services: [{ profileId: 'api', containerName: 'api-x', status: 'stopped' }],
      metricSeries: { api: twoFrames },
      liveStats: {},
    }));
    expect(html, '构成条没渲染出来，这条断言会空跑').toContain('内存占用');
    expect(html, '停机服务应该写「停止」，而不是端出停机前的旧读数').toContain('停止');
  });
});

/**
 * Hook 不许写在模块顶层（2026-09-02，Codex P1，核对属实）。
 *
 * 这条守卫的来历值得写下来：我把一个 `useState` 挪出了组件、落到了 import 之前的
 * 模块顶层。`tsc --noEmit` 过、`pnpm build` 过、6445 条用例全绿——因为**没有任何
 * 一条用例真的渲染过这个抽屉**，而模块顶层的 const 在类型与打包层面完全合法。
 * 只有真人打开分支页才会炸（invalid hook call），而那时它已经上线了。
 *
 * 判据扫的是「零缩进的 hook 调用」，覆盖整个组件目录，不只这一个文件——
 * 一个类，不是一处。
 */
describe('hook 只能在组件里调用（形状：编译过、测试绿、打开就炸）', () => {
  /*
   * 泛型要一起认：`useState<{ a: number }>(null)` 里 hook 名与左括号之间隔着一段
   * 类型参数。第一版漏了这一档，于是把真实的越界写法放了过去——判据自己空跑
   * （形状 4b），而它要防的恰恰就是那一行。
   */
  const HOOK_AT_MODULE_SCOPE = /^(?:const|let|var)\s+.*=\s*use[A-Z]\w*\s*(?:<[^=]*>)?\s*\(|^use[A-Z]\w*\s*(?:<[^=]*>)?\s*\(/;

  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return e.isFile() && full.endsWith('.tsx') ? [full] : [];
    });

  it('web/src 下没有任何 tsx 在模块顶层调用 hook', () => {
    const files = walk(SRC);
    expect(files.length, '一个文件都没扫到，判据会空跑').toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (HOOK_AT_MODULE_SCOPE.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders, `hook 写在了模块顶层，打开页面即抛 invalid hook call：\n${offenders.join('\n')}`).toEqual([]);
  });
});

/**
 * 直接 import 抽屉模块——**最强的那条判据**。
 *
 * 上面那条正则守卫是静态扫描，只能认它想得到的写法（第一版就漏了泛型）。而 hook
 * 落到模块顶层时，`import` 这个动作本身就会抛 invalid hook call——所以只要把模块
 * 真的加载一次，任何形态的越界都藏不住，不依赖任何正则。
 *
 * 这条本该一开始就有：6445 条用例全绿却让一个「打开就白屏」的改动上了线，根因是
 * **没有任何一条用例真的加载过这个模块**。
 */
describe('抽屉模块能被加载（模块顶层不许有副作用）', () => {
  it('import BranchDetailDrawer 不抛错', async () => {
    const mod = await import('@/components/BranchDetailDrawer');
    expect(typeof mod.BranchDetailDrawer, '导出的组件不见了').toBe('function');
  });
});

/**
 * 两条（2026-09-02，Codex P2，均核对属实）。
 */
describe('当前值与轴标签不许含糊', () => {
  /*
   * 判据从「某一行不许出现 at(-1)」升级成「整个文件的当前值位置都不许出现」。
   *
   * 这件事修过三次才修全：每服务当前值、尾部聚合、吞吐读数与大数——同一个错法散在
   * 三处，我每次只改被指出的那一处（Codex 连着提了三轮）。所以判据也得覆盖全文件，
   * 而不是钉住某一行。
   */
  it('当前值一律取最后一个真有样本的桶，全文件不许再读零填充的末格', () => {
    const code = stripComments(PANEL);
    expect(code, '找不到共用的取值函数').toMatch(/function latestPresent\(/);
    const offenders = code.split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /\.at\(-1\)\s*\?\?\s*0/.test(line));
    expect(
      offenders.map((o) => `${o.no}: ${o.line}`),
      '数组末格常常是被映射成 0 的空桶，当作「现在」端出去就是凭空的读数',
    ).toEqual([]);
  });

  it('轴两端标真实钟点，不是「N 分钟前 / 现在」', () => {
    const code = stripComments(PANEL);
    const at = code.indexOf('xLabels={');
    const call = code.slice(at, at + 260);
    expect(call, '右端是吸附后的 before，可能比此刻晚不到一个桶宽，说「现在」就有偏差').toContain('clockLabel');
    expect(code).toMatch(/function clockLabel\(/);
  });

  it('渲染冒烟：给了真实区间就画出钟点', () => {
    const twoFrames = seedMetricSeries([
      { cpuPercent: 1, memUsedBytes: 1, rxRate: 1, txRate: 1 },
      { cpuPercent: 2, memUsedBytes: 2, rxRate: 1, txRate: 1 },
    ]);
    const start = new Date(2026, 8, 2, 11, 2).getTime();
    const end = new Date(2026, 8, 2, 11, 34).getTime();
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
      running: true,
      branchName: 'demo',
      entries: [],
      deployments: [],
      metricSeries: { api: twoFrames },
      metricsReady: true,
      replicaSummary: '1 个副本',
      infraSummary: '无',
      now: end,
      windowMinutes: 32,
      rangeStart: start,
      rangeEnd: end,
      onRefreshMetrics: () => {},
    }));
    expect(html).toContain('11:02');
    expect(html).toContain('11:34');
    expect(html, '仍在用含糊的「现在」标右端').not.toMatch(/>现在</);
  });
});

describe('吞吐读数不把「算不出来」写成 0', () => {
  it('速率掩码全为假时，读数与大数都说暂不可用', () => {
    const oneFrameNoRate = seedMetricSeries([
      { cpuPercent: 3, memUsedBytes: 100, rxRate: null, txRate: null },
      { cpuPercent: 3, memUsedBytes: 100, rxRate: null, txRate: null },
    ]);
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
      running: true,
      branchName: 'demo',
      entries: [],
      deployments: [],
      metricSeries: { api: oneFrameNoRate },
      metricsReady: true,
      replicaSummary: '1 个副本',
      infraSummary: '无',
      now: Date.now(),
      windowMinutes: 30,
      onRefreshMetrics: () => {},
    }));
    expect(html, '吞吐卡没渲染出来，这条断言会空跑').toContain('吞吐');
    expect(html, '算不出速率却写成 0/s——图上是缺口、旁边却报了一个读数').toContain('暂不可用');
  });
});

describe('四处文案真的接上了状态表（台账 D11，形状 2）', () => {
  /**
   * overview-state.test.ts 穷举的是**表**；这里量的是**面板有没有在用它**。
   * 抽掉那次接线，模块与它的单测仍然全绿，只有这里会红——形状 2 的典型。
   *
   * 断言的是渲染出来的话，不是源码里的写法（形状 4a：不许钉实现字面量）。
   */
  const render = (over: Record<string, unknown>): string => renderToStaticMarkup(createElement(OverviewPanel, {
    services: [],
    running: false,
    branchName: 'demo',
    entries: [],
    deployments: [],
    metricSeries: {},
    metricsReady: true,
    replicaSummary: '无',
    infraSummary: '无',
    now: Date.now(),
    windowMinutes: 30,
    onRefreshMetrics: () => {},
    ...over,
  }));

  it('在跑却一个服务都没配时，不谎报「还有 0 个服务没起来」', () => {
    const html = render({ running: true, lifecycle: 'running' });
    expect(html, '同屏另一句写着「还没有任何 service」，这句却在数缺口').not.toContain('0 个服务没起来');
    expect(html, '应当直接说清根因').toContain('尚未配置服务');
  });

  it('正在开通（在途 + 服务集还没分配）不劝用户「先去构建配置」', () => {
    const html = render({ lifecycle: 'building' });
    expect(html, '分配服务集的是执行器，不是用户').not.toContain('先去构建配置');
    expect(html, '应当说清正在开通').toContain('正在开通');
  });

  it('静止态、没配服务：仍然给得出可执行的下一步', () => {
    const html = render({ lifecycle: 'idle' });
    expect(html).toContain('尚未配置服务');
    expect(html, '这一档才该劝去配置').toContain('先去构建配置');
  });

  it('入口卡副标题与顶上的判断句同源：在途且全就绪时两句话不打架', () => {
    const html = render({
      services: [{ profileId: 'api', containerName: 'api-x', status: 'running' }],
      lifecycle: 'restarting',
      entries: [{ name: '主入口', url: 'https://example.test', primary: true }],
    });
    expect(html).toContain('正在部署，当前服务仍在运行');
    expect(html, '入口卡不该说服务未就绪').not.toContain('服务未就绪，暂不可达');
    expect(html).toContain('正在部署，入口可能短暂不可达');
  });
});
