import { useMemo } from 'react';
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
 * 客户端环形缓冲上限。
 * 历史的真身在服务端（container-metrics-history），这里只是把它取回来画，
 * 外加把 5s 轮询的新点续在尾巴上。240 点够放「近 30 分钟 × 服务端 120 点降采样
 * + 之后十分钟的实时追加」，再多就该调窗口而不是把点堆在浏览器里。
 */
export const METRIC_RING_SIZE = 240;

/** per service+metric 的滚动缓冲。窗口长度由服务端 series 端点决定，不再是写死的 5 分钟。 */
export interface MetricSeries {
  cpu: number[];        // %
  mem: number[];        // % of limit
  /** 绝对占用字节。百分比在没配 mem_limit 的机器上恒等于 0（除数是宿主机总量），读不出信息。 */
  memBytes: number[];
  rxRate: number[];     // bytes/sec
  txRate: number[];     // bytes/sec
}

export function emptyMetricSeries(): MetricSeries {
  return { cpu: [], mem: [], memBytes: [], rxRate: [], txRate: [] };
}

/**
 * 用服务端历史序列铺底。
 *
 * 抽屉一打开就有完整曲线，不必再干等 10 秒攒两个点才出图；关掉再打开也接得上，
 * 因为点存在服务端不在这个组件里。速率已由服务端算好（累计差 / 间隔），
 * 前端不再从累计字节自己算 —— 那正是「关掉抽屉丢历史」时代的遗留做法。
 */
export function seedMetricSeries(points: Array<{
  cpuPercent: number | null; memUsedBytes: number | null; rxRate: number | null; txRate: number | null;
}>): MetricSeries {
  const tail = points.length > METRIC_RING_SIZE ? points.slice(points.length - METRIC_RING_SIZE) : points;
  // null = 那一段这个容器没有样本（没起来 / 已停 / 断档）。堆叠图里它的贡献就是 0，
  // 于是那一段的色带自然收没——这正是「服务挂了」在图上该有的样子。
  const v = (x: number | null): number => (x == null ? 0 : x);
  return {
    cpu: tail.map((p) => v(p.cpuPercent)),
    mem: tail.map(() => 0),
    memBytes: tail.map((p) => v(p.memUsedBytes)),
    rxRate: tail.map((p) => v(p.rxRate)),
    txRate: tail.map((p) => v(p.txRate)),
  };
}

export function pushMetricRing(
  series: MetricSeries,
  cpu: number,
  mem: number,
  memBytes: number,
  rxRate: number,
  txRate: number,
): MetricSeries {
  const trim = (arr: number[], v: number): number[] => {
    const next = [...arr, v];
    return next.length > METRIC_RING_SIZE ? next.slice(next.length - METRIC_RING_SIZE) : next;
  };
  return {
    cpu: trim(series.cpu, cpu),
    mem: trim(series.mem, mem),
    memBytes: trim(series.memBytes, memBytes),
    rxRate: trim(series.rxRate, rxRate),
    txRate: trim(series.txRate, txRate),
  };
}

/**
 * 系列色按固定次序赋值，**不循环**（dataviz 硬约束：第 9 个系列不许生成新色）。
 * 超过 5 个服务时，占用最小的那些合并成一条「其他」，用中性色。
 */
