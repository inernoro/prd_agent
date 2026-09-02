import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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

  it('图例的当前值走实时快照，不是序列最后一个桶（桶是数十秒的平均，慢一拍）', () => {
    expect(PANEL_CODE).toContain('liveStats');
    expect(PANEL_CODE).toMatch(/readLive\(live\)/);
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
    expect(PANEL_CODE).toContain('SAMPLER_CADENCE_SECONDS');
    expect(PANEL_CODE).toMatch(/约还需/);
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

  it('历史端点失败不再被静默吞掉', () => {
    const code = stripComments(DRAWER);
    const load = code.slice(code.indexOf('const loadSeries'), code.indexOf('const loadSeries') + 1600);
    expect(load, 'catch 全吞会让骨架屏永远承诺一条不会出现的曲线').toMatch(/catch\s*\([\s\S]{0,40}\)\s*\{[\s\S]{0,300}setSeriesError/);
    expect(PANEL_CODE).toContain('seriesError');
  });

  /**
   * Codex P2（核对属实）：漏掉了「先成功、后持续失败」那条路——`metricSeries` 还留着
   * 上一次的结果，`hasPlot` 仍为真，于是两个错误分支都被 `!hasPlot` 挡掉，一条过期
   * 曲线顶着「近 30 分钟」的标签无限期挂着，一句提示都没有。
   */
  it('历史失败的提示不被 hasPlot 挡住：有旧图时也要说这条曲线是旧的', () => {
    const strip = PANEL_CODE.slice(PANEL_CODE.indexOf('{seriesError'), PANEL_CODE.indexOf('{seriesError') + 200);
    expect(strip, '找不到历史错误提示，选择器过时了').toContain('seriesError');
    expect(strip, '这一条不该被 hasPlot 门住——先成功后失败时它正是唯一的提示').not.toMatch(/seriesError\s*&&\s*!hasPlot\s*\?/);
    expect(PANEL_CODE, '有旧图时要明说它不是当前的 30 分钟').toContain('已经不再更新');
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
    expect(ok, '成员集合必须来自 metricsState，而不只是拿它补 status').toContain(
      'metricsState.data.services',
    );
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
  it('图例按 status 判停，不是拿末值当现值', () => {
    expect(PANEL).toContain("stopped: x.svc.status !== 'running'");
    expect(PANEL).toContain('s.stopped ?');
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
