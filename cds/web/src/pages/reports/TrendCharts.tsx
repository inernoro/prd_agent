/**
 * 验收流水线的走向（2026-09-14）。
 *
 * 为什么加这一块：原来的总览条只讲**此刻的存量**（71 条在改、5 条验完），
 * 它答不了「在变好还是变坏」。用户提出改用折线之后，三份并行设计各自独立
 * 得出同一个结论，本文件按那个结论落地：
 *
 *   - **按天单层画不成立**。真实数据里 101 天只有 18 天有新改动，结论三档分别
 *     只落在 31 / 43 / 42 天上；y 轴一按峰值定，占九成天数的那段被压成贴零平线，
 *     看到的是噪声不是走向。
 *   - **加一层滚动均线就成立**。7 日滚动（仍是每天一个点，不是周聚合）把走向
 *     抬出来，而当日原始细线留着滚动线会抹掉的两样东西：爆发的形状与空白日。
 *
 * 所以紧凑态只画滚动线（当日细线在 4rem 高度上会糊成一片毛刺），
 * 放大态把细线与日常参照带加回来。两态是同一条线，只是放大多一层细节。
 *
 * 三条纪律：
 * 1. **算不出来的不画**。没有「每日部署了几条」这条线：分支只记 lastDeployAt
 *    （最后一次部署的时刻），不是部署历史，按天分桶得到的是另一件事。页脚照实说。
 * 2. **不做双轴**。任何一张图里所有线共用一个刻度，刻度上限直接写在图上。
 * 3. **颜色不是唯一编码**。仓库的 --ok/--warn/--bad 在白天主题下色觉分辨
 *    ΔE 7.7，落在 6–8 的地板区，按规矩必须配第二编码，所以三档另带不同虚线
 *    样式与线端直标。（夜间那组明度偏高、越出暗底的明度带，是已知边界，
 *    见 doc/debt.cds.md；此处不改全局 token，改它会波及整个 CDS。）
 */
import type { PipelineSeries } from '@/lib/api';

/* ============================ 计算 ============================ */

/**
 * 尾部滚动均值（含当日）。
 *
 * 开头不足 win 天的那几个点按**实际可用天数**取均，不按 win 取——
 * 按 win 除会凭空造出一段从零爬升的斜坡，读者会把它当成「那时候确实很少」。
 */
export function rolling(xs: number[], win: number): number[] {
  const w = Math.max(1, Math.floor(win));
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < xs.length; i += 1) {
    sum += xs[i];
    if (i >= w) sum -= xs[i - w];
    const n = Math.min(i + 1, w);
    out.push(sum / n);
  }
  return out;
}

/**
 * 刻度上限取整到好读的数，且永远 >= 1。
 *
 * NaN 要单独挡：Math.max(1, NaN) 还是 NaN，而 NaN 做分母会让每个 y 都是 NaN，
 * 路径变成一串 "MNaN NaN"，SVG 直接不画——整张图静默消失，控制台一声不吭。
 */
export function niceMax(v: number): number {
  const x = Number.isFinite(v) ? Math.max(1, v) : 1;
  const mag = 10 ** Math.floor(Math.log10(x));
  for (const step of [1, 1.5, 2, 3, 4, 5, 6, 8, 10]) {
    if (x <= step * mag) return step * mag;
  }
  return 10 * mag;
}

interface Geom {
  w: number;
  h: number;
  max: number;
  x: (i: number) => number;
  y: (v: number) => number;
}

function geom(n: number, w: number, h: number, max: number): Geom {
  const span = Math.max(1, n - 1);
  return {
    w,
    h,
    max,
    x: (i) => (i / span) * w,
    y: (v) => h - (Math.min(v, max) / max) * h,
  };
}

