/**
 * 验收报告主页 · 方向 A「结论优先」（2026-09-08）。
 *
 * 四段固定结构，顺序对应验收规范 §7.0 决策读者的四个问题：
 *   ① 结论头条 + 发布闸 + 结论分布图（能不能用）
 *   ② 未通过与待决（哪里红、下一步）
 *   ③ 每日验收连续性 + 合并未验（测完没；证据空白不是产品缺陷）
 *   ④ 报告台账（找一份报告）——由父组件渲染，本文件只出前三段
 *
 * 图表全部是内联 SVG / DOM，不引第三方图表库。颜色只走状态 token（ok / warn / bad / info），
 * 每个色块都配文字与图标，不靠颜色单独表意（报告证据指南 §4 颜色契约）。
 */
import { useMemo } from 'react';
import { CalendarDays, CircleAlert, CircleCheck, CircleX, ExternalLink, GitMerge, GitPullRequest, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { MergeCoverageStatus, OverviewCluster, ReportsOverview, ReportVerdict } from '@/lib/api';

export interface ReportsOverviewProps {
  overview: ReportsOverview;
  projectName: (projectId: string | null) => string;
  onOpenReport: (reportId: string) => void;
  onOpenCluster: (cluster: OverviewCluster) => void;
  onJump: (anchor: 'clusters' | 'coverage' | 'ledger') => void;
}

const VERDICT_META: Record<ReportVerdict, { label: string; Icon: LucideIcon; color: string; soft: string }> = {
  pass: { label: '通过', Icon: CircleCheck, color: 'hsl(var(--ok))', soft: 'hsl(var(--ok-soft))' },
  conditional: { label: '有条件', Icon: TriangleAlert, color: 'hsl(var(--warn))', soft: 'hsl(var(--warn-soft))' },
  fail: { label: '未通过', Icon: CircleX, color: 'hsl(var(--bad))', soft: 'hsl(var(--bad-soft))' },
};

const MERGE_META: Record<MergeCoverageStatus, { label: string; color: string; dashed?: boolean }> = {
  verified: { label: '已验通过', color: 'hsl(var(--ok))' },
  conditional: { label: '有条件', color: 'hsl(var(--warn))' },
  failed: { label: '验了没过', color: 'hsl(var(--bad))' },
  unverified: { label: '零验收', color: 'hsl(var(--hairline-strong))', dashed: true },
};

function fmtMonthDay(iso: string): string {
  return iso.slice(5, 10);
}

function fmtRate(rate: number | null): string {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function Eyebrow({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{children}</div>;
}

function SectionTitle({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="flex items-baseline gap-2.5">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
      </div>
      {right}
    </div>
  );
}

/**
 * 结论分布：本窗 / 上窗两根横向堆叠条（部分与整体，报告证据指南 §4 状态色）。
 * 段与段之间留 2px 表面缝，段内直接标数，右侧图例带图标。
 */
function VerdictBars({ overview }: { overview: ReportsOverview }): JSX.Element {
  const rows = [
    { label: '本窗', ...overview.totals },
    { label: '上窗', ...overview.totals.previous },
  ];
  const max = Math.max(1, ...rows.map((r) => r.pass + r.conditional + r.fail));
  const W = 320; const H = 18; const GAP = 2;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => {
        const total = r.pass + r.conditional + r.fail;
        const segs: Array<{ key: ReportVerdict; n: number }> = [
          { key: 'pass', n: r.pass }, { key: 'conditional', n: r.conditional }, { key: 'fail', n: r.fail },
        ].filter((s) => s.n > 0) as Array<{ key: ReportVerdict; n: number }>;
        let x = 0;
        return (
          <div key={r.label} className="flex items-center gap-3">
            <span className="w-8 shrink-0 text-[11px] text-muted-foreground">{r.label}</span>
            <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${r.label}：通过 ${r.pass}，有条件 ${r.conditional}，未通过 ${r.fail}`} className="min-w-0 flex-1">
              <rect x="0" y="0" width={W} height={H} rx="3" fill="hsl(var(--surface-sunken))" />
              {segs.map((s, i) => {
                const w = Math.max(0, (s.n / max) * W - (i < segs.length - 1 ? GAP : 0));
                const el = (
                  <g key={s.key}>
                    <rect x={x} y="0" width={w} height={H} rx={3} fill={VERDICT_META[s.key].color}>
                      <title>{`${r.label} ${VERDICT_META[s.key].label} ${s.n} 份`}</title>
                    </rect>
                    {w >= 22 ? (
                      <text x={x + w / 2} y={H / 2 + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill="hsl(var(--status-ink))" fontFamily="var(--cds-font-mono)">{s.n}</text>
                    ) : null}
                  </g>
                );
                x += w + GAP;
                return el;
              })}
            </svg>
            <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{total}</span>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {(['pass', 'conditional', 'fail'] as ReportVerdict[]).map((k) => {
          const m = VERDICT_META[k];
          return (
            <span key={k} className="inline-flex items-center gap-1"><m.Icon className="h-3 w-3" style={{ color: m.color }} />{m.label}</span>
          );
        })}
        {overview.totals.undetermined > 0 ? <span>无结论 {overview.totals.undetermined}</span> : null}
      </div>
    </div>
  );
}

/** 每日验收连续性：一行日格，状态色 + 文字；无报告的天走灰虚线（证据空白，不是失败）。 */
/**
 * 根因集中度：头条那句判断的图形证据。
 *
 * 为什么是水平条形（choosing-a-form：magnitude by identity, ranked）——头条说的是
 * 「N 份未通过里有 M 份指向同一处」，这句话的本质是**集中度**：一眼要看出最长那根
 * 比其余加起来还长。饼图比不出长度、折线没有时间轴、堆叠柱把对象挤成一列都读不出来。
 *
 * 颜色只用状态色（红 = 未通过 / 橙 = 有条件），且每根条都配对象名 + 段内数字 + 结论文字，
 * 不靠颜色单独表意。红↔橙这对是色觉障碍的经典风险对，实测 deutan ΔE 15.0（暗色）
 * / 16.3（白天），远高于 8 的门槛，另有直接标数兜底。
 *
 * 口径冲突簇的条形**真的拆成红 + 橙两段**——那正是「同一对象同日两种结论」这件事本身，
 * 不能用一个颜色糊过去（所以聚合层要返回 failCount / conditionalCount）。
 */
const CONCENTRATION_ROWS = 5;

function Concentration({ clusters, projectName, onOpenCluster }: {
  clusters: OverviewCluster[];
  projectName: (id: string | null) => string;
  onOpenCluster: (c: OverviewCluster) => void;
}): JSX.Element | null {
  const ranked = useMemo(() => {
    const order = { fail: 0, conflict: 1, conditional: 2 } as const;
    return [...clusters].sort((a, b) => order[a.verdict] - order[b.verdict] || b.count - a.count);
  }, [clusters]);
  if (ranked.length === 0) return null;
  const head = ranked.slice(0, CONCENTRATION_ROWS);
  const rest = ranked.slice(CONCENTRATION_ROWS);
  const restCount = rest.reduce((n, c) => n + c.count, 0);
  // 刻度取「最长那根」，让最长条铺满可用宽度——集中度靠相对长度读，不靠绝对份数。
  const max = Math.max(1, ...head.map((c) => c.count));
  const totalFail = clusters.reduce((n, c) => n + c.failCount, 0);
  const totalCond = clusters.reduce((n, c) => n + c.conditionalCount, 0);
  // 分母必须跟头条那句判断一致：头条说的是「N 份未通过里有 M 份」，
  // 所以这里也按未通过算，绝不换成「全部待办」——一块里出现两个分母就是口径冲突。
  const top = head[0] ?? null;
  const topShare = top && top.failCount > 0 && totalFail > 0
    ? { hit: top.failCount, base: totalFail, pct: Math.round((top.failCount / totalFail) * 100), word: '未通过' }
    : top && totalCond > 0
      ? { hit: top.conditionalCount, base: totalCond, pct: Math.round((top.conditionalCount / totalCond) * 100), word: '有条件' }
      : null;

  return (
    <div className="flex flex-col gap-2.5 border-t border-[hsl(var(--hairline))] pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Eyebrow>根因集中度 · 待办按验收对象合并</Eyebrow>
        {/* 两个色 = 必须有图例（accessibility pass）；同时每段还直接标了数字。 */}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-[2px]" style={{ background: 'hsl(var(--bad))' }} />未通过 {totalFail}</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-[2px]" style={{ background: 'hsl(var(--warn))' }} />有条件 {totalCond}</span>
        </div>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {head.map((c) => {
          const conflict = c.verdict === 'conflict';
          const m = VERDICT_META[conflict ? 'fail' : (c.verdict as ReportVerdict)];
          const label = conflict ? '口径冲突' : m.label;
          const labelColor = conflict ? 'hsl(var(--info))' : m.color;
          const RowIcon = conflict ? CircleAlert : m.Icon;
          const pct = (n: number) => `${(n / max) * 100}%`;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onOpenCluster(c)}
                title={`${c.target} · ${label} · 未通过 ${c.failCount} 份 / 有条件 ${c.conditionalCount} 份 · ${c.kinds.join(' · ')}${c.projectId ? ` · ${projectName(c.projectId)}` : ''} · 点击查看这 ${c.count} 份`}
                className="group flex w-full items-center gap-3 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[hsl(var(--surface-sunken))]"
              >
                <span className="w-[128px] shrink-0 truncate text-[12.5px] font-medium text-foreground group-hover:underline lg:w-[152px]">{c.target}</span>
                {/*
                  条形：细、右端 4px 圆角、两段之间留 2px 表面缝（marks-and-anatomy）。
                  数字不写在条内——白天主题橙底上的白字只有约 3.2:1，达不到 AA；
                  直接标注移到条形右侧并走文字 token（「文字穿文字色，不穿系列色」）。
                */}
                <span className="flex h-[10px] min-w-0 flex-1 items-stretch gap-[2px]">
                  {c.failCount > 0 ? (
                    <span className="rounded-[4px]" style={{ width: pct(c.failCount), background: 'hsl(var(--bad))', minWidth: 6 }} />
                  ) : null}
                  {c.conditionalCount > 0 ? (
                    <span className="rounded-[4px]" style={{ width: pct(c.conditionalCount), background: 'hsl(var(--warn))', minWidth: 6 }} />
                  ) : null}
                </span>
                <span className="w-[34px] shrink-0 text-right text-[12.5px] font-semibold tabular-nums text-foreground">{c.count}</span>
                <span className="inline-flex w-[72px] shrink-0 items-center gap-1 whitespace-nowrap text-[11.5px] font-semibold" style={{ color: labelColor }}>
                  <RowIcon className="h-3 w-3 shrink-0" />{label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="text-[11.5px] leading-relaxed text-muted-foreground">
        {topShare && top ? <>最长那根是「{top.target}」，{topShare.base} 份{topShare.word}里有 {topShare.hit} 份在它身上（{topShare.pct}%）。</> : null}
        {rest.length ? <>其余 {rest.length} 个对象合计 {restCount} 份，</> : null}
        条形按对象合并、不按份数堆；点任意一根跳到它的全部报告。
      </div>
    </div>
  );
}

function DailyStrip({ overview, onOpenReport }: { overview: ReportsOverview; onOpenReport: (id: string) => void }): JSX.Element {
  const days = overview.daily;
  const gaps = days.filter((d) => d.reports.length === 0);
  const gapText = gaps.length === 0
    ? `${days.length} 天每天都有每日验收报告。`
    : `${days.length} 天里 ${gaps.length} 天没有每日验收报告：${gaps.map((d) => fmtMonthDay(d.date)).join('、')}。这是证据空白，不是失败。`;
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[13.5px] leading-relaxed">
        {gaps.length ? <b className="text-foreground">{days.length} 天里 {gaps.length} 天没有每日验收</b> : null}
        {gaps.length ? gapText.slice(gapText.indexOf('：')) : gapText}
      </div>
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(7, days.length)}, minmax(0, 1fr))` }}>
        {days.map((d) => {
          const worst = d.worst ? VERDICT_META[d.worst] : null;
          const missing = d.reports.length === 0;
          const first = d.reports[0];
          const Inner = (
            <>
              <span className="font-mono text-[11px] text-muted-foreground">{fmtMonthDay(d.date)}</span>
              {missing ? (
                <span className="text-[10px] font-semibold text-muted-foreground">无报告</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold" style={{ color: worst?.color }}>
                  {worst ? <worst.Icon className="h-3 w-3" /> : null}<span className="hidden sm:inline">{worst?.label ?? '无结论'}{d.reports.length > 1 ? ` ×${d.reports.length}` : ''}</span>
                </span>
              )}
            </>
          );
          const cls = 'flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-md border px-1 py-1.5 text-center';
          if (missing) {
            return (
              <div key={d.date} className={`${cls} border-dashed border-[hsl(var(--hairline-strong))] bg-transparent`} title={`${d.date} 没有每日验收报告`}>{Inner}</div>
            );
          }
          return (
            <button
              key={d.date}
              type="button"
              className={`${cls} border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] transition-colors hover:border-primary/60`}
              title={`${d.date} · ${d.reports.length} 份每日验收，点击打开最新一份`}
              onClick={() => first && onOpenReport(first.id)}
            >
              {Inner}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 合并覆盖：一根堆叠条（已验 / 有条件 / 验了没过 / 零验收）+ 逐条清单。 */
function MergeCoverage({ overview, onOpenReport }: { overview: ReportsOverview; onOpenReport: (id: string) => void }): JSX.Element {
  const { items, counts } = overview.mergeCoverage;
  const total = items.length;
  const order: MergeCoverageStatus[] = ['verified', 'conditional', 'failed', 'unverified'];
  const W = 320; const H = 12; const GAP = 2;
  let x = 0;
  if (total === 0) {
    return (
      <div className="text-[13.5px] leading-relaxed text-muted-foreground">
        这个时间窗内没有记录到主干合并。合并记录来自 GitHub 合并事件留下的分支墓碑；没接 GitHub 的项目这里永远是空的。
      </div>
    );
  }
  const headline = counts.unverified > 0
    ? <>{total} 条合并的分支里 <b className="text-foreground">{counts.verified} 条验过且通过</b>，{counts.failed + counts.conditional} 条验了但没有干净通过，<b className="text-foreground">{counts.unverified} 条零验收</b>。零验收是证据空白，不是产品缺陷。</>
    : <>{total} 条合并的分支全部有验收记录：{counts.verified} 条通过，{counts.conditional} 条有条件，{counts.failed} 条未通过。</>;
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[13.5px] leading-relaxed">{headline}</div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="合并覆盖分布">
        <rect x="0" y="0" width={W} height={H} rx="3" fill="hsl(var(--surface-sunken))" />
        {order.filter((k) => counts[k] > 0).map((k, i, arr) => {
          const w = Math.max(0, (counts[k] / total) * W - (i < arr.length - 1 ? GAP : 0));
          const m = MERGE_META[k];
          const el = (
            <rect key={k} x={x} y="0" width={w} height={H} rx="3" fill={m.dashed ? 'transparent' : m.color} stroke={m.dashed ? m.color : 'none'} strokeDasharray={m.dashed ? '3 2' : undefined}>
              <title>{`${m.label} ${counts[k]} 条`}</title>
            </rect>
          );
          x += w + GAP;
          return el;
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {order.map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={MERGE_META[k].dashed ? { border: `1px dashed ${MERGE_META[k].color}` } : { background: MERGE_META[k].color }} />
            {MERGE_META[k].label} {counts[k]}
          </span>
        ))}
      </div>
      <div className="flex flex-col">
        {items.map((it) => {
          const m = MERGE_META[it.status];
          return (
            <div key={`${it.branch}-${it.mergedAt}`} className="grid items-center gap-3 border-t border-[hsl(var(--hairline))] py-2 grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_96px]">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold" title={it.branch}>{it.branch}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  {it.prNumber != null ? (
                    it.prUrl ? (
                      <a className="inline-flex h-[22px] items-center gap-1 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--code-bg))] px-1.5 font-mono text-[11px] text-info hover:underline" href={it.prUrl} target="_blank" rel="noreferrer">
                        <GitPullRequest className="h-3 w-3" />#{it.prNumber}
                      </a>
                    ) : (
                      <span className="inline-flex h-[22px] items-center gap-1 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--code-bg))] px-1.5 font-mono text-[11px] text-info"><GitPullRequest className="h-3 w-3" />#{it.prNumber}</span>
                    )
                  ) : null}
                  <span className="inline-flex h-[22px] items-center gap-1 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--code-bg))] px-1.5 font-mono text-[11px] text-muted-foreground"><GitMerge className="h-3 w-3" />{fmtMonthDay(it.mergedAt)} 合并</span>
                </div>
              </div>
              <div className="hidden text-[11.5px] text-muted-foreground lg:block">
                {it.reportIds.length ? `${it.reportIds.length} 份验收匹配到这条分支` : '没有任何验收报告的 PR、commit 或分支指向它'}
              </div>
              <div className="flex justify-end">
                {it.reportIds.length ? (
                  <button type="button" className="inline-flex h-[22px] items-center gap-1 rounded-full border px-2 text-[11.5px] font-semibold hover:opacity-90" style={{ color: m.color, borderColor: `color-mix(in srgb, ${m.color} 35%, transparent)`, background: it.status === 'verified' ? 'hsl(var(--ok-soft))' : it.status === 'failed' ? 'hsl(var(--bad-soft))' : 'hsl(var(--warn-soft))' }} onClick={() => onOpenReport(it.reportIds[0])} title="打开最新一份匹配的报告">
                    {m.label}
                  </button>
                ) : (
                  <span className="inline-flex h-[22px] items-center rounded-full border border-dashed border-[hsl(var(--hairline-strong))] px-2 text-[11.5px] font-semibold text-muted-foreground">零验收</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DefectPills({ counts }: { counts: Record<string, number> }): JSX.Element | null {
  const p0 = counts.p0 ?? 0; const p1 = counts.p1 ?? 0; const p2 = counts.p2 ?? 0; const p3 = counts.p3 ?? 0;
  if (!p0 && !p1 && !p2 && !p3) return null;
  const cell = (label: string, n: number, blocking: boolean): JSX.Element => (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] ${n === 0 ? 'bg-[hsl(var(--surface-sunken))] text-muted-foreground' : blocking ? 'bg-[hsl(var(--bad-soft))] text-bad' : 'bg-[hsl(var(--warn-soft))] text-warn'}`}>{label} {n}</span>
  );
  return <span className="inline-flex flex-wrap gap-1">{cell('P0', p0, true)}{cell('P1', p1, true)}{cell('P2', p2, false)}{p3 ? cell('P3', p3, false) : null}</span>;
}

/** 未通过与待决：同根因合并成一行；口径冲突走信息色（记录打架，不是产品坏了）。 */
function ClusterTable({ overview, projectName, onOpenCluster, onOpenReport }: { overview: ReportsOverview; projectName: (id: string | null) => string; onOpenCluster: (c: OverviewCluster) => void; onOpenReport: (id: string) => void }): JSX.Element {
  const clusters = overview.clusters;
  if (clusters.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
        这个时间窗内没有未通过或有条件通过的报告。
      </div>
    );
  }
  const meta = (c: OverviewCluster): { label: string; Icon: LucideIcon; color: string; rail: string } => {
    if (c.verdict === 'fail') return { label: `未通过 ×${c.count}`, Icon: CircleX, color: 'hsl(var(--bad))', rail: 'hsl(var(--bad))' };
    if (c.verdict === 'conflict') return { label: '口径冲突', Icon: CircleAlert, color: 'hsl(var(--info))', rail: 'hsl(var(--info))' };
    return { label: `有条件 ×${c.count}`, Icon: TriangleAlert, color: 'hsl(var(--warn))', rail: 'hsl(var(--warn))' };
  };
  const nextStep = (c: OverviewCluster): string => {
    if (c.verdict === 'conflict') return '同一对象同日结论互相矛盾，先统一口径再复测；统计只认最新版。';
    const blocking = (c.defectCounts.p0 ?? 0) + (c.defectCounts.p1 ?? 0);
    if (c.verdict === 'fail' && blocking === 0 && Object.keys(c.defectCounts).length > 0) return '未通过但没有记录阻断缺陷：按规范这是验收链路失败而不是产品坏了，先把失败原因写进报告再复跑。';
    if (c.verdict === 'fail' && c.streakWindows > 1) return `连续第 ${c.streakWindows} 个时间窗未通过，拆成单点逐点给出「通 / 不通、卡在哪一步」，并指定负责人。`;
    if (c.verdict === 'fail') return c.count > 1 ? '同一对象多份未通过，合并成一条待办处理，修完做一次缺陷复测。' : '修复后做一次缺陷复测，通过前不当作可用入口。';
    return c.count > 1 ? '条件项若同源，合并成一条待办，不要每份各挂一条。' : '确认条件项是否已记入债务台账，能结就结。';
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-[13px]">
        <thead>
          <tr className="bg-[hsl(var(--surface-sunken))] text-left text-[11px] uppercase tracking-[0.04em] text-muted-foreground">
            <th className="px-3 py-2.5 font-medium">结论</th>
            <th className="px-3 py-2.5 font-medium">验收项</th>
            <th className="px-3 py-2.5 font-medium">缺陷</th>
            <th className="px-3 py-2.5 text-right font-medium">证据</th>
          </tr>
        </thead>
        <tbody>
          {clusters.map((c) => {
            const m = meta(c);
            return (
              <tr key={c.id} className="border-t border-[hsl(var(--hairline))] align-top" style={{ boxShadow: `inset 3px 0 0 ${m.rail}` }}>
                <td className="w-[128px] px-3 py-3">
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-semibold" style={{ color: m.color }}><m.Icon className="h-3.5 w-3.5" />{m.label}</span>
                </td>
                <td className="px-3 py-3">
                  <button type="button" className="text-left font-semibold text-foreground hover:underline" onClick={() => onOpenReport(c.latestReportId)} title="打开最新一份">{c.target}</button>
                  <div
                    className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground"
                    title={`${c.kinds.join(' · ')} · 最近 ${fmtMonthDay(c.latestCreatedAt)}${c.projectId ? ` · ${projectName(c.projectId)}` : ' · CDS 自身'}`}
                  >
                    {c.kinds.join(' · ')} · 最近 {fmtMonthDay(c.latestCreatedAt)}{c.projectId ? ` · ${projectName(c.projectId)}` : ' · CDS 自身'}
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-1.5 text-[12.5px] leading-relaxed text-[hsl(var(--foreground-muted))]">
                    <span className="shrink-0 text-[11px] text-muted-foreground">下一步</span>
                    <span className="min-w-0">{nextStep(c)}</span>
                  </div>
                </td>
                <td className="w-[190px] px-3 py-3 align-top"><DefectPills counts={c.defectCounts} /></td>
                <td className="w-[96px] px-3 py-3 text-right">
                  <button type="button" className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-[hsl(var(--primary-ink))] hover:underline" onClick={() => onOpenCluster(c)}>{c.count} 份</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ReportsOverviewPanel({ overview, projectName, onOpenReport, onOpenCluster, onJump }: ReportsOverviewProps): JSX.Element {
  const { headline, releaseGate, totals, passRate } = overview;
  const statusMeta = useMemo(() => {
    if (headline.status === 'broken') return { color: 'hsl(var(--bad))', soft: 'hsl(var(--bad-soft))', Icon: CircleX };
    if (headline.status === 'ok') return { color: 'hsl(var(--ok))', soft: 'hsl(var(--ok-soft))', Icon: CircleCheck };
    return { color: 'hsl(var(--warn))', soft: 'hsl(var(--warn-soft))', Icon: TriangleAlert };
  }, [headline.status]);
  const gateMeta = releaseGate.state === 'blocked'
    ? { label: '不可发布', color: 'hsl(var(--bad))', soft: 'hsl(var(--bad-soft))', Icon: CircleX }
    : releaseGate.state === 'open'
      ? { label: '可以发布', color: 'hsl(var(--ok))', soft: 'hsl(var(--ok-soft))', Icon: CircleCheck }
      : { label: '未知', color: 'hsl(var(--muted-foreground))', soft: 'hsl(var(--surface-sunken))', Icon: CircleAlert };
  const supportDot = (kind: 'new' | 'coverage' | 'decision'): React.CSSProperties => {
    if (kind === 'new') return { background: 'hsl(var(--bad))' };
    if (kind === 'decision') return { background: 'hsl(var(--primary))' };
    return { border: '1px dashed hsl(var(--hairline-strong))', background: 'transparent' };
  };
  const supportLabel = { new: '新账', coverage: '没测完', decision: '需要你决定' } as const;
  const rateDelta = passRate.rate != null && passRate.previous.rate != null ? passRate.rate - passRate.previous.rate : null;

  // 发布闸是红的时候，「需要你决定」那条支撑句与右栏发布闸卡一字不差。
  // 同一句话在一屏里出现两次，读者会觉得这页在自言自语——重复的那条不渲染。
  const supports = headline.supports.filter((s) => !(s.kind === 'decision' && releaseGate.state === 'blocked'));

  /*
   * 版面只有一条脊柱（2026-09-09 重排）。
   *
   * 改之前是三种互不对齐的列结构上下摞着：结论区 2fr/1fr（分割线在 67%）、
   * 覆盖缺口 1fr/1fr（50%）、未通过与台账满宽。眼睛找不到一条贯穿的竖线，
   * 于是每块单看都不错、合起来像散落一地。
   *
   * 现在整页只有一个分割：主栏（叙述：结论 → 未通过 → 覆盖）+ 320px 固定侧栏
   * （仪表：发布闸 + 结论分布）。侧栏跨满三行并 sticky，那条竖线从页顶一直
   * 通到底，且滚动时仪表一直在视野里。
   *
   * 同时定了三档权重，不再人人平等：
   *   一档 结论——不套卡片，靠状态色条 + 留白 + 最大字号站住，全屏唯一主角；
   *   二档 证据——常规卡（细边框 + card 底）；
   *   三档 台账——由父组件渲染，用一条分隔线与上面隔开（查找工具，不是结论）。
   */
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-6 xl:auto-rows-min xl:grid-cols-[minmax(0,1fr)_320px]">
      {/* ① 结论（一档）：不套卡片 */}
      <section className="relative min-w-0 pl-5 xl:col-start-1 xl:row-start-1">
        <div className="absolute bottom-0.5 left-0 top-0.5 w-[3px] rounded-full" style={{ background: statusMeta.color }} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Eyebrow>结论 · 最近 {overview.window.days} 天 · {totals.archived} 份归档{totals.folded ? `，折叠 ${totals.folded} 份重复后计 ${totals.counted} 份` : ''} · 数据截至 {fmtMonthDay(overview.window.to)}</Eyebrow>
          <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-[11.5px] font-semibold" style={{ color: statusMeta.color, background: statusMeta.soft, borderColor: `color-mix(in srgb, ${statusMeta.color} 30%, transparent)` }}>
            <statusMeta.Icon className="h-3 w-3" />{headline.statusLabel}
          </span>
        </div>
        <h1 className="m-0 mt-2.5 text-[24px] font-semibold leading-[1.25] tracking-[-0.02em] lg:text-[30px]" style={{ textWrap: 'pretty' }}>{headline.sentence}</h1>
        <Concentration clusters={overview.clusters} projectName={projectName} onOpenCluster={onOpenCluster} />
        {supports.length ? (
          // 支撑句改成行内条目：原来是三张带边框带底色的子卡片，卡中卡是密度失控不是密度高。
          <ul className="m-0 mt-3.5 flex list-none flex-col gap-2 border-t border-[hsl(var(--hairline))] p-0 pt-3.5">
            {supports.map((s) => (
              <li key={s.kind} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[13px] leading-relaxed">
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={supportDot(s.kind)} />{supportLabel[s.kind]}
                </span>
                <span className="min-w-0 text-[hsl(var(--foreground-muted))]">{s.text}</span>
                <button type="button" className="shrink-0 text-xs font-medium text-[hsl(var(--primary-ink))] hover:underline" onClick={() => onJump(s.anchor)}>
                  {s.anchor === 'coverage' ? '查看覆盖缺口' : s.anchor === 'clusters' ? '查看未通过清单' : '去台账'}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* 侧栏（仪表）：跨满三行，那条竖线因此从页顶通到底；sticky 让它在滚动时一直在场 */}
      <aside className="min-w-0 xl:col-start-2 xl:row-span-3 xl:row-start-1">
        <div className="flex flex-col gap-4 xl:sticky xl:top-4">
          <div className="flex flex-col gap-2.5 rounded-[10px] border border-[hsl(var(--hairline))] p-4" style={{ background: `linear-gradient(180deg, ${gateMeta.soft}, hsl(var(--card)) 70%)` }}>
            <div className="flex items-center justify-between"><Eyebrow>发布闸</Eyebrow>{releaseGate.latest ? <span className="font-mono text-[11px] text-muted-foreground">{releaseGate.latest.kind} · {fmtMonthDay(releaseGate.latest.createdAt)}</span> : null}</div>
            <div className="flex items-center gap-2" style={{ color: gateMeta.color }}><gateMeta.Icon className="h-5 w-5" strokeWidth={2} /><span className="text-xl font-bold tracking-[-0.02em]">{gateMeta.label}</span></div>
            <div className="text-[12.5px] leading-relaxed text-[hsl(var(--foreground-muted))]">{releaseGate.reason}</div>
            {releaseGate.latest ? (
              <button type="button" className="inline-flex w-fit items-center gap-1 text-xs font-medium text-[hsl(var(--primary-ink))] hover:underline" onClick={() => onOpenReport(releaseGate.latest!.id)}>打开那份报告 <ExternalLink className="h-3 w-3" /></button>
            ) : null}
          </div>
          <div className="flex flex-col gap-3 rounded-[10px] border border-[hsl(var(--hairline))] bg-card p-4">
            <Eyebrow>结论分布 · 本窗 {totals.counted} 份 / 上窗 {totals.previous.counted} 份</Eyebrow>
            <VerdictBars overview={overview} />
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 border-t border-[hsl(var(--hairline))] pt-3">
              <div className="text-[12.5px] text-[hsl(var(--foreground-muted))]">{passRate.kind}通过率 <b className="text-[15px] text-foreground">{fmtRate(passRate.rate)}</b> <span className="text-muted-foreground">{passRate.numerator} / {passRate.denominator}</span></div>
              <div className="text-xs text-muted-foreground">
                上窗 {fmtRate(passRate.previous.rate)}{rateDelta != null ? `（${rateDelta >= 0 ? '+' : ''}${(rateDelta * 100).toFixed(1)} 点）` : ''}，分母 {passRate.previous.denominator} → {passRate.denominator}
              </div>
            </div>
            <div className="text-[11.5px] leading-relaxed text-muted-foreground">每个验收目标只计最新一版；被取代的早期版本不进分母。</div>
          </div>
        </div>
      </aside>

      {/* ② 未通过与待决（二档） */}
      <section id="reports-clusters" className="min-w-0 overflow-hidden rounded-[10px] border border-[hsl(var(--hairline))] bg-card xl:col-start-1 xl:row-start-2">
        <div className="border-b border-[hsl(var(--hairline))] px-4 py-3">
          <SectionTitle
            title="未通过与待决"
            sub="同一对象的报告合并成一行，按根因不按份数"
            right={(
              <div className="flex items-center gap-2 text-[11.5px] font-semibold">
                <span className="rounded-full border px-2 py-0.5 text-bad" style={{ background: 'hsl(var(--bad-soft))', borderColor: 'color-mix(in srgb, hsl(var(--bad)) 30%, transparent)' }}>未通过 {totals.fail}</span>
                <span className="rounded-full border px-2 py-0.5 text-warn" style={{ background: 'hsl(var(--warn-soft))', borderColor: 'color-mix(in srgb, hsl(var(--warn)) 30%, transparent)' }}>有条件 {totals.conditional}</span>
              </div>
            )}
          />
        </div>
        <ClusterTable overview={overview} projectName={projectName} onOpenCluster={onOpenCluster} onOpenReport={onOpenReport} />
      </section>

      {/* ③ 覆盖缺口（二档）：两张卡只在够宽时并排，窄了就纵向排，日历带不会被挤断 */}
      <section id="reports-coverage" className="grid min-w-0 gap-5 xl:col-start-1 xl:row-start-3 2xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3 rounded-[10px] border border-[hsl(var(--hairline))] bg-card p-4">
          <SectionTitle title="每日验收连续性" sub={`近 ${overview.daily.length} 天 · 按报告创建日`} right={<CalendarDays className="h-4 w-4 text-muted-foreground" />} />
          <DailyStrip overview={overview} onOpenReport={onOpenReport} />
        </div>
        <div className="flex min-w-0 flex-col gap-3 rounded-[10px] border border-[hsl(var(--hairline))] bg-card p-4">
          <SectionTitle title="合并的分支，验没验" sub="主干合并记录 × 报告的 PR / commit / 分支" right={<GitMerge className="h-4 w-4 text-muted-foreground" />} />
          <MergeCoverage overview={overview} onOpenReport={onOpenReport} />
        </div>
      </section>
    </div>
  );
}
