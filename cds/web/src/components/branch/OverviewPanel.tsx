import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, RefreshCw, Rocket, Server, Settings } from 'lucide-react';

/**
 * 分支总览（2026-09-01 重排）。
 *
 * 上一版是八个等重方块 + 每个服务一张大卡重复同一组数字：一屏里四个方块显示 0，
 * 下面五张卡把那四个数再铺一遍，用户得自己读完再算出结论。用户的原话是
 * 「可视化太小，不是字就是线，既不好看，也不够直观」。
 *
 * 这一版的判断顺序是「先结论、再证据、最后原始数字」，每块指标都做成真图形：
 *   - 分段健康环：唯一有真实上限的量（几个服务就绪），每段是一个服务，红一段就知道是谁
 *   - CPU / 内存堆叠面积图：一张图同时回答「总共多少」和「谁占的」，图例即当前值表
 *   - 网络双向面积图：收在上、发在下，共用一根基线
 *   - 部署耗时柱状图：柱高=耗时，虚线=中位，红柱=失败，趋势由柱子自己说
 *
 * 配色走 --series-1..5（见 index.css），不复用语义四色 ok/warn/bad/info——
 * 那四档是保留的状态色，拿来当「第 4 个服务」会跟「警告」撞成同一个红。
 */

/**
 * per service+metric 的序列。长度与窗口都由服务端 series 端点决定。
 *
 * 2026-09-02 起前端不再自己往尾巴上追加实时点：铺底用的是服务端的桶（每桶数十秒），
 * 而实时点是 5 秒一个，两种粒度混进同一个按下标等距绘制的数组，X 轴就开始说谎，
 * 且抽屉开得越久越离谱。现在整条数组每次由服务端重算，一条轴只有一个口径。
 */
export interface MetricSeries {
  cpu: number[];        // %
  mem: number[];        // % of limit
  /** 绝对占用字节。百分比在没配 mem_limit 的机器上恒等于 0（除数是宿主机总量），读不出信息。 */
  memBytes: number[];
  rxRate: number[];     // bytes/sec
  txRate: number[];     // bytes/sec
  /** 块设备读写速率。docker stats 一直在返回，采集器此前丢弃（2026-09-02 补采）。 */
  readRate: number[];
  writeRate: number[];
  /**
   * 真有样本的桶数（服务端给 null 的不算）。
   *
   * 值里的 null 被映射成 0 才能参与堆叠，映射之后就分不出「没数据」和「用量为 0」了。
   * 骨架屏要如实说「已经攒了几帧」，所以在丢失这个信息之前先数一遍。
   */
  filled: number;
}

/**
 * 把服务端序列转成组件用的形状。
 *
 * 抽屉一打开就有完整曲线，不必干等攒点；关掉再打开也接得上，因为点存在服务端。
 * 速率已由服务端算好（累计差 / 间隔），前端不再从累计字节自己算。
 */
export function seedMetricSeries(points: Array<{
  cpuPercent: number | null; memUsedBytes: number | null; rxRate: number | null; txRate: number | null;
  readRate?: number | null; writeRate?: number | null;
}>): MetricSeries {
  // 服务端已按 points 上限分桶，这里不再二次截断——截断会让不同容器的数组长度
  // 在边界上错开，正是「黑色缺口」那个缺陷的成因。
  const tail = points;
  // null = 那一段这个容器没有样本（没起来 / 已停 / 断档）。堆叠图里它的贡献就是 0，
  // 于是那一段的色带自然收没——这正是「服务挂了」在图上该有的样子。
  const v = (x: number | null): number => (x == null ? 0 : x);
  return {
    cpu: tail.map((p) => v(p.cpuPercent)),
    mem: tail.map(() => 0),
    memBytes: tail.map((p) => v(p.memUsedBytes)),
    rxRate: tail.map((p) => v(p.rxRate)),
    txRate: tail.map((p) => v(p.txRate)),
    readRate: tail.map((p) => v(p.readRate ?? null)),
    writeRate: tail.map((p) => v(p.writeRate ?? null)),
    filled: tail.filter((p) => p.cpuPercent != null).length,
  };
}

/**
 * 系列色按固定次序赋值，**不循环**（dataviz 硬约束：第 9 个系列不许生成新色）。
 * 超过 5 个服务时，占用最小的那些合并成一条「其他」，用中性色。
 */
/** 常驻采样器的节奏。骨架屏用它算「还要等多久」，不编百分比。 */
const SAMPLER_CADENCE_SECONDS = 45;

const SERIES_SLOTS = 5;
const seriesColor = (i: number): string => `hsl(var(--series-${i + 1}))`;
/**
 * 「其他 N 个」的颜色。
 *
 * 原来用 --hairline-strong，那是描边色，在深色底上明度够高、面积一大就成了图里
 * 最抢眼的一块死灰，读起来像阴影不像数据。它是尾部聚合、天然是背景，必须退下去：
 * 用去饱和的 muted-foreground 低透明度，明确比任何一个具名服务弱一档。
 */
const OTHER_COLOR = 'hsl(var(--muted-foreground) / 0.3)';

/** 堆叠段之间的留白（px）。dataviz：分隔靠表面色的缝，不靠给每段描边。 */
const STACK_GAP = 2;

export interface OverviewService {
  profileId: string;
  containerName: string;
  status: string;
}

export interface OverviewEntry {
  name: string;
  url: string;
  subdomain?: string;
  primary?: boolean;
}

export interface OverviewDeployment {
  key: string;
  kind: string;
  status: 'running' | 'success' | 'error';
  commitSha?: string;
  startedAt: number;
  finishedAt?: number;
}

// ── 几何小工具 ────────────────────────────────────────────────────────────

const VB_W = 1000;

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const pt = (a: number): [number, number] => [
    cx + r * Math.cos(((a - 90) * Math.PI) / 180),
    cy + r * Math.sin(((a - 90) * Math.PI) / 180),
  ];
  const [x0, y0] = pt(a0);
  const [x1, y1] = pt(a1);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