/** 折线路径。空数组返回空串，调用方据此不渲染 path（而不是渲染一个 d="" 的坏元素）。 */
export function linePath(vals: number[], g: Geom): string {
  if (!vals.length) return '';
  return vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${g.x(i).toFixed(1)} ${g.y(v).toFixed(1)}`).join(' ');
}

const fmt1 = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);
const md = (d: string): string => d.slice(5);

/* ============================ 样式 ============================ */

export const TREND_CSS = `
.tc{display:flex;flex-direction:column;gap:0.75rem;}
.tc .row{display:flex;flex-direction:column;gap:0.75rem;}
.tc .card{flex:1 1 0;min-width:0;display:flex;flex-direction:column;
  border:1px solid hsl(var(--hairline));border-radius:0.625rem;padding:0.6875rem 0.8125rem 0.5625rem;
  background:hsl(var(--card));}
.tc .ttl{display:flex;align-items:baseline;justify-content:space-between;gap:0.5rem;}
.tc .ttl b{font-size:0.8125rem;font-weight:600;letter-spacing:.01em;}
.tc .unit{font-size:0.625rem;letter-spacing:.1em;color:hsl(var(--muted-foreground));white-space:nowrap;}
.tc .say{margin:0.3125rem 0 0;font-size:0.75rem;line-height:1.65;color:hsl(var(--muted-foreground));}
.tc .say b{color:hsl(var(--foreground));font-weight:600;}
.tc .capv{display:flex;align-items:baseline;justify-content:space-between;gap:0.5rem;
  margin-top:0.375rem;font-size:0.625rem;letter-spacing:.06em;color:hsl(var(--muted-foreground));}
.tc .plot{margin-top:3px;}
.tc svg{display:block;width:100%;overflow:visible;}

.tc .band{fill:hsl(var(--foreground) / 0.05);}
.tc .grid{stroke:hsl(var(--hairline));stroke-width:1;}
.tc .axis{font-size:0.5625rem;fill:hsl(var(--muted-foreground));}
.tc .col{fill:transparent;}
.tc .col:hover{fill:hsl(var(--foreground) / 0.06);}

/* 粗线是读数层（走向），细线是证据层（当日原值与空白日）。 */
.tc .thick{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round;}
.tc .thin{fill:none;stroke-width:1;opacity:.42;}
.tc .bar{shape-rendering:crispEdges;}

/* 颜色不是唯一编码：三档另带不同虚线样式（白天主题色觉分辨 ΔE 7.7，在地板区）。 */
.tc .t-ok{stroke:hsl(var(--ok));}
.tc .t-warn{stroke:hsl(var(--warn));stroke-dasharray:7 3;}
.tc .t-bad{stroke:hsl(var(--bad));stroke-dasharray:2 3;}
.tc .g1{stroke:hsl(var(--foreground));}
.tc .g2{stroke:hsl(var(--muted-foreground));stroke-dasharray:7 3;}
.tc .g3{stroke:hsl(var(--hairline-strong));stroke-dasharray:2 3;}
.tc .fillbar{fill:hsl(var(--hairline-strong));}

.tc .lg{display:flex;flex-wrap:wrap;gap:0.25rem 0.8125rem;margin-top:0.4375rem;}
.tc .lgi{display:flex;align-items:center;gap:0.3125rem;font-size:0.6875rem;
  color:hsl(var(--muted-foreground));min-width:0;}
.tc .lgi b{color:hsl(var(--foreground));font-weight:600;}
.tc .dash{flex:0 0 1.0625rem;height:0;border-top-width:2px;border-top-style:solid;}
.tc .d-ok{border-color:hsl(var(--ok));border-top-style:solid;}
.tc .d-warn{border-color:hsl(var(--warn));border-top-style:dashed;}
.tc .d-bad{border-color:hsl(var(--bad));border-top-style:dotted;}
.tc .d-g1{border-color:hsl(var(--foreground));}
.tc .d-g2{border-color:hsl(var(--muted-foreground));border-top-style:dashed;}
.tc .d-g3{border-color:hsl(var(--hairline-strong));border-top-style:dotted;}
.tc .d-bar{border-color:hsl(var(--hairline-strong));border-top-width:0.4375rem;}

.tc .note{margin:0.4375rem 0 0;font-size:0.6875rem;line-height:1.6;color:hsl(var(--muted-foreground));}
.tc .foot{margin:0;font-size:0.6875rem;line-height:1.65;color:hsl(var(--muted-foreground));}
.tc .foot b{color:hsl(var(--foreground));font-weight:600;}

@media (min-width:1024px){
  .tc .row{flex-direction:row;}
}
`;

/* ============================ 图 ============================ */

interface Line {
  key: string;
  label: string;
  cls: string;
  dash: string;
  /** 当日原值（已裁掉预热段）。 */
  raw: number[];
  /** 7 日滚动均值：**在含预热段的完整序列上**滚完再裁，长度与 raw 相同。 */
  roll: number[];
  total: number;
}

interface ChartProps {
  title: string;
  unit: string;
  say?: JSX.Element | null;
  lines: Line[];
  days: string[];
  zoom: boolean;
  /** 底层柱子（事件量，不是趋势）。与 lines 共用同一刻度，roll 的口径同 Line。 */
  bars?: { label: string; vals: number[]; roll: number[]; total: number } | null;
  note?: string;
  tipFor: (i: number) => string;
}

const WIN = 7;

/**
 * 这一态要画哪一层、配哪个刻度——唯一一份。
 *
 * 紧凑态整屏都是 7 日均（细线在 4rem 高度上糊成毛刺，柱子同理），
 * 放大态整屏都是当日原值再叠滚动线。**层与刻度必须同源**：
 * 此前柱子无条件画原值、刻度却按滚动峰值定，于是所有高于滚动峰值的天
 * 被 geom 的 Math.min(v, max) 一律夹到顶——好几个高矮不同的日子看起来一样高，
 * 而图上写着「上限 X 件/日（7 日均）」，那句话是假的（Codex review 抓到）。
 *
 * 判据因此不是「代码里写没写 zoom」，而是「这一态真正交给 <rect>/<path> 的每一个值
 * 都 <= max」——测试照此断言，改回混层立刻红。
 */
export function layerScale(
  layers: Array<{ raw: number[]; roll: number[] }>,
  bars: { raw: number[]; roll: number[] } | null,
  zoom: boolean,
): { max: number; barVals: number[] | null } {
  const barVals = bars ? (zoom ? bars.raw : bars.roll) : null;
  const drawn = zoom
    ? [...layers.flatMap((l) => l.raw), ...layers.flatMap((l) => l.roll), ...(barVals ?? [])]
    : [...layers.flatMap((l) => l.roll), ...(barVals ?? [])];
  return { max: niceMax(Math.max(0, ...drawn)), barVals };
}

function Chart({ title, unit, say, lines, days, zoom, bars, note, tipFor }: ChartProps): JSX.Element {
  const h = zoom ? 156 : 62;
  const w = 1000; // viewBox 宽，实际按容器缩放
  // 两态刻度不同是有意的，所以上限直接写在图上——不写的话同一条线在两态高低不同会被误读。
  // 滚动均值不在这里算：它必须在**含预热段**的完整序列上滚完再裁，那件事由面板统一做。
  const { max, barVals } = layerScale(lines, bars ? { raw: bars.vals, roll: bars.roll } : null, zoom);
  const g = geom(days.length, w, h, max);
  const bandTop = g.y(Math.min(max, 4));
  const colW = w / Math.max(1, days.length);

  return (
    <div className="card">
      <div className="ttl">
        <b>{title}</b>
        <span className="unit">{unit}</span>
      </div>
      {zoom && say ? <p className="say">{say}</p> : null}
      <div className="capv">
        <span>上限 {max} 件/日{zoom ? '（当日峰值）' : '（7 日均）'}</span>
        <span>
          {md(days[0] ?? '')} 至 {md(days[days.length - 1] ?? '')}
        </span>
      </div>
      <div className="plot">
        {/* 高度走 rem：SVG 的 height 数值属性等于 px，不跟根字号缩，
            在 80/85/100 三档尺度下会出现「字缩了、画布没缩」。viewBox 仍用
            无单位的绘图坐标，preserveAspectRatio="none" 让它按实际高度拉伸。 */}
        <svg
          viewBox={`0 0 ${w} ${h}`}
          style={{ height: `${h / 16}rem` }}
          preserveAspectRatio="none"
          role="img"
          aria-label={title}
        >
          {/* 日常参照带：放大态才给，用来说明「九成日子落在这条带里」。 */}
          {zoom && max > 4 ? <rect className="band" x={0} y={bandTop} width={w} height={h - bandTop} /> : null}
          <line className="grid" x1={0} y1={h} x2={w} y2={h} />

          {barVals ? (
            <g className="bar">
              {barVals.map((v, i) =>
                v > 0 ? (
                  <rect
                    key={i}
                    className="fillbar"
                    x={g.x(i) - colW * 0.36}
                    y={g.y(v)}
                    width={colW * 0.72}
                    height={Math.max(1, h - g.y(v))}
                  />
                ) : null,
              )}
            </g>
          ) : null}

          {/* 证据层：当日原值。只在放大态出现——4rem 高度上它会糊成毛刺。 */}
          {zoom
            ? lines.map((l) => {
                const d = linePath(l.raw, g);
                return d ? <path key={`r${l.key}`} className={`thin ${l.cls}`} d={d} /> : null;
              })
            : null}

          {/* 读数层：滚动均线。两态都在，形状一致。 */}
          {lines.map((l) => {
            const d = linePath(l.roll, g);
            return d ? <path key={l.key} className={`thick ${l.cls}`} d={d} /> : null;
          })}

          {/* 每天一根透明列，挂 data-tip 走面板已有的事件委托，不另造一套浮层。 */}
          {days.map((d, i) => (
            <rect
              key={d}
              className="col"
              x={g.x(i) - colW / 2}
              y={0}
              width={colW}
              height={h}
              data-tip={tipFor(i)}
            />
          ))}
        </svg>
      </div>

      <div className="lg">
        {bars ? (
          <span className="lgi">
            <span className="dash d-bar" />
            {bars.label} <b>{bars.total}</b>
          </span>
        ) : null}
        {lines.map((l) => (
          <span className="lgi" key={l.key}>
            <span className={`dash ${l.dash}`} />
            {l.label} <b>{l.total}</b>
          </span>
        ))}
      </div>
      {zoom && note ? <p className="note">{note}</p> : null}
    </div>
  );
}

/* ============================ 面板 ============================ */

export interface TrendChartsProps {
  series: PipelineSeries;
  zoom: boolean;
}

/** 项目线的灰阶档位。四条及以上时最后一档复用最浅色，靠线型与线端直标区分。 */
const GREY_CLS = ['g1', 'g2', 'g3', 'g3'] as const;
const GREY_DASH = ['d-g1', 'd-g2', 'd-g3', 'd-g3'] as const;

export function TrendCharts({ series, zoom }: TrendChartsProps): JSX.Element {
  const { days, pass, conditional, fail, undetermined, changes } = series;
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const reports = days.map((_, i) => pass[i] + conditional[i] + fail[i] + undetermined[i]);

  /**
   * 滚动均值的**唯一**入口：先接上预热段再滚，滚完裁掉预热段。
   *
   * 顺序反过来（先裁再滚，或者压根没有预热段）就是 Codex 抓到的那个坏法：
   * 开头几天只拿得到 1~6 个样本，而图上对每一点都标着「7 日均」。窗口之前刚好
   * 有一波活动时，左边缘会凭空多出一段并不存在的涨或跌。
   *
   * 裁多少由后端给的预热段自己的长度决定，不写死 6——旧后端不给这个字段时它是
   * 空数组，行为退回从前（样本少几天，但不崩）。
   */
  const warm = series.leadIn;
  const roll = (head: number[] | undefined, xs: number[]): number[] => {
    const h = head ?? [];
    return rolling([...h, ...xs], WIN).slice(h.length);
  };

  const tPass = sum(pass);
  const tCond = sum(conditional);
  const tFail = sum(fail);
  const tUnd = sum(undetermined);
  const tChanges = sum(changes);
  const tReports = sum(reports);
  const verdictTotal = tPass + tCond + tFail;

  // 结论走向那句判断：规则生成，每句挂真实数字，算不出来就不出这句。
  const rPass = roll(warm?.pass, pass);
  const rFail = roll(warm?.fail, fail);
  const aheadDays = days.filter((_, i) => rFail[i] > rPass[i]).length;
  const lastI = days.length - 1;
  const verdictSay = verdictTotal === 0 ? null : (
    <>
      验完的 <b>{verdictTotal}</b> 条里未通过 <b>{tFail}</b> 条
      {tPass > 0 ? (
        <>
          ，是通过 {tPass} 条的 <b>{(tFail / tPass).toFixed(2)}</b> 倍
        </>
      ) : null}
      。{aheadDays > 0 ? (
        <>
          <b>{aheadDays}</b> 天里未通过的 7 日均高于通过
        </>
      ) : (
        <>未通过的 7 日均没有一天高于通过</>
      )}
      ，最新一天收在通过 {fmt1(rPass[lastI] ?? 0)} / 未通过 {fmt1(rFail[lastI] ?? 0)} 件/日。
    </>
  );

  // 画后端给多少条，不自己再截一刀。后端默认给 4 条并把第 5 名之后算进
  // otherProjects；前端若只画前 3，第 4 名既没画线、也不在「其余 N 个项目」里，
  // 图例与报告总数就对不上账（Codex review 抓到）。
  const projLines: Line[] = series.projects.map((p, i) => ({
    key: p.projectId ?? `_none${i}`,
    label: p.projectName,
    cls: GREY_CLS[i] ?? GREY_CLS[GREY_CLS.length - 1],
    dash: GREY_DASH[i] ?? GREY_DASH[GREY_DASH.length - 1],
    raw: p.counts,
    roll: roll(p.leadIn, p.counts),
    total: p.total,
  }));
  const lead = series.projects[0];
  const projSay = !lead || tReports === 0 ? null : (
    <>
      {tReports} 份报告里 <b>{lead.projectName}</b> 占 <b>{lead.total}</b> 份（
      {Math.round((lead.total / tReports) * 100)}%）。
      {series.otherProjects.count > 0 ? (
        <>另有 {series.otherProjects.count} 个项目合计 {series.otherProjects.total} 份，未画线。</>
      ) : null}
    </>
  );

  // 报告总数没有单独的预热序列，由三档加未定当场合出来（与上面 reports 同一算法）。
  const rReports = roll(
    warm ? warm.days.map((_, i) => warm.pass[i] + warm.conditional[i] + warm.fail[i] + warm.undetermined[i]) : undefined,
    reports,
  );
  const rChanges = roll(warm?.changes, changes);

  const day = (i: number): string => days[i] ?? '';
  const verdictTip = (i: number): string =>
    [
      day(i),
      `通过 ${pass[i]} · 原则性 ${conditional[i]} · 未通过 ${fail[i]}`,
      `7 日均 通过 ${fmt1(rPass[i])} · 未通过 ${fmt1(rFail[i])}`,
      undetermined[i] > 0 ? `另有 ${undetermined[i]} 份结论为空，不计入三档` : '',
    ]
      .filter(Boolean)
      .join('\n');
  const projTip = (i: number): string =>
    [day(i), ...projLines.map((l) => `${l.label} ${l.raw[i]}`)].join('\n');
  const flowTip = (i: number): string =>
    [
      day(i),
      `新开改动 ${changes[i]} 条`,
      `归档报告 ${reports[i]} 份`,
      `报告 7 日均 ${fmt1(rReports[i])} 份/日`,
    ].join('\n');

  return (
    <div className="tc">
      <div className="row">
        <Chart
          title="验收结论走向"
          unit="件 / 日"
          zoom={zoom}
          days={days}
          say={verdictSay}
          tipFor={verdictTip}
          lines={[
            { key: 'pass', label: '通过', cls: 't-ok', dash: 'd-ok', raw: pass, roll: rPass, total: tPass },
            { key: 'cond', label: '原则性通过', cls: 't-warn', dash: 'd-warn', raw: conditional, roll: roll(warm?.conditional, conditional), total: tCond },
            { key: 'fail', label: '未通过', cls: 't-bad', dash: 'd-bad', raw: fail, roll: rFail, total: tFail },
          ]}
          note={
            tUnd > 0
              ? `结论为空的 ${tUnd} 份没画成第四条线：它不是第四种结论，而是报告的结论字段缺失。它计入下一张图的归档报告总数。`
              : undefined
          }
        />
        <Chart
          title="验收落在哪几个项目"
          unit="份 / 日"
          zoom={zoom}
          days={days}
          say={projSay}
          tipFor={projTip}
          lines={projLines}
          note="这张图回答的是谁在被验收，不是谁有问题：序列里只有报告份数，没有项目与结论的交叉。"
        />
        <Chart
          title="改动开启 vs 报告归档"
          unit="件 / 日 · 同一刻度"
          zoom={zoom}
          days={days}
          tipFor={flowTip}
          bars={{ label: '新开改动', vals: changes, roll: rChanges, total: tChanges }}
          say={
            <>
              窗口内新开 <b>{tChanges}</b> 条改动、归档 <b>{tReports}</b> 份报告。
              改动画成柱不画成线，因为它是一件件事件而不是一段趋势。
            </>
          }
          lines={[
            { key: 'rep', label: '归档报告', cls: 'g1', dash: 'd-g1', raw: reports, roll: rReports, total: tReports },
          ]}
          note="两者单位不同（条分支 / 份报告），放在同一刻度是为了看共动与背离，不是为了比大小。"
        />
      </div>
      {zoom ? (
        <p className="foot">
          <b>没有画的线。</b>「每日部署了几条」算不出来：分支只记 lastDeployAt（最后一次部署的时刻），
          没有部署历史，按天分桶得到的是「最后一次部署时间的分布」，那是另一件事。要补得在后端记一张部署事件表。
          {series.lastDayPartial ? ' 末格是今天到此刻为止，不是完整一天。' : ''}
          <br />
          <b>柱子会随分支回收而变矮。</b>「新开改动」按现存分支的创建日分桶，而墓碑只记撤下时刻、
          不记当初建于哪一天。仓库开了「合并后自动删分支」的话，那条改动会当天从柱子里消失，
          于是可能出现「有报告归档、柱子却是零」。同样要等后端补一张改动开启事件表。
        </p>
      ) : null}
    </div>
  );
}