const SERIES_SLOTS = 5;
const seriesColor = (i: number): string => `hsl(var(--series-${i + 1}))`;
const OTHER_COLOR = 'hsl(var(--hairline-strong))';

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
  return values.map((row) => {
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i < n; i += 1) {
      bottom.unshift(`${x(i).toFixed(1)},${y(cum[i]).toFixed(1)}`);
      cum[i] += row[i] ?? 0;
      top.push(`${x(i).toFixed(1)},${y(cum[i]).toFixed(1)}`);
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
  values: number[];
  nowLabel: string;
  nowUnit: string;
  /** 容器已经不在跑了。序列尾巴停在它停机那一刻，末值是**停机前的旧读数**，不能当现值显示。 */
  stopped?: boolean;
}

function StackedAreaChart({
  height, max, series,
}: { height: number; max: number; series: StackedSeries[] }): JSX.Element {
  const paths = useMemo(
    () => stackAreas(series.map((s) => s.values), max, height),
    [series, max, height],
  );
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox={`0 0 ${VB_W} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {paths.map((d, i) => (
        d ? <path key={series[i].id} d={d} style={{ fill: series[i].color }} fillOpacity={0.9} /> : null
      ))}
    </svg>
  );
}

function SeriesLegend({ series }: { series: StackedSeries[] }): JSX.Element {
  return (
    <div
      className="grid gap-2 border-t border-[hsl(var(--hairline))] pt-2.5"
      style={{ gridTemplateColumns: `repeat(${series.length}, minmax(0, 1fr))` }}
    >
      {series.map((s) => (
        <div key={s.id} className="flex min-w-0 gap-2">
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

function NetworkChart({ rx, tx }: { rx: number[]; tx: number[] }): JSX.Element {
  const max = Math.max(1, ...rx, ...tx) * 1.12;
  const h = 62;
  return (
    <ChartShell
      title="网络吞吐"
      unit="收在上、发在下"
      headline={`${formatBytesShort(rx.at(-1) ?? 0)}/s`}
      headlineSuffix={`收 · 发 ${formatBytesShort(tx.at(-1) ?? 0)}/s`}
    >
      <>
        <div className="relative" style={{ height: h * 2 + 2 }}>
          <svg className="absolute inset-x-0 top-0 w-full" height={h} viewBox={`0 0 ${VB_W} ${h}`} preserveAspectRatio="none" aria-hidden>
            <path d={areaPath(rx, max, h)} style={{ fill: 'hsl(var(--info))' }} fillOpacity={0.85} />
          </svg>
          <span className="absolute inset-x-0 h-px bg-[hsl(var(--hairline-strong))]" style={{ top: h }} aria-hidden />
          <svg
            className="absolute inset-x-0 w-full"
            style={{ top: h + 2, transform: 'scaleY(-1)' }}
            height={h}
            viewBox={`0 0 ${VB_W} ${h}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            <path d={areaPath(tx, max, h)} style={{ fill: 'hsl(var(--primary))' }} fillOpacity={0.8} />
          </svg>
        </div>
        <div className="flex gap-4 border-t border-[hsl(var(--hairline))] pt-2.5">
          <span className="flex items-center gap-2">
            <span className="h-5 w-[3px] rounded-full" style={{ background: 'hsl(var(--info))' }} aria-hidden />
            <span className="flex flex-col">
              <span className="text-[10.5px] text-muted-foreground">入站峰值</span>
              <span className="font-mono text-[13px] font-bold text-foreground">{formatBytesShort(Math.max(0, ...rx))}/s</span>
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className="h-5 w-[3px] rounded-full" style={{ background: 'hsl(var(--primary))' }} aria-hidden />
            <span className="flex flex-col">
              <span className="text-[10.5px] text-muted-foreground">出站峰值</span>
              <span className="font-mono text-[13px] font-bold text-foreground">{formatBytesShort(Math.max(0, ...tx))}/s</span>
            </span>
          </span>
        </div>
      </>
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
  entries, deployments, metricSeries, metricsReady, metricsError,
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
  metricsReady: boolean;
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
      .filter((x): x is { svc: OverviewService; ring: MetricSeries } => Boolean(x.ring) && x.ring.cpu.length >= 2)
      .sort((a, b) => a.svc.profileId.localeCompare(b.svc.profileId));
    return { head: withSeries.slice(0, SERIES_SLOTS), tail: withSeries.slice(SERIES_SLOTS) };
  }, [services, metricSeries]);

  const sampleCount = picked.head[0]?.ring.cpu.length ?? 0;
  const hasPlot = picked.head.length > 0 && sampleCount >= 2;

  const buildSeries = (
    read: (m: MetricSeries) => number[],
    label: (v: number) => [string, string],
  ): StackedSeries[] => {
    const head = picked.head.map((x, i) => {
      const values = read(x.ring);
      const [nowLabel, nowUnit] = label(values.at(-1) ?? 0);
      return {
        id: x.svc.profileId,
        color: seriesColor(i),
        values,
        nowLabel,
        nowUnit,
        stopped: x.svc.status !== 'running',
      };
    });
    if (picked.tail.length === 0) return head;
    const len = head[0]?.values.length ?? 0;
    const merged = Array.from({ length: len }, (_, i) => picked.tail.reduce((sum, x) => sum + (read(x.ring)[i] ?? 0), 0));
    const [nowLabel, nowUnit] = label(merged.at(-1) ?? 0);
    return [...head, { id: `其他 ${picked.tail.length} 个`, color: OTHER_COLOR, values: merged, nowLabel, nowUnit }];
  };

  const cpuSeries = hasPlot ? buildSeries((m) => m.cpu, (v) => [v.toFixed(2), '%']) : [];
  const memSeries = hasPlot ? buildSeries((m) => m.memBytes, (v) => {
    const parts = formatBytesShort(v).split(' ');
    return [parts[0], ` ${parts[1] ?? ''}`];
  }) : [];

  // 合计只算还在跑的：把停机前的旧读数加进「当前合计」会虚报占用。
  const cpuTotalNow = cpuSeries.reduce((n, s) => n + (s.stopped ? 0 : s.values.at(-1) ?? 0), 0);
  const memTotalNow = memSeries.reduce((n, s) => n + (s.stopped ? 0 : s.values.at(-1) ?? 0), 0);
  const cpuMax = Math.max(5, ...Array.from({ length: sampleCount }, (_, i) => cpuSeries.reduce((n, s) => n + (s.values[i] ?? 0), 0))) * 1.12;
  const memMax = Math.max(1, ...Array.from({ length: sampleCount }, (_, i) => memSeries.reduce((n, s) => n + (s.values[i] ?? 0), 0))) * 1.12;

  const netRx = Array.from({ length: sampleCount }, (_, i) => picked.head.concat(picked.tail).reduce((n, x) => n + (x.ring.rxRate[i] ?? 0), 0));
  const netTx = Array.from({ length: sampleCount }, (_, i) => picked.head.concat(picked.tail).reduce((n, x) => n + (x.ring.txRate[i] ?? 0), 0));

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
  const yTicksOf = (max: number, fmt: (v: number) => string): string[] =>
    [1, 0.66, 0.33, 0].map((f) => fmt(max * f));

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

      {/* 3. 资源占用 —— 堆叠面积图同时回答「总共多少」和「谁占的」 */}
      {metricsError ? (
        <section className="flex items-center gap-2 rounded-xl border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad">
          <span className="flex-1">读取指标失败：{metricsError}</span>
          <button type="button" className="inline-flex items-center gap-1.5 text-xs font-semibold hover:underline" onClick={onRefreshMetrics}>
            <RefreshCw className="h-3.5 w-3.5" />重试
          </button>
        </section>
      ) : !metricsReady || !hasPlot ? (
        <section className="rounded-xl border border-dashed border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-8 text-center text-sm text-muted-foreground">
          {services.length === 0
            ? '该分支还没有任何 service，先去构建配置 / 部署。'
            : `正在采集 docker stats，已有 ${sampleCount} / 2 个采样点…`}
        </section>
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
              height={168}
              yTicks={yTicksOf(cpuMax, (v) => v.toFixed(0))}
              xLabels={[windowText.replace('近 ', '') + '前', '现在']}
            >
              <StackedAreaChart height={168} max={cpuMax} series={cpuSeries} />
            </PlotFrame>
          </ChartShell>

          <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
            <ChartShell
              title="内存占用"
              unit="按服务堆叠"
              headline={formatBytesShort(memTotalNow)}
              headlineSuffix={`${memSeries.length} 个服务合计`}
              legend={<SeriesLegend series={memSeries} />}
              footnote="不显示占比：没给容器配 mem_limit 时，Docker 报的限额是宿主机总量，除下来四舍五入全是 0.0%，读不出信息。要看水位先在项目设置里配 mem_limit。"
            >
              <PlotFrame
                height={120}
                yTicks={yTicksOf(memMax, (v) => formatBytesShort(v).replace(/ (\w)\w*$/, "$1"))}
                xLabels={[windowText.replace('近 ', '') + '前', '现在']}
              >
                <StackedAreaChart height={120} max={memMax} series={memSeries} />
              </PlotFrame>
            </ChartShell>
            <NetworkChart rx={netRx} tx={netTx} />
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