/** 堆叠面积：返回每层的闭合路径（层间留 1 单位缝，避免糊成一坨） */
function stackAreas(values: number[][], max: number, h: number): string[] {
  /**
   * 只取各条序列的**最短**长度，且逐点 ?? 0 兜底。
   *
   * 这是 2026-09-01 那个「图上有黑色缺口」的回归护栏：原来取 values[0].length，
   * 短的那条读到 undefined，cum 累加成 NaN，SVG 路径带 NaN 坐标就整段不画。
   * 对齐本该由服务端保证（共享时间轴 + null 填缺），这里是第二道闸——
   * 万一哪天上游又回到不等长，宁可少画右边一小截，也不能吐出 NaN 路径。
   */
  const n = values.length === 0 ? 0 : Math.min(...values.map((row) => row.length));
  if (n < 2 || max <= 0) return values.map(() => '');
  const x = (i: number): number => (i / (n - 1)) * VB_W;
  const y = (v: number): number => h - Math.min(1, v / max) * h;
  const cum = new Array<number>(n).fill(0);
  const last = values.length - 1;
  return values.map((row, band) => {
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const yBottom = y(cum[i]);
      bottom.unshift(`${x(i).toFixed(1)},${yBottom.toFixed(1)}`);
      cum[i] += row[i] ?? 0;
      // 表面色的缝：把这一段的上沿压下去 2px，让它和上面那段之间露出底色。
      // 最上面那段没有邻居，压下去只会凭空削掉总量，所以不压。
      // 段本身比缝还薄时钳到下沿，宁可这一段不可见，也不要画出翻转的路径。
      const yTop = band === last ? y(cum[i]) : Math.min(yBottom, y(cum[i]) + STACK_GAP);
      top.push(`${x(i).toFixed(1)},${yTop.toFixed(1)}`);
    }
    return `M${top.join(' L')} L${bottom.join(' L')} Z`;
  });
}

function areaPath(vals: number[], max: number, h: number): string {
  if (vals.length < 2 || max <= 0) return '';
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * VB_W).toFixed(1)},${(h - Math.min(1, v / max) * h).toFixed(1)}`);
  return `M${pts.join(' L')} L${VB_W},${h} L0,${h} Z`;
}

export function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function formatUptime(fromIso: string, now: number): string {
  const ms = now - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时 ${mins % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

// ── 分段健康环 ────────────────────────────────────────────────────────────

function HealthRing({ states }: { states: Array<'ok' | 'bad' | 'idle'> }): JSX.Element {
  const size = 132;
  const c = size / 2;
  const r = 50;
  const sw = 12;
  const span = 260;
  const gap = states.length > 1 ? 5 : 0;
  const seg = (span - gap * (states.length - 1)) / Math.max(1, states.length);
  const okCount = states.filter((s) => s === 'ok').length;
  const allOk = states.length > 0 && okCount === states.length;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <path
          d={arcPath(c, c, r, -130, 130)}
          fill="none"
          style={{ stroke: 'hsl(var(--surface-sunken))' }}
          strokeWidth={sw}
          strokeLinecap="round"
        />
        {states.map((s, i) => {
          const a0 = -130 + i * (seg + gap);
          return (
            <path
              key={`${s}-${i.toString()}`}
              d={arcPath(c, c, r, a0, a0 + seg)}
              fill="none"
              style={{ stroke: s === 'ok' ? 'hsl(var(--ok))' : s === 'bad' ? 'hsl(var(--bad))' : 'hsl(var(--hairline-strong))' }}
              strokeWidth={sw}
              strokeLinecap="round"
            />
          );
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
        <span className={`font-mono text-3xl font-bold leading-none tracking-tight ${allOk ? 'text-foreground' : 'text-bad'}`}>
          {okCount}
          <span className="text-lg text-muted-foreground">/{states.length}</span>
        </span>
        <span className="text-[11px] text-muted-foreground">服务就绪</span>
      </div>
    </div>
  );
}

/**
 * 出图前的骨架，不是空盒子。
 *
 * 真人验收问「第一屏是不是空白」——原先这里是一个虚线空框写「正在读取指标历史…」，
 * 那就是空白等待（CLAUDE.md §6：静止反馈超过 2 秒即缺陷）。
 * artifact-is-experience 要的是「产物形状的骨架」而不是通用 spinner：所以这里画的是
 * 一张真图的骨架——同样的外壳、同样的坐标轴、一条呼吸着的占位色带——外加一句
 * **诚实的**进度（已经攒了几帧、还要等多久），不编造百分比。
 */
function MetricsSkeleton({
  filled, cadenceSeconds, windowLabel, note,
}: { filled: number; cadenceSeconds: number; windowLabel: string; note?: string }): JSX.Element {
  const need = Math.max(0, 2 - filled);
  const eta = need > 0 ? `约还需 ${need * cadenceSeconds} 秒出现曲线` : '正在读取';
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 pb-3 pt-3.5">
      <header className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h4 className="text-sm font-bold text-foreground">CPU 占用</h4>
        <span className="text-[11px] text-muted-foreground">% · 按服务堆叠 · {windowLabel}</span>
        <div className="flex-1" />
        <span className="text-[11px] text-muted-foreground">
          {note ?? `采样器每 ${cadenceSeconds} 秒写一帧 · 已有 ${filled} 帧 · ${eta}`}
        </span>
      </header>
      <div className="flex gap-2">
        <div className="flex w-12 shrink-0 flex-col justify-between text-right font-mono text-[10px] leading-none text-muted-foreground/50" style={{ height: 176 }}>
          {['', '', '', ''].map((_, i) => <span key={i}>—</span>)}
        </div>
        <div className="relative min-w-0 flex-1 overflow-hidden rounded" style={{ height: 176 }}>
          <div className="absolute inset-0 flex flex-col justify-between" aria-hidden>
            {[0, 1, 2, 3].map((i) => <span key={i} className="h-px w-full bg-[hsl(var(--hairline))]" />)}
          </div>
          {/* 呼吸着的占位色带：形状就是将要出现的那张堆叠图，不是转圈 */}
          <div
            className="absolute inset-x-0 bottom-0 animate-pulse rounded-t"
            style={{
              height: '38%',
              background: `linear-gradient(180deg, hsl(var(--series-4) / 0.16), hsl(var(--series-1) / 0.16))`,
            }}
            aria-hidden
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-[hsl(var(--hairline))] pt-2.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className="flex gap-2">
            <span className="w-[3px] rounded-full bg-[hsl(var(--hairline-strong))]" aria-hidden />
            <span className="flex flex-col gap-1">
              <span className="h-2 w-24 animate-pulse rounded bg-[hsl(var(--hairline-strong))]" />
              <span className="h-3.5 w-12 animate-pulse rounded bg-[hsl(var(--hairline-strong))]" />
            </span>
          </span>
        ))}
      </div>
    </section>
  );
}

// ── 图表外壳（标题 / 大数 / 图例 / 脚注）────────────────────────────────

function ChartShell({
  title, unit, headline, headlineSuffix, aside, children, legend, footnote,
}: {
  title: string;
  unit: string;
  headline?: string;
  headlineSuffix?: string;
  aside?: JSX.Element;
  children: JSX.Element;
  legend?: JSX.Element;
  footnote?: string;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 pb-3 pt-3.5">
      <header className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h4 className="text-sm font-bold text-foreground">{title}</h4>
        <span className="text-[11px] text-muted-foreground">{unit}</span>
        <div className="flex-1" />
        {aside}
        {headline ? (
          <>
            <span className="font-mono text-lg font-bold tracking-tight text-foreground">{headline}</span>
            <span className="text-[11px] text-muted-foreground">{headlineSuffix}</span>
          </>
        ) : null}
      </header>
      {children}
      {legend}
      {footnote ? (
        <p className="border-t border-[hsl(var(--hairline))] pt-2 text-[11px] leading-[18px] text-muted-foreground">{footnote}</p>
      ) : null}
    </section>
  );
}

/**
 * 坐标轴与刻度走 HTML、只有面积走 SVG。
 * 抽屉宽度是可变的，整张图塞进一个 preserveAspectRatio="none" 的 SVG 会把文字拉变形；
 * 分开之后文字始终按浏览器字号渲染，面积随宽度自由拉伸。
 */
function PlotFrame({
  height, yTicks, xLabels, children,
}: {
  height: number;
  yTicks: string[];
  xLabels: string[];
  children: JSX.Element;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div
          className="flex w-12 shrink-0 flex-col justify-between whitespace-nowrap text-right font-mono text-[10px] leading-none text-muted-foreground"
          style={{ height }}
        >
          {yTicks.map((label) => <span key={label}>{label}</span>)}
        </div>
        <div className="relative min-w-0 flex-1" style={{ height }}>
          <div className="absolute inset-0 flex flex-col justify-between" aria-hidden>
            {yTicks.map((label) => (
              <span key={label} className="h-px w-full bg-[hsl(var(--hairline))]" />
            ))}
          </div>
          {children}
        </div>
      </div>
      <div className="flex justify-between pl-14 font-mono text-[10px] text-muted-foreground">
        {xLabels.map((label) => <span key={label}>{label}</span>)}
      </div>
    </div>
  );
}

// ── 堆叠面积图 + 彩色图例 ────────────────────────────────────────────────

interface StackedSeries {
  id: string;
  color: string;
  /** 桶序列，**只用来画几何**。末值是数十秒的平均，不能当「当前值」。 */
  values: number[];
  /**
   * 当前值：有实时快照就用它，否则退回桶末值。
   *
   * 合计、构成条宽度、图例数字必须全部走这一个字段。此前图例走实时、合计走
   * 桶末值，同一屏上大数比它旁边的每服务数字慢 30-70 秒（Codex P2，核对属实）
   * ——这是把图与数字劈成两个源之后，聚合那一侧没跟上。
   */
  nowValue: number;
  nowLabel: string;
  nowUnit: string;
  /** 容器已经不在跑了。序列尾巴停在它停机那一刻，末值是**停机前的旧读数**，不能当现值显示。 */
  stopped?: boolean;
}

/**
 * 数值插值：新数据到来时，把每条序列从旧值补间到新值，而不是一帧切过去。
 *
 * 为什么需要：改成「按桶推进」之后，图不再每 5 秒抖一下，但新桶落成的那一下
 * 仍是整条曲线瞬移。miduo-review-lens 镜头 4（变化可感知）要的是「让人看见什么变了」，
 * 一帧切过去等于没看见。
 *
 * 只在**形状不变**时补间（序列条数、id、点数都一致）。服务上线下线、窗口分辨率
 * 重算都会改变形状，那种情况下逐点插值是在两组不同含义的数之间连线，宁可直接切。
 * 尊重 prefers-reduced-motion。
 */
function useTweenedSeries(series: StackedSeries[], token: object, ms = 420): StackedSeries[] {
  const [shown, setShown] = useState(series);
  const fromRef = useRef(series);
  const latestRef = useRef(series);
  latestRef.current = series;

  useEffect(() => {
    const to = latestRef.current;
    const from = fromRef.current;
    const sameShape =
      from.length === to.length &&
      from.every((f, i) => f.id === to[i].id && f.values.length === to[i].values.length);
    const reduced = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!sameShape || reduced) {
      fromRef.current = to;
      setShown(to);
      return undefined;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number): void => {
      const k = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - k) ** 3; // easeOutCubic
      setShown(to.map((sr, i) => ({
        ...sr,
        values: sr.values.map((v, j) => {
          const a = from[i].values[j] ?? v;
          return a + (v - a) * e;
        }),
      })));
      if (k < 1) raf = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [token, ms]);

  return shown;
}

function StackedAreaChart({
  height, max, series, token,
}: { height: number; max: number; series: StackedSeries[]; token: object }): JSX.Element {
  const tweened = useTweenedSeries(series, token);
  const paths = useMemo(
    () => stackAreas(tweened.map((s) => s.values), max, height),
    [tweened, max, height],
  );
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox={`0 0 ${VB_W} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {paths.map((d, i) => (
        d ? <path key={tweened[i].id} d={d} style={{ fill: tweened[i].color }} fillOpacity={0.8} /> : null
      ))}
    </svg>
  );
}

/**
 * 构成条：一根横向堆叠条 + 一张能读全名的清单。
 *
 * 2026-09-02 真人验收：内存那张时间序列面积图「太丑」。回看数据才发现问题不在配色——
 * 内存本来就几乎不随时间变，画成 30 分钟面积图就是四条水平直线，白占半屏，
 * 而全部信息（谁占多少）图例里那几个数字早就说完了。
 *
 * dataviz 的形式表：这份数据的 job 是 part-to-whole，默认形式是 **stacked bar**，
 * 而且「go horizontal for many / long-named categories」——服务名又多又长，正是这一档。
 * 名字写全不截断，也顺带治了「图例挤成碎屑」。
 */
function CompositionBar({ series }: { series: StackedSeries[] }): JSX.Element {
  // 条宽与清单数字同走 nowValue，别让条按旧桶画、数字按实时写。
  const total = series.reduce((n, x) => n + (x.stopped ? 0 : x.nowValue), 0);
  const rows = series.map((x) => ({ ...x, value: x.stopped ? 0 : x.nowValue }));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full" role="img" aria-label="内存占用构成">
        {rows.map((r) => (
          <span
            key={r.id}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              // 分隔靠 flex 的 2px 缝（表面色），不给每段描边。
              flex: total > 0 ? `${Math.max(r.value / total, 0.004)} 0 0` : '1 0 0',
              background: r.color,
              opacity: 0.85,
            }}
          />
        ))}
      </div>
      <ul className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.id} className="flex items-baseline gap-2">
            <span className="mt-[3px] h-2 w-2 shrink-0 self-start rounded-[2px]" style={{ background: r.color }} aria-hidden />
            <span className="min-w-0 flex-1 break-all font-mono text-[11px] leading-[15px] text-muted-foreground">{r.id}</span>
            {r.stopped ? (
              <span className="shrink-0 font-mono text-[12px] font-bold text-bad">停止</span>
            ) : (
              <span className="shrink-0 font-mono text-[13px] font-bold tabular-nums text-foreground">
                {r.nowLabel}<span className="text-[10px] font-medium text-muted-foreground">{r.nowUnit}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SeriesLegend({ series }: { series: StackedSeries[] }): JSX.Element {
  return (
    /*
     * 等宽 N 列会把长服务名一律截断成「cloudbridge-...」，六个一排就是一行碎屑。
     * 改成按内容换行的 chip 行：名字写得下就写全，写不下才换行，宽度自己找位置。
     */
    <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-[hsl(var(--hairline))] pt-2.5">
      {series.map((s) => (
        <div key={s.id} className="flex min-w-0 max-w-full gap-2">
          <span className="w-[3px] shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
          <span className="flex min-w-0 flex-col gap-px">
            <span className="truncate font-mono text-[10.5px] text-muted-foreground" title={s.id}>{s.id}</span>
            {s.stopped ? (
              // 停掉的容器不许显示末值：那是它停机前的读数，摆在「当前值」位置上等于说它还活着。
              <span className="font-mono text-base font-bold leading-tight tracking-tight text-bad">停止</span>
            ) : (
              <span className="font-mono text-base font-bold leading-tight tracking-tight text-foreground">
                {s.nowLabel}
                <span className="text-[11px] font-medium text-muted-foreground">{s.nowUnit}</span>
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── 网络双向面积图 ────────────────────────────────────────────────────────

/**
 * 网络吞吐：收在上、发在下，共用一根基线。
 *
 * 配色是**同一个色相的两档**，不是两个不同的颜色：收 / 发 的主编码是基线上下的位置，
 * 颜色只是辅助，用两种色相反而暗示「两个不相干的实体」。
 * 色相取 --series-net 单独一档，不复用具名服务那五色（同屏里「蓝色 = cloudbridge-web」
 * 和「蓝色 = 入站」会打架），也不用语义四色——那四档保留给状态。
 *
 * 此前这里用的是 --info 和 --primary，正好违反本面板自己声明的不变量
 * （语义四色状态专用、不参与系列配色）。
 */
const NET_COLOR = 'hsl(var(--series-net))';

/** 一条「上下镜像」的双向图：正向在上、反向在下，共用一根基线与一把标尺。 */
function MirroredPair({
  up, down, label, upName, downName, height = 46,
}: { up: number[]; down: number[]; label: string; upName: string; downName: string; height?: number }): JSX.Element {
  const peak = Math.max(1, ...up, ...down);
  const max = peak * 1.12;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-semibold text-foreground">{label}</span>
        <span className="font-mono text-[10px] text-muted-foreground">峰值 {formatBytesShort(peak)}/s</span>
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-muted-foreground">
          {upName} {formatBytesShort(up.at(-1) ?? 0)}/s · {downName} {formatBytesShort(down.at(-1) ?? 0)}/s
        </span>
      </div>
      <div className="relative" style={{ height: height * 2 + 2 }}>
        <svg className="absolute inset-x-0 top-0 w-full" height={height} viewBox={`0 0 ${VB_W} ${height}`} preserveAspectRatio="none" aria-hidden>
          <path d={areaPath(up, max, height)} style={{ fill: NET_COLOR }} fillOpacity={0.85} />
        </svg>
        <span className="absolute inset-x-0 h-px bg-[hsl(var(--hairline-strong))]" style={{ top: height }} aria-hidden />
        <svg
          className="absolute inset-x-0 w-full"
          style={{ top: height + 2, transform: 'scaleY(-1)' }}
          height={height}
          viewBox={`0 0 ${VB_W} ${height}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          <path d={areaPath(down, max, height)} style={{ fill: NET_COLOR }} fillOpacity={0.4} />
        </svg>
      </div>
    </div>
  );
}

/**
 * 吞吐：网络与磁盘各一行，共一张卡。
 *
 * 磁盘 I/O 是 2026-09-02 补上的——`docker stats` 一直在返回 BlockIO、`ContainerStats`
 * 一直在解析它，只有历史存储没收，白丢了一整维。核对过它在本宿主机上不是常年 0
 * （cgroup v2 的 io.stat 实测 rbytes=7360512 wbytes=1200128），不是又一个「常年显示
 * 0 的方块」。
 *
 * 刻意**不新增卡片**：真人刚反馈过「页面非常乱」，多一张卡就是多一块要扫的区域。
 * 两者本来就是同一个问题的两半——「这个分支在往外倒多少数据」。
 */
function ThroughputChart({
  rx, tx, read, write,
}: { rx: number[]; tx: number[]; read: number[]; write: number[] }): JSX.Element {
  const hasDisk = read.some((v) => v > 0) || write.some((v) => v > 0);
  return (
    <ChartShell
      title="吞吐"
      unit="网络 · 磁盘"
      headline={`${formatBytesShort(rx.at(-1) ?? 0)}/s`}
      headlineSuffix="网络入站"
      footnote={hasDisk ? undefined : '磁盘一行全为 0：可能是宿主内核没开块设备计量，或这些容器确实没落盘。'}
    >
      <div className="flex flex-col gap-3">
        <MirroredPair up={rx} down={tx} label="网络" upName="收" downName="发" />
        <MirroredPair up={read} down={write} label="磁盘" upName="读" downName="写" />
      </div>
    </ChartShell>
  );
}

// ── 部署耗时柱状图 ────────────────────────────────────────────────────────

function DeployHistoryChart({
  items, onOpenDeployments,
}: { items: OverviewDeployment[]; onOpenDeployments?: () => void }): JSX.Element | null {
  const bars = useMemo(() => items
    .filter((d) => d.finishedAt && d.finishedAt > d.startedAt)
    .slice(0, 20)
    .reverse()
    .map((d) => ({ key: d.key, ms: (d.finishedAt as number) - d.startedAt, failed: d.status === 'error', sha: d.commitSha })),
  [items]);
  if (bars.length < 3) return null;

  const max = Math.max(...bars.map((b) => b.ms)) * 1.15;
  const sorted = [...bars].map((b) => b.ms).sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const failedCount = bars.filter((b) => b.failed).length;
  const H = 88;
  const medianTop = H - (median / max) * H;

  // 「在变慢」只在样本够多、且差异超过 10% 时才说，否则是噪音当趋势。
  const half = Math.floor(bars.length / 2);
  const early = bars.slice(0, half).reduce((a, b) => a + b.ms, 0) / Math.max(1, half);
  const late = bars.slice(-half).reduce((a, b) => a + b.ms, 0) / Math.max(1, half);
  const drift = late - early;
  const trend = bars.length >= 6 && Math.abs(drift) > early * 0.1
    ? `${drift > 0 ? '耗时在上移' : '耗时在下降'}：后半程平均${drift > 0 ? '多' : '少'} ${formatDuration(Math.abs(drift))}`
    : null;

  return (
    <ChartShell
      title="部署历史"
      unit={`最近 ${bars.length} 次 · 柱高 = 构建耗时 · 虚线为中位`}
      aside={trend ? <span className="text-xs font-semibold text-warn">{trend}</span> : undefined}
    >
      <>
        <div className="relative" style={{ height: H }}>
          <span
            className="absolute inset-x-0 border-t border-dashed border-warn"
            style={{ top: medianTop }}
            aria-hidden
          />
          <span
            className="absolute left-0 bg-[hsl(var(--surface-raised))] px-1 font-mono text-[10px] text-warn"
            style={{ top: Math.max(0, medianTop - 15) }}
          >
            中位 {formatDuration(median)}
          </span>
          <div className="flex h-full items-end gap-1">
            {bars.map((b, i) => (
              <span
                key={b.key}
                title={`${b.sha ? `${b.sha.slice(0, 7)} · ` : ''}${formatDuration(b.ms)}${b.failed ? ' · 失败' : ''}`}
                className={`min-w-0 flex-1 rounded-sm ${b.failed ? 'bg-bad' : 'bg-ok'} ${b.failed || i === bars.length - 1 ? '' : 'opacity-50'}`}
                style={{ height: `${Math.max(3, (b.ms / max) * 100)}%` }}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t border-[hsl(var(--hairline))] pt-2.5">
          <span className="flex flex-col gap-px">
            <span className="text-[10.5px] text-muted-foreground">最新一次</span>
            <span className="font-mono text-[15px] font-bold text-foreground">{formatDuration(bars[bars.length - 1].ms)}</span>
          </span>
          <span className="h-6 w-px bg-[hsl(var(--hairline))]" aria-hidden />
          <span className="flex flex-col gap-px">
            <span className="text-[10.5px] text-muted-foreground">成功率</span>
            <span className={`font-mono text-[15px] font-bold ${failedCount ? 'text-warn' : 'text-ok'}`}>
              {bars.length - failedCount} / {bars.length}
            </span>
          </span>
          <div className="flex-1" />
          {onOpenDeployments ? (
            <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={onOpenDeployments}>
              去「部署」看全部 →
            </button>
          ) : null}
        </div>
      </>
    </ChartShell>
  );
}

// ── 入口卡 ────────────────────────────────────────────────────────────────

function EntryCard({ e, reachable }: { e: OverviewEntry; reachable: boolean }): JSX.Element {
  const hero = Boolean(e.primary);
  const lit = hero && reachable;
  return (
    <a
      href={e.url}
      target="_blank"
      rel="noreferrer"
      title={`打开 ${e.name} — ${e.url}`}
      className={`group flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors ${
        lit
          ? 'border-ok/40 bg-ok-soft hover:border-ok/70'
          : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] hover:border-[hsl(var(--hairline-strong))]'
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${
          lit ? 'bg-ok text-status-ink' : 'bg-[hsl(var(--surface-sunken))] text-muted-foreground'
        }`}
      >
        {hero ? <Rocket className="h-[18px] w-[18px]" /> : <Server className="h-4 w-4" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="text-[13px] font-bold text-foreground">{e.name}</span>
          {hero ? (
            <span className={`rounded px-1.5 py-px text-[10px] font-bold ${reachable ? 'bg-ok/15 text-ok' : 'bg-[hsl(var(--surface-sunken))] text-muted-foreground'}`}>默认入口</span>
          ) : null}
          {e.subdomain ? (
            <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-px font-mono text-[10px] text-muted-foreground">
              {e.subdomain}
            </span>
          ) : null}
        </span>
        <span className="truncate font-mono text-[11.5px] text-muted-foreground">{e.url}</span>
      </span>
      <ExternalLink className={`h-4 w-4 shrink-0 ${lit ? 'text-ok' : 'text-muted-foreground group-hover:text-foreground'}`} />
    </a>
  );
}

function EntryCards({
  entries, reachable, onConfigure,
}: { entries: OverviewEntry[]; reachable: boolean; onConfigure?: () => void }): JSX.Element {
  const primary = entries.find((e) => e.primary);
  const rest = entries.filter((e) => e !== primary);
  return (
    <section className="flex flex-col gap-2.5">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-sm font-bold text-foreground">入口</h4>
        <span className="text-xs text-muted-foreground">
          {entries.length} 个{reachable ? ' · 服务已就绪' : ' · 服务未就绪，暂不可达'}
        </span>
        <div className="flex-1" />
        {onConfigure ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={onConfigure}
            title="手动配置入口（新增子域入口 / 改名 / 改落地路径）"
          >
            <Settings className="h-3.5 w-3.5" />
            配置入口
          </button>
        ) : null}
      </header>
      {/*
        主入口独占一行，且**不放进下面那个网格**。
        它曾经是网格里一个 grid-column: 1 / -1 的项——那样每条轨道都被它占着，
        没有一条是空的，auto-fit 便不折叠空轨道，于是 3 个次要入口挤在左边、
        右侧空出一整列。拿出来之后，网格里只剩次要入口，列数才真的按数量自适应。
      */}
      {primary ? <EntryCard e={primary} reachable={reachable} /> : null}
      {rest.length > 0 ? (
        <div
          className="grid gap-2.5"
          style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 300px), 1fr))` }}
        >
          {rest.map((e) => <EntryCard key={e.url} e={e} reachable={reachable} />)}
        </div>
      ) : null}
    </section>
  );
}

// ── 面板本体 ──────────────────────────────────────────────────────────────

export function OverviewPanel({
  services, running, branchName, commitSha, commitMessage,
  lastReadyAt, lastDeployAt, deployDurationMs,
  entries, deployments, metricSeries, liveStats, metricsReady, metricsError, seriesError,
  replicaSummary, infraSummary,
  now, windowMinutes, onRefreshMetrics, onConfigureEntries, onOpenDeployments,
}: {
  services: OverviewService[];
  running: boolean;
  branchName: string;
  commitSha?: string;
  commitMessage?: string;
  lastReadyAt?: string;
  lastDeployAt?: string;
  deployDurationMs?: number;
  entries: OverviewEntry[];
  deployments: OverviewDeployment[];
  metricSeries: Record<string, MetricSeries>;
  /**
   * 实时快照（5s 轮询的 docker stats）。
   *
   * 图走服务端分桶的 series，数字走这里——两个口径分开。序列的最后一个桶是
   * 数十秒的平均值，摆在「当前值」的位置上会比真实情况慢一拍。
   */
  liveStats?: Record<string, { cpuPercent: number; memUsedBytes: number }>;
  metricsReady: boolean;
  /** 历史端点自己的失败。与 metricsError（实时快照失败）是两个独立的错误面。 */
  seriesError?: string;
  metricsError?: string;
  replicaSummary: string;
  infraSummary: string;
  now: number;
  /** 图表窗口长度（分钟）。由服务端 series 端点的 after/before 决定，前端不猜。 */
  windowMinutes: number;
  onRefreshMetrics: () => void;
  onConfigureEntries?: () => void;
  onOpenDeployments?: () => void;
}): JSX.Element {
  const okCount = services.filter((s) => s.status === 'running').length;
  const badServices = services.filter((s) => s.status === 'error');
  const ringStates = services.map((s): 'ok' | 'bad' | 'idle' => (
    s.status === 'running' ? 'ok' : s.status === 'error' ? 'bad' : 'idle'
  ));

  /**
   * 系列选取与赋色一律走 **服务名字典序**，不按当前用量排名。
   *
   * 这条不是洁癖：指标每 5s 刷一次，按瞬时 CPU 排名的话，两个服务用量一接近，
   * 颜色、图例列序、堆叠层序就会跟着名次来回换——同一个服务这一秒是橙色、
   * 下一秒变蓝色，图看起来一直在抖，也没法拿颜色认服务。
   * dataviz 的硬约束原话是「颜色跟实体走，不跟名次走」。
   *
   * 代价是超过 5 个服务时，第 6 个之后按字典序被并进「其他」，哪怕它很忙。
   * 想单看它去「资源」页签——总览这一屏保证颜色不会变。
   */
  const picked = useMemo(() => {
    const withSeries = services
      .map((s) => ({ svc: s, ring: metricSeries[s.profileId] }))
      /*
       * 每条序列按**自己的真样本数**入选，不看数组长度（Codex P2，核对属实）。
       *
       * 数组长度是服务端对齐后的桶数，所有容器都一样长；一个刚起来的服务只有 1 个
       * 真样本、其余全是 null，靠长度判就会把它放进图里，而 null 在几何里被映射成 0
       * ——画出来是一个虚构的三角尖峰。这和之前那次「整屏一个大三角」是同一个病，
       * 只是降到了单条序列的粒度：**数桶，不数数据**。
       *
       * 代价：新起的服务要攒够两帧（约 90 秒）才进图。比画一根假尖峰诚实。
       */
      .filter((x): x is { svc: OverviewService; ring: MetricSeries } => Boolean(x.ring) && (x.ring.filled ?? 0) >= 2)
      .sort((a, b) => a.svc.profileId.localeCompare(b.svc.profileId));
    return { head: withSeries.slice(0, SERIES_SLOTS), tail: withSeries.slice(SERIES_SLOTS) };
  }, [services, metricSeries]);

  const sampleCount = picked.head[0]?.ring.cpu.length ?? 0;
  /** 真有样本的桶数（null 被映射成 0 之前数的）。骨架屏靠它如实说「已经攒了几帧」。 */
  const filledSamples = Math.max(0, ...Object.values(metricSeries).map((m) => m.filled ?? 0));
  /**
   * 够不够画一张图，看的是**真有数据的桶数**，不是数组长度。
   *
   * 2026-09-02 渲染取证时抓到的缺陷：冷启动只有 1 个真样本、轴上却有 2 个桶（另一个是
   * null），`sampleCount >= 2` 判真，于是画出一个从左上斜到零的大三角——那条下降沿
   * 是 null 被映射成 0 画出来的，纯属虚构。
   *
   * 这和「空桶画成 0」是同一个病根：**数桶，不数数据**。判据必须落在 filled 上。
   */
  const hasPlot = picked.head.length > 0 && filledSamples >= 2;

  const buildSeries = (
    read: (m: MetricSeries) => number[],
    readLive: (s: { cpuPercent: number; memUsedBytes: number }) => number,
    label: (v: number) => [string, string],
  ): StackedSeries[] => {
    const head = picked.head.map((x, i) => {
      const values = read(x.ring);
      const live = liveStats?.[x.svc.profileId];
      const nowValue = live ? readLive(live) : values.at(-1) ?? 0;
      const [nowLabel, nowUnit] = label(nowValue);
      return {
        id: x.svc.profileId,
        color: seriesColor(i),
        values,
        nowValue,
        nowLabel,
        nowUnit,
        stopped: x.svc.status !== 'running',
      };
    });
    if (picked.tail.length === 0) return head;
    const len = head[0]?.values.length ?? 0;
    const merged = Array.from({ length: len }, (_, i) => picked.tail.reduce((sum, x) => sum + (read(x.ring)[i] ?? 0), 0));
    /*
     * 尾部聚合的**当前值只算还在跑的**（Codex P2，核对属实）。
     *
     * 「其他 N 个」是多个服务的合并项，没法带一个 stopped 标记，所以后面那道
     * `s.stopped ? 0 : s.nowValue` 的过滤够不着它 —— 于是一个已停容器停机前的
     * 旧读数会一直算进「其他」和顶部合计，谎称它还在吃资源。
     *
     * 历史那一条（merged）照旧包含所有尾部服务：它画的是过去，过去它确实在跑。
     * 当前值与历史几何本来就是两个口径，这里正是它们该分开的地方。
     */
    const tailNow = picked.tail.reduce((sum, x) => {
      if (x.svc.status !== 'running') return sum;
      const live = liveStats?.[x.svc.profileId];
      return sum + (live ? readLive(live) : read(x.ring).at(-1) ?? 0);
    }, 0);
    const [nowLabel, nowUnit] = label(tailNow);
    return [...head, { id: `其他 ${picked.tail.length} 个`, color: OTHER_COLOR, values: merged, nowValue: tailNow, nowLabel, nowUnit }];
  };

  const cpuSeries = hasPlot ? buildSeries((m) => m.cpu, (l) => l.cpuPercent, (v) => [v.toFixed(2), '%']) : [];
  const memSeries = hasPlot ? buildSeries((m) => m.memBytes, (l) => l.memUsedBytes, (v) => {
    const parts = formatBytesShort(v).split(' ');
    return [parts[0], ` ${parts[1] ?? ''}`];
  }) : [];

  // 合计只算还在跑的：把停机前的旧读数加进「当前合计」会虚报占用。
  // 合计走 nowValue（实时优先），与旁边每服务的数字同一个口径。
  const cpuTotalNow = cpuSeries.reduce((n, s) => n + (s.stopped ? 0 : s.nowValue), 0);
  const memTotalNow = memSeries.reduce((n, s) => n + (s.stopped ? 0 : s.nowValue), 0);
  // 上限不再乘一个 1.12 的余量：余量会让刻度落在 13 / 9 / 4 这种不整的数上。
  // 改成把峰值交给 niceScale 吸附到整数步长，吸附本身就自带头部空间。
  const cpuPeak = Math.max(2, ...Array.from({ length: sampleCount }, (_, i) => cpuSeries.reduce((n, s) => n + (s.values[i] ?? 0), 0)));

  const sumOf = (read: (m: MetricSeries) => number[]): number[] =>
    Array.from({ length: sampleCount }, (_, i) => picked.head.concat(picked.tail).reduce((n, x) => n + (read(x.ring)[i] ?? 0), 0));
  const netRx = sumOf((m) => m.rxRate);
  const netTx = sumOf((m) => m.txRate);
  const diskRead = sumOf((m) => m.readRate);
  const diskWrite = sumOf((m) => m.writeRate);

  // 判断句：先给结论，再给证据。
  const verdict = badServices.length > 0
    ? `有 ${badServices.length} 个服务异常，${entries.length > 0 ? '入口可能打不开' : '分支未就绪'}`
    : running && okCount === services.length && services.length > 0
      ? '一切正常，可以直接验收'
      : running
        ? `还有 ${services.length - okCount} 个服务没起来`
        : '分支未运行';
  const verdictTone = badServices.length > 0 ? 'bad' : running && okCount === services.length && services.length > 0 ? 'ok' : 'idle';

  const windowText = windowMinutes >= 60
    ? `近 ${(windowMinutes / 60).toFixed(windowMinutes % 60 === 0 ? 0 : 1)} 小时`
    : `近 ${Math.max(1, Math.round(windowMinutes))} 分钟`;
  const windowLabel = `服务端聚合 · ${windowText}`;
  /**
   * 刻度取整。
   *
   * 原来是把上限直接乘 0.66 / 0.33 打出来，于是刻度长这样：13 / 9 / 4 / 0——
   * 因为上限本身是「实际峰值 × 1.12」这么一个不整的数。dataviz 的要求是
   * 「Y-axis ticks: round to clean numbers」：先把步长吸附到 1 / 2 / 2.5 / 5 / 10
   * 这一档的整数上，再由步长决定上限，图和刻度就都落在整数上。
   *
   * 返回 [上限, …, 0]（从上往下），并把吸附后的上限一并给出去，让面积图用同一个
   * 上限——不然刻度线和面积会对不齐。
   */
  const niceScale = (rawMax: number, ticks = 4): { max: number; steps: number[]; labels: string[] } => {
    if (!Number.isFinite(rawMax) || rawMax <= 0) return { max: 1, steps: [1, 0], labels: ['1', '0'] };
    const rough = rawMax / (ticks - 1);
    const mag = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= rough) ?? 10 * mag;
    const top = step * (ticks - 1);
    const steps = Array.from({ length: ticks }, (_, i) => top - i * step);
    // 小数位由**步长**定一次，整条轴统一。逐个值判断会打出 15 / 10 / 5.0 / 0.0 这种混排。
    const digits = step >= 1 ? 0 : Math.min(2, Math.ceil(-Math.log10(step)));
    return { max: top, steps, labels: steps.map((v) => v.toFixed(digits)) };
  };

  const cpuScale = niceScale(cpuPeak);

  /*
   * 补间的触发信号。
   *
   * cpuSeries 每次渲染都是新数组（里面还混着每 5 秒变一次的 liveStats 数字），
   * 直接拿它当 effect 依赖会每帧重启动画。图上的**数值**只在 metricSeries 变化时
   * 才变，所以用一个「只随 metricSeries 换新」的空对象当令牌。
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dataToken = useMemo(() => ({}), [metricSeries]);

  return (
    <div className="flex flex-col gap-4">
      {/* 1. 判断行 —— 一句带数字的结论 + 稳定运行时长 */}
      <section className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-5 py-4">
        <HealthRing states={ringStates} />
        <div className="flex min-w-[16rem] flex-1 flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${verdictTone === 'ok' ? 'bg-ok' : verdictTone === 'bad' ? 'bg-bad' : 'bg-muted-foreground'}`}
              aria-hidden
            />
            <h3 className="text-xl font-extrabold tracking-tight text-foreground">{verdict}</h3>
          </div>
          <p className="text-sm leading-6 text-foreground-muted">
            {services.length > 0 ? `${okCount} / ${services.length} 个服务就绪` : '尚未配置服务'}
            {entries.length > 0 ? <>，<strong className="font-bold text-foreground">{entries.length} 个入口</strong></> : null}
            {hasPlot ? `，CPU 合计 ${cpuTotalNow.toFixed(1)}%、内存 ${formatBytesShort(memTotalNow)}` : ''}
            {badServices.length > 0 ? `。异常服务：${badServices.map((s) => s.profileId).join('、')}` : '。'}
          </p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-muted-foreground">
            {commitSha ? (
              <>
                <span>当前版本</span>
                <span className="rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-1.5 py-px font-mono text-foreground-muted">
                  {commitSha.slice(0, 7)}
                </span>
              </>
            ) : null}
            {commitMessage ? <span className="max-w-[28rem] truncate text-foreground-muted" title={commitMessage}>{commitMessage}</span> : null}
            {lastDeployAt ? <><span aria-hidden>·</span><span>{formatUptime(lastDeployAt, now)}前部署</span></> : null}
            {deployDurationMs ? <><span aria-hidden>·</span><span>耗时 {formatDuration(deployDurationMs)}</span></> : null}
            <span aria-hidden>·</span>
            <span className="font-mono">{branchName}</span>
          </div>
        </div>
        {lastReadyAt && running ? (
          <div className="flex flex-col items-end gap-1 border-l border-[hsl(var(--hairline))] pl-6">
            <span className="text-[10px] font-bold uppercase tracking-[0.09em] text-muted-foreground">已运行</span>
            <span className="font-mono text-[26px] font-bold leading-none tracking-tight text-foreground">
              {formatUptime(lastReadyAt, now)}
            </span>
            <span className="text-[11px] text-muted-foreground">自容器就绪起算</span>
          </div>
        ) : null}
      </section>

      {/* 2. 入口 —— 大多数人打开这个抽屉就是为了拿地址 */}
      {entries.length > 0 ? (
        <EntryCards entries={entries} reachable={running && badServices.length === 0} onConfigure={onConfigureEntries} />
      ) : null}

      {/*
        3. 资源占用。

        两个数据源就有两个错误面，别互相牵连（Codex P2，核对属实）：
        - `metricsError` 是实时快照（docker stats）挂了 —— 历史图**照画**，
          只在上面加一条提示。此前它会把整段还好好的历史图一起藏掉。
        - `seriesError` 是历史端点挂了 —— 这时才没有曲线可画，但仍然把实时
          数字端出来，并且**明说曲线来不了**；此前 catch 全吞，骨架屏会永远
          承诺一条不会出现的曲线。
      */}
      {metricsError ? (
        <section className="flex items-center gap-2 rounded-xl border border-warn/30 bg-warn-soft px-4 py-2.5 text-[13px] text-warn">
          <span className="flex-1">实时采样失败：{metricsError}。下面是历史曲线，数字可能不是最新的。</span>
          <button type="button" className="inline-flex items-center gap-1.5 text-xs font-semibold hover:underline" onClick={onRefreshMetrics}>
            <RefreshCw className="h-3.5 w-3.5" />重试
          </button>
        </section>
      ) : null}
      {seriesError ? (
        /*
         * 这一条**不看 hasPlot**（Codex P2，核对属实）。
         *
         * 漏掉的是「先成功、后持续失败」那条路：`metricSeries` 还留着上一次的结果，
         * `hasPlot` 仍为真，于是两个错误分支都被 `!hasPlot` 挡掉——一条过期的曲线
         * 顶着「近 30 分钟」的标签无限期挂在那儿，一句提示都没有。
         * 有图时说「这条曲线是旧的」，没图时说「画不出来了」，两句都得说。
         */
        <section className="flex flex-col gap-2 rounded-xl border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad">
          <span>读取指标历史失败：{seriesError}</span>
          <span className="text-[12px] text-foreground-muted">
            {hasPlot
              ? '下面那条曲线是最后一次成功拉取的结果，已经不再更新——它不是当前的 30 分钟。'
              : '曲线画不出来了（不是还没攒够——这一项不会自己好）。'}
            {!hasPlot && Object.keys(liveStats ?? {}).length > 0 ? '下面仍是实时读数。' : ''}
          </span>
        </section>
      ) : null}
      {seriesError && !hasPlot && Object.keys(liveStats ?? {}).length > 0 ? (
        <section className="rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-3">
          <h4 className="mb-2 text-sm font-bold text-foreground">当前读数<span className="ml-2 text-[11px] font-normal text-muted-foreground">实时快照 · 无历史曲线</span></h4>
          <ul className="flex flex-col gap-1.5">
            {services.filter((sv) => liveStats?.[sv.profileId]).map((sv) => {
              const l = liveStats![sv.profileId];
              return (
                <li key={sv.profileId} className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-muted-foreground">{sv.profileId}</span>
                  <span className="shrink-0 font-mono text-[13px] font-bold tabular-nums text-foreground">{l.cpuPercent.toFixed(2)}<span className="text-[10px] font-medium text-muted-foreground">%</span></span>
                  <span className="w-24 shrink-0 text-right font-mono text-[13px] font-bold tabular-nums text-foreground">{formatBytesShort(l.memUsedBytes)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {seriesError && !hasPlot ? null : !hasPlot ? (
        /*
         * 闸门只看「有没有画得出来的历史」，**不看实时快照回来没有**。
         *
         * 2026-09-02 真人验收：「打开之后卡了很长时间」。原因是这里曾经写
         * `!metricsReady || !hasPlot`——metricsReady 要等 /metrics 返回，而那个接口跑
         * `docker stats --no-stream`，十个容器、超时上限 5 秒。与此同时纯内存的
         * /metrics/series 早就把整段历史返回来了，图完全画得出来，却被按住不画，
         * 干等一个只为了拿「此刻这一帧」的慢请求。
         *
         * 现在：有历史就立刻画，实时快照到了再把新点续在尾巴上。
         */
        services.length === 0 ? (
          <section className="rounded-xl border border-dashed border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-8 text-center text-sm text-muted-foreground">
            该分支还没有任何 service，先去构建配置 / 部署。
          </section>
        ) : (
          <MetricsSkeleton
            filled={filledSamples}
            cadenceSeconds={SAMPLER_CADENCE_SECONDS}
            windowLabel={windowLabel}
            /*
             * metricsReady 只用来挑文案，**不参与是否出图的判断**——那正是「拿着历史
             * 干等 docker stats」那个缺陷的成因，守卫钉着闸门里不许出现它。
             */
            note={
              !running ? '分支未运行 · 没有容器可采样'
                : !metricsReady ? '正在读取指标…'
                  : undefined
            }
          />
        )
      ) : (
        <>
          <ChartShell
            title="CPU 占用"
            unit={`% · 按服务堆叠 · ${windowLabel}`}
            headline={`${cpuTotalNow.toFixed(1)}%`}
            headlineSuffix={`${cpuSeries.length} 个服务合计`}
            aside={(
              <button type="button" className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={onRefreshMetrics}>
                <RefreshCw className="h-3 w-3" />立即刷新
              </button>
            )}
            legend={<SeriesLegend series={cpuSeries} />}
          >
            <PlotFrame
              height={176}
              yTicks={cpuScale.labels}
              xLabels={[windowText.replace('近 ', '') + '前', '现在']}
            >
              <StackedAreaChart height={176} max={cpuScale.max} series={cpuSeries} token={dataToken} />
            </PlotFrame>
          </ChartShell>

          {/* items-start：两张卡各按自身内容定高。拉伸对齐会在矮的那张里留出一大块空洞
              （网络卡的图在顶、图例在底，中间空一截），空洞比高度不齐难看得多。 */}
          <div className="grid items-start gap-4 lg:grid-cols-[1.35fr_1fr]">
            <ChartShell
              title="内存占用"
              unit="按服务构成 · 当前"
              headline={formatBytesShort(memTotalNow)}
              headlineSuffix={`${memSeries.length} 个服务合计`}
              footnote="不显示占比：没给容器配 mem_limit 时，Docker 报的限额是宿主机总量，除下来四舍五入全是 0.0%，读不出信息。要看水位先在项目设置里配 mem_limit。"
            >
              <CompositionBar series={memSeries} />
            </ChartShell>
            <ThroughputChart rx={netRx} tx={netTx} read={diskRead} write={diskWrite} />
          </div>
        </>
      )}

      {/* 4. 部署历史 —— 柱子自己会说「构建在变慢」 */}
      <DeployHistoryChart items={deployments} onOpenDeployments={onOpenDeployments} />

      {/* 5. 部署环境 —— 复制集 / 基础设施收成一条，不再各占一格 */}
      <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.09em] text-muted-foreground">复制集</span>
          <span className="text-[13px] text-foreground-muted">{replicaSummary}</span>
        </span>
        <span className="h-7 w-px bg-[hsl(var(--hairline))]" aria-hidden />
        <span className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.09em] text-muted-foreground">基础设施</span>
          <span className="text-[13px] text-foreground-muted">{infraSummary}</span>
        </span>
        <span className="h-7 w-px bg-[hsl(var(--hairline))]" aria-hidden />
        <span className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.09em] text-muted-foreground">服务</span>
          <span className="text-[13px] text-foreground-muted">{services.length} 个 · {okCount} 个在跑</span>
        </span>
      </section>
    </div>
  );
}
