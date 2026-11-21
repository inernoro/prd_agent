import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, History, Plus, RotateCcw, TrendingDown, TrendingUp } from 'lucide-react';
import type {
  PlanningAnalyticsActivity, PlanningCounts, PlanningGraphChange, PlanningGraphDebt, PlanningGraphOutcome, PlanningStats,
} from '../../../../src/shared/engineering-planning';
import { dateLabel, debtLabels, events, priorityLabels, shortId, sourceLabels } from './planning-ui';
import type { PlanningSelection } from './PlanningViews';
import './planning-analytics.css';

type SelectRecord = (item: PlanningSelection) => void;
type Granularity = 'day' | 'week' | 'month';
type Bucket = PlanningCounts & { day: string; end: string; backlog: number };

const DAY = 86_400_000;
const granularity = (days: number): Granularity => days <= 31 ? 'day' : days <= 183 ? 'week' : 'month';
const unitLabels = { day: '天', week: '周', month: '月' };
export const planningBucketLabel = (days: number) => `每${unitLabels[granularity(days)]}汇总`;
const digits = new Intl.NumberFormat('zh-CN', { useGrouping: false, maximumFractionDigits: 1 });
const number = (value: number) => digits.format(value);
const signed = (value: number) => value > 0 ? `+${value}` : value < 0 ? `−${-value}` : '0';
const shortDate = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

const countKeys = ['created', 'imported', 'repaid', 'reopened', 'dropped', 'extinct', 'merged', 'transferredIn', 'transferredOut'] as const;
const flows = [
  { key: 'created', label: '新增', side: 1 },
  { key: 'reopened', label: '重开', side: 1 },
  { key: 'imported', label: '历史导入', side: 1 },
  { key: 'transferredIn', label: '转入', side: 1 },
  { key: 'repaid', label: '偿还', side: -1 },
  { key: 'extinct', label: '随功能消灭', side: -1 },
  { key: 'dropped', label: '失效', side: -1 },
  { key: 'merged', label: '合并', side: -1 },
  { key: 'transferredOut', label: '转出', side: -1 },
] as const;

function groupBuckets(days: PlanningStats['buckets'], unit: Granularity): Bucket[] {
  const groups = new Map<string | number, Bucket>();
  days.forEach((day, index) => {
    const date = new Date(day.day);
    const monday = date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY;
    const key = unit === 'day' ? index : unit === 'week' ? monday : day.day.slice(0, 7);
    const before = groups.get(key);
    if (!before) groups.set(key, { ...day, end: day.day });
    else {
      for (const kind of countKeys) before[kind] += day[kind];
      before.backlog = day.backlog;
      before.end = day.day;
    }
  });
  return [...groups.values()];
}

function scaleStep(value: number) {
  const order = 10 ** Math.floor(Math.log10(Math.max(1, value)));
  return [1, 2, 2.5, 5, 10].find(step => order * step >= value)! * order;
}

function timeTicks(length: number, maximum: number) {
  if (length <= maximum) return Array.from({ length }, (_, index) => index);
  return Array.from({ length: maximum }, (_, index) => Math.round(index * (length - 1) / (maximum - 1)));
}

function plotDomain(buckets: Bucket[], initial: number, mode: 'flow' | 'backlog') {
  if (mode === 'flow') {
    const peak = Math.max(0, ...buckets.flatMap(bucket => [
      bucket.created + bucket.reopened + bucket.imported + bucket.transferredIn,
      bucket.repaid + bucket.extinct + bucket.dropped + bucket.merged + bucket.transferredOut,
    ]));
    const top = Math.max(2, scaleStep(peak));
    return { low: -top, high: top, ticks: [-top, -top / 2, 0, top / 2, top] };
  }
  const values = [initial, ...buckets.map(bucket => bucket.backlog)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = scaleStep((max - min + 2) / 4);
  const low = Math.max(0, Math.floor((min - step) / step) * step);
  const high = Math.max(low + 2 * step, Math.ceil((max + step) / step) * step);
  const ticks = Array.from({ length: Math.round((high - low) / step) + 1 }, (_, index) => low + index * step);
  return { low, high, ticks };
}

function DebtChart({ buckets, initial, unit, mode }: { buckets: Bucket[]; initial: number; unit: Granularity; mode: 'flow' | 'backlog' }) {
  const plot = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(940);
  const [hovered, setHovered] = useState<number>();
  const [focused, setFocused] = useState<number>();
  useLayoutEffect(() => {
    const container = plot.current;
    if (!container) return;
    const measure = () => setWidth(Math.max(220, Math.round(container.getBoundingClientRect().width)));
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const index = hovered ?? focused;
  const selected = index === undefined ? undefined : buckets[index];
  const tooltip = useId();
  const flow = mode === 'flow';
  const compact = width < 520;
  const height = compact ? (flow ? 184 : 124) : (flow ? 298 : 178);
  const left = compact ? 32 : 43;
  const right = width - (compact ? (flow ? 19 : 43) : (flow ? 22 : 49));
  const top = 14;
  const bottom = height - 25;
  const band = (right - left) / Math.max(1, buckets.length);
  const barWidth = Math.min(21, band * 0.6);
  const { low, high, ticks } = plotDomain(buckets, initial, mode);
  const y = (value: number) => bottom - (value - low) * (bottom - top) / (high - low);
  const x = (i: number) => left + (i + (flow ? 0.5 : 1)) * band;
  const zero = y(0);
  const latest = buckets.at(-1)?.backlog ?? initial;
  const label = flow ? `每${unitLabels[unit]}新增、重开与偿还` : '未还积压走势';
  const reading = (bucket: Bucket) => `${bucket.day}${bucket.day === bucket.end ? '' : ` 至 ${bucket.end}`}`;
  const moveFocus = (event: KeyboardEvent<SVGRectElement>, i: number) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(buckets.length - 1, i + direction));
    event.currentTarget.ownerSVGElement?.querySelector<SVGRectElement>(`[data-bucket="${next}"]`)?.focus();
  };

  return <div className="ep-a-plot" data-compact={compact} ref={plot}>
      <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={label} onPointerLeave={() => setHovered(undefined)}>
        {ticks.map(value => <g key={value}>
          <line className="ep-a-gridline" data-zero={value === 0} x1={left} x2={right} y1={y(value)} y2={y(value)} />
          <text data-axis="value" x={left - 8} y={y(value) + 4} textAnchor="end">{number(flow ? Math.abs(value) : value)}</text>
        </g>)}
        {flow ? <>
          <text x={left + 6} y={top + 14}>流入 ↑</text>
          <text x={left + 6} y={bottom - 5}>流出 ↓</text>
          {buckets.map((bucket, i) => {
            let inflow = 0;
            let outflow = 0;
            return <g key={bucket.day}>{flows.map(({ key, side }) => {
              const value = bucket[key];
              if (!value) return null;
              const previous = side === 1 ? inflow : outflow;
              if (side === 1) inflow += value;
              else outflow -= value;
              const previousY = y(previous);
              const endY = y(previous + side * value);
              return <rect key={key} data-flow={key} x={x(i) - barWidth / 2} y={Math.min(previousY, endY)}
                width={barWidth} height={Math.abs(endY - previousY)} rx={2.2} />;
            })}</g>;
          })}
          <line className="ep-a-gridline" data-zero="true" x1={left} x2={right} y1={zero} y2={zero} />
        </> : <>
          <polyline className="ep-a-backlog-path" points={[`${left},${y(initial)}`, ...buckets.map((bucket, i) => `${x(i)},${y(bucket.backlog)}`)].join(' ')} />
          <circle className="ep-a-backlog-start" r={3.4} cx={left} cy={y(initial)} />
          <text x={left + 8} y={Math.max(top + 10, y(initial) - 8)}>期初 {initial}</text>
          <circle className="ep-a-backlog-end" r={4.2} cx={right} cy={y(latest)} />
          <text className="ep-a-last-value" x={right + 9} y={y(latest) + 4}>{latest}</text>
        </>}
        {timeTicks(buckets.length, compact ? 5 : 8).map(i => <text key={i} data-axis="time" x={x(i)} y={height - 6} textAnchor="middle">
          {unit === 'month' ? `${Number(buckets[i].day.slice(5, 7))}月` : shortDate(buckets[i].day)}
        </text>)}
        {buckets.map((bucket, i) => <rect key={bucket.day} className="ep-a-bucket-hit" data-bucket={i} data-day={bucket.day}
          role="button" aria-label={`${reading(bucket)}，期末未还 ${bucket.backlog} 笔`}
          aria-describedby={i === index ? tooltip : undefined} tabIndex={i === (focused ?? (buckets.length - 1)) ? 0 : -1}
          x={left + i * band} y={top} width={band} height={bottom - top} data-active={i === index}
          onPointerEnter={() => setHovered(i)} onClick={event => event.currentTarget.focus()}
          onFocus={() => setFocused(i)} onBlur={() => setFocused(undefined)} onKeyDown={event => moveFocus(event, i)} />)}
      </svg>
    {selected && index !== undefined && <div className="ep-a-chart-tooltip" id={tooltip} role="tooltip"
      style={index >= buckets.length / 2 ? { right: '2.5%' } : { left: '9%' }}>
      <strong>{reading(selected)}</strong>
      {(flow ? ['created', 'reopened', 'repaid', 'extinct'] as const : []).map(key =>
        <span key={key}>{flows.find(item => item.key === key)?.label}<b>{selected[key]}</b></span>)}
      {flow && flows.filter(({ key }) => !['created', 'reopened', 'repaid', 'extinct'].includes(key) && selected[key]).map(({ key, label }) =>
        <span key={key}>{label}<b>{selected[key]}</b></span>)}
      <span>期末未还<b>{selected.backlog}</b></span>
    </div>}
  </div>;
}

function activityLabel(event: PlanningAnalyticsActivity) {
  if (event.type === 'created') return '新增';
  if ('movement' in event && event.type === 'branch_moved') return event.movement === 'transferredIn' ? '转入分支' : '转出分支';
  if (event.collateral) return '连带偿还';
  return events[event.type];
}

function activityTone(type: PlanningAnalyticsActivity['type']) {
  if (type === 'created' || type === 'imported') return 'new';
  if (type === 'repaid') return 'paid';
  if (type === 'reopened') return 'reopened';
  return 'quiet';
}

function DebtNumber({ row, screen, onSelect }: {
  row: { debtId: string; title?: string }; screen: boolean; onSelect: SelectRecord;
}) {
  if (screen) return <span className="ep-a-id">{row.debtId}</span>;
  return <button type="button" className="ep-a-record-link" onClick={() => onSelect({ kind: 'debt', id: row.debtId })}>
    <span className="ep-a-id" title={row.debtId}>{shortId(row.debtId)}</span>
    {row.title && <span className="ep-a-record-title" title={row.title}>{row.title}</span>}
  </button>;
}

function ActivityList({ rows, screen, onSelect, empty }: {
  rows: PlanningAnalyticsActivity[]; screen: boolean; onSelect: SelectRecord; empty: string;
}) {
  if (!rows.length) return <p className="ep-a-empty">{empty}</p>;
  return <ul className="ep-a-feed">{rows.map(row => {
    const tone = activityTone(row.type);
    const Icon = tone === 'new' ? Plus : tone === 'paid' ? Check : tone === 'reopened' ? RotateCcw : History;
    return <li key={row.id}>
      <time dateTime={row.at}>{dateLabel(row.at)}</time>
      <span className="ep-a-event-mark" data-tone={tone}><Icon aria-hidden="true" /></span>
      <DebtNumber row={row} screen={screen} onSelect={onSelect} />
      <span className="ep-a-event-type">{activityLabel(row)}</span>
    </li>;
  })}</ul>;
}

function MeterRows({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map(row => row.value));
  return <ul className="ep-a-meter-rows">{rows.map(row => <li key={row.label}>
    <span>{row.label}</span><span className="ep-a-meter-track" aria-hidden="true"><i style={{ width: `${row.value / max * 100}%` }} /></span>
    <b>{row.value}</b>
  </li>)}</ul>;
}

function BacklogSpark({ values }: { values: number[] }) {
  const low = Math.min(...values);
  const range = Math.max(1, Math.max(...values) - low);
  const points = values.map((value, i) => `${2 + i * 82 / Math.max(1, values.length - 1)},${20 - (value - low) * 16 / range}`).join(' ');
  return <svg className="ep-a-spark" width="86" height="23" viewBox="0 0 86 23" role="img" aria-label={`未还从 ${values[0]} 笔至 ${values.at(-1)} 笔`}>
    <polyline points={points} />
  </svg>;
}

function EvolutionBreakdown({ data, screen, onSelect, projectLabel, buckets }: {
  data: PlanningStats; screen: boolean; onSelect: SelectRecord; projectLabel: string; buckets: Bucket[];
}) {
  const breakdown = data.breakdown;
  const outlook = data.outlook;
  const ages = ['0–30 天', '31–90 天', '91–180 天', '181–365 天', '一年以上'];
  const sourceRows = Object.entries(sourceLabels).flatMap(([key, label]) => {
    const value = breakdown?.sources[key as keyof typeof sourceLabels];
    return value ? [{ label, value }] : [];
  });
  return <div className="ep-a-evolution-more">
    <section className="ep-a-panel">
      <header className="ep-a-heading"><h2>近期展望</h2>{outlook && <span>截至 {outlook.through}</span>}</header>
      {!!outlook?.items.length && <>
        <p className="ep-a-outlook-count">计划偿还 <b>{outlook.repayments}</b> · 待回看 <b>{outlook.reviews}</b></p>
        <ul className="ep-a-outlook">{outlook.items.map(row => <li key={`${row.debtId}:${row.kind}`}>
          <time dateTime={row.date}>{shortDate(row.date)}</time>
          <DebtNumber row={row} screen={screen} onSelect={onSelect} />
          <span>{row.kind === 'review' ? '计划回看' : '计划偿还'}</span>
        </li>)}</ul>
      </>}
      {!outlook?.items.length && <p className="ep-a-empty">未来 30 天暂无已排定的偿还或回看</p>}
    </section>
    <section className="ep-a-panel">
      <header className="ep-a-heading"><h2>按项目</h2><span>{data.from} – {data.to}</span></header>
      <div className="ep-a-table-scroll"><table className="ep-a-summary-table">
        <thead><tr>{['项目', '未还', '新增', '偿还', '重开', '净变化', '到期回看', '积压走势'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody><tr><th scope="row">{projectLabel}</th><td>{data.backlogEnd}</td><td>{data.created}</td><td>{data.repaid}</td><td>{data.reopened}</td>
          <td>{signed(data.backlogEnd - data.backlogStart)}</td><td>{data.snapshot?.reviewDue ?? '—'}</td>
          <td><BacklogSpark values={[data.backlogStart, ...buckets.map(bucket => bucket.backlog)]} /></td></tr></tbody>
      </table></div>
    </section>
    <section className="ep-a-panel ep-a-breakdown">
      <header className="ep-a-heading"><h2>利息最高</h2><span>近 30 天被踩 {breakdown?.hits ?? 0} 次</span></header>
      {breakdown?.topHits.length ? <ul className="ep-a-outlook">{breakdown.topHits.map(row => <li key={row.debtId}>
        <DebtNumber row={row} screen={screen} onSelect={onSelect} /><b title={`累计 ${row.total} 次`}>{row.recent} 次</b>
      </li>)}</ul> : <p className="ep-a-empty">近 30 天暂无记下的踩坑</p>}
      <header className="ep-a-heading"><h2>未还债龄</h2><span>当前 {data.snapshot?.unpaid ?? data.backlogEnd} 笔</span></header>
      {breakdown ? <MeterRows rows={ages.map((label, i) => ({ label, value: breakdown.ages[i] }))} /> : <p className="ep-a-empty">暂无债龄统计</p>}
      <header className="ep-a-heading"><h2>期间新增来源</h2></header>
      {sourceRows.length ? <MeterRows rows={sourceRows} /> : <p className="ep-a-empty">期间暂无新增债务</p>}
      <header className="ep-a-heading"><h2>未还优先级</h2></header>
      <ul className="ep-a-priorities">{(['high', 'mid', 'low'] as const).map(priority => <li key={priority} data-priority={priority}>
        <span>{priorityLabels[priority]}</span><strong>{breakdown?.priorities[priority] ?? '—'}</strong>
      </li>)}</ul>
    </section>
  </div>;
}

export function PlanningEvolution({ data, screen, onSelect, onReviewDue, projectLabel = data.projectId }: {
  data: PlanningStats; screen: boolean; onSelect: SelectRecord; onReviewDue?: () => void; projectLabel?: string;
}) {
  const unit = granularity(data.buckets.length);
  const buckets = useMemo(() => groupBuckets(data.buckets, unit), [data.buckets, unit]);
  const change = data.backlogEnd - data.backlogStart;
  const trend = change > 0 ? '上升' : change < 0 ? '下降' : '持平';
  const percent = data.backlogStart ? ` · ${digits.format(change * 100 / data.backlogStart)}%（较期初）` : '';
  const Trend = change > 0 ? TrendingUp : change < 0 ? TrendingDown : ArrowRight;
  const metrics: { label: string; value: ReactNode; detail: string; swatch?: string; tone?: string; action?: () => void }[] = [
    { label: '期间新增', value: data.created, detail: data.imported ? `另有 ${data.imported} 笔历史导入` : '笔', swatch: 'created' },
    { label: '期间偿还', value: data.repaid, detail: `另有 ${data.extinct} 笔随功能消灭、${data.dropped} 笔失效${data.merged ? `、${data.merged} 笔合并` : ''}`, swatch: 'repaid' },
    { label: '期间重开', value: data.reopened, detail: '已关闭后复发', swatch: 'reopened' },
    { label: '当前未还', value: data.backlogEnd, detail: `期初 ${data.backlogStart}${data.snapshot ? ` · 其中处理中 ${data.snapshot.inProgress}` : ''}` },
    { label: '积压走势', value: <><Trend aria-hidden="true" />{trend}</>, detail: `${signed(change)} 笔${percent}`, tone: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' },
    { label: '到期待回看', value: data.snapshot?.reviewDue ?? '—',
      detail: data.snapshot ? `计划逾期 ${data.snapshot.overdue}${data.snapshot.pendingVerification === undefined ? '' : ` · 待认证 ${data.snapshot.pendingVerification}`}` : '等待当前状态',
      action: screen ? undefined : onReviewDue },
  ];
  const legend = flows.filter(({ key }) => ['created', 'reopened', 'repaid', 'extinct'].includes(key) || data[key]);

  return <div className="ep-a-evolution" data-projection={screen} aria-label="债务演进">
    <div className="ep-a-kpis">{metrics.map(metric => <article className="ep-a-kpi" key={metric.label}>
      <h2>{metric.swatch && <i data-flow={metric.swatch} aria-hidden="true" />}
        {metric.action ? <button type="button" className="ep-a-link" onClick={metric.action}>{metric.label}</button> : metric.label}
      </h2>
      <strong data-kpi-value data-tone={metric.tone}>{metric.value}</strong>
      <p>{metric.detail}</p>
    </article>)}</div>
    <div className="ep-a-evolution-stage">
      <section className="ep-a-panel ep-a-charts">
        <header className="ep-a-heading"><h2>流入与流出</h2>
          <ul className="ep-a-legend" aria-label="流入与流出图例">{legend.map(({ key, label }) =>
            <li key={key} title={key === 'imported' ? '采用原发现日期，缺失时采用入账日' : undefined}><i data-flow={key} aria-hidden="true" />{label}</li>)}</ul>
        </header>
        <DebtChart key={`flow:${data.from}:${data.to}`} buckets={buckets} initial={data.backlogStart} unit={unit} mode="flow" />
        <header className="ep-a-heading"><h2>未还积压</h2><span>{planningBucketLabel(data.buckets.length)} · 笔</span></header>
        <DebtChart key={`backlog:${data.from}:${data.to}`} buckets={buckets} initial={data.backlogStart} unit={unit} mode="backlog" />
      </section>
      <section className="ep-a-panel ep-a-evolution-recent">
        <header className="ep-a-heading"><h2>最近变化</h2>{screen && <span>仅显示编号</span>}</header>
        <ActivityList rows={data.recent ?? []} onSelect={onSelect} screen={screen} empty="这段时间没有债务状态变化" />
      </section>
    </div>
    <EvolutionBreakdown data={data} screen={screen} onSelect={onSelect} projectLabel={projectLabel} buckets={buckets} />
  </div>;
}

type GraphPath = string[];
type GraphNode = { name: string; path: GraphPath; records: PlanningGraphDebt[]; children: GraphNode[] };
type GraphLayout = { node: GraphNode; start: number; end: number; depth: number };
type Dimension = 'priority' | 'module' | 'status' | 'owner' | 'project' | 'source';
type ColorMode = 'category' | 'overdue' | 'hits' | 'fresh' | 'reopened' | 'collateral' | 'extinct';
type GraphPeriod = 'visit' | '7' | '30' | '90';

const lifeLabels: Record<PlanningGraphOutcome, string> = {
  unpaid: '未还', repaid: '主动偿还', collateral: '连带偿还', extinct: '随功能消灭', merged: '合并', cancelled: '取消或替代',
};
const outcomes = Object.keys(lifeLabels) as PlanningGraphOutcome[];
const dimensionLabels: Record<Dimension, string> = { priority: '优先级', module: '模块', status: '状态', owner: '负责人', project: '项目', source: '来源' };
const colorLabels: Record<ColorMode, string> = {
  category: '分类', overdue: '逾期或待回看占比', hits: '近 30 天每笔被踩', fresh: '近 30 天发现占比', reopened: '复发率',
  collateral: '连带偿还占比', extinct: '随功能消灭占比',
};
const graphPalette = ['series-1', 'series-2', 'warn', 'series-4', 'graph-call', 'group-green', 'series-net', 'series-5', 'group-purple'];
const categoryTokens = new Map([
  ['性能', 'series-1'], ['体验', 'series-2'], ['数据', 'warn'], ['架构', 'series-4'], ['前端', 'graph-call'],
  ['测试', 'group-green'], ['可观测性', 'series-net'], ['安全', 'series-5'], ['依赖', 'group-purple'],
  ['可靠性', 'bad'], ['成本', 'series-3'], ['未分类', 'group-gray'],
]);
const defaultGroup = '未分类';
const graphKey = (path: GraphPath) => JSON.stringify(path);
const within = (prefix: GraphPath, path: GraphPath) => prefix.every((part, index) => part === path[index]);
const contract = (value: string, limit: number) => value.length > limit ? `${value.slice(0, Math.max(1, limit - 1))}…` : value;
const tagsOf = (tags: string[]) => tags.length ? tags : [defaultGroup];
const groupOf = (tag: string) => tag.split('/')[0];
const labelOf = (tag: string) => tag.split('/').slice(1).join('/') || tag;
const overdueOrReview = (row: PlanningGraphDebt) => row.overdue || row.reviewDue;

function categoryColor(category: string) {
  const named = categoryTokens.get(category);
  if (named) return named;
  let position = 0;
  for (const character of category) position = (position * 31 + character.codePointAt(0)!) % graphPalette.length;
  return graphPalette[position];
}

function displayPath(path: GraphPath) {
  return path.map((part, i) => i === 1 ? labelOf(part) : part).join(' / ');
}

function splitRecords(records: PlanningGraphDebt[], values: (record: PlanningGraphDebt) => Iterable<string>) {
  const groups = new Map<string, PlanningGraphDebt[]>();
  for (const record of records) {
    for (const value of new Set(values(record))) {
      const group = groups.get(value);
      if (group) group.push(record);
      else groups.set(value, [record]);
    }
  }
  return [...groups].sort(([leftName, left], [rightName, right]) => right.length - left.length || leftName.localeCompare(rightName, 'zh-CN'));
}

function dimensionValue(row: PlanningGraphDebt, dimension: Dimension, projectLabel: string) {
  switch (dimension) {
    case 'priority': return priorityLabels[row.priority];
    case 'module': return row.module || '未标模块';
    case 'status': return debtLabels[row.status];
    case 'owner': return row.owner || '待认领';
    case 'project': return projectLabel;
    case 'source': return sourceLabels[row.source];
  }
}

function buildGraph(records: PlanningGraphDebt[], dimension: Dimension, projectLabel: string): GraphNode {
  const children = splitRecords(records, row => tagsOf(row.tags).map(groupOf)).map(([group, groupRecords]) => {
    const tags = splitRecords(groupRecords, row => tagsOf(row.tags).filter(tag => groupOf(tag) === group)).map(([tag, tagged]) => ({
      name: labelOf(tag), path: [group, tag], records: tagged,
      children: splitRecords(tagged, row => [dimensionValue(row, dimension, projectLabel)]).map(([value, rows]) => ({
        name: value, path: [group, tag, value], records: rows, children: [],
      })),
    }));
    return { name: group, path: [group], records: groupRecords, children: tags };
  });
  return { name: '全部', path: [], records, children };
}

function graphLayout(root: GraphNode) {
  const placements: GraphLayout[] = [];
  function walk(node: GraphNode, start: number, end: number, depth: number) {
    placements.push({ node, start, end, depth });
    const total = node.children.reduce((sum, child) => sum + child.records.length, 0);
    let position = start;
    for (const child of node.children) {
      const next = position + (end - start) * child.records.length / total;
      walk(child, position, next, depth + 1);
      position = next;
    }
  }
  walk(root, 0, 1, 0);
  return placements;
}

function nodeMetric(node: GraphNode, mode: ColorMode) {
  const records = node.records;
  switch (mode) {
    case 'category': return 0;
    case 'overdue': return records.filter(overdueOrReview).length / Math.max(1, records.length);
    case 'hits': return records.reduce((sum, row) => sum + row.recentHits, 0) / Math.max(1, records.length);
    case 'fresh': return records.filter(row => row.recentlyCreated).length / Math.max(1, records.length);
    case 'reopened': return records.filter(row => row.reopened).length / Math.max(1, records.length);
    case 'collateral': return records.filter(row => row.outcome === 'collateral').length / Math.max(1, records.length);
    case 'extinct': return records.filter(row => row.outcome === 'extinct').length / Math.max(1, records.length);
  }
}

function activation(event: KeyboardEvent<SVGElement>, action: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  action();
}

type GraphDrawingProps = {
  root: GraphNode;
  active: GraphPath;
  scopeLabel: string;
  life: string;
  delta?: number;
  changes: Map<string, number>;
  fill: (node: GraphNode) => string;
  onSelect: (path: GraphPath) => void;
  onZoom: (path: GraphPath) => void;
  onBack: () => void;
};

function arc(start: number, end: number, inner: number, outer: number, center: number) {
  const turn = 2 * Math.PI;
  const pad = Math.min(0.0035, (end - start) * turn / 5);
  const a = start * turn + pad - Math.PI / 2;
  const b = end * turn - pad - Math.PI / 2;
  const point = (angle: number, radius: number) => `${(center + Math.cos(angle) * radius).toFixed(3)} ${(center + Math.sin(angle) * radius).toFixed(3)}`;
  const large = b - a > Math.PI ? 1 : 0;
  return `M ${point(a, outer)} A ${outer} ${outer} 0 ${large} 1 ${point(b, outer)} L ${point(b, inner)} A ${inner} ${inner} 0 ${large} 0 ${point(a, inner)} Z`;
}

function nodeState(path: GraphPath, selected: GraphPath) {
  if (!selected.length) return '';
  if (graphKey(path) === graphKey(selected)) return 'active';
  return within(path, selected) || within(selected, path) ? '' : 'muted';
}

function graphNodeLabel(node: GraphNode, change?: number) {
  return `${displayPath(node.path) || '全部'}：${node.records.length} 笔${change ? `，较对比起点 ${signed(change)}` : ''}`;
}

function Sunburst({ root, active, scopeLabel, life, delta, changes, fill, onSelect, onZoom, onBack }: GraphDrawingProps) {
  const layout = graphLayout(root);
  const maxDepth = layout.reduce((maximum, entry) => Math.max(maximum, entry.depth), 1);
  const center = 250;
  const inner = 82;
  const ring = (243 - inner) / maxDepth;
  const rootFocus = root.path.length > 0;
  const rootTitle = rootFocus ? root.name : scopeLabel;
  return <svg className="ep-a-sun" viewBox="0 0 500 500" role="group" aria-label="分类旭日图">
    {layout.filter(entry => entry.depth).map(({ node, start, end, depth }) => {
      const key = graphKey(node.path);
      const r0 = inner + (depth - 1) * ring + 2;
      const r1 = inner + depth * ring - 1;
      const middle = (start + end) * Math.PI - Math.PI / 2;
      const radius = (r0 + r1) / 2;
      const x = center + Math.cos(middle) * radius;
      const y = center + Math.sin(middle) * radius;
      const arcWidth = (end - start) * Math.PI * 2 * radius;
      const change = changes.get(key);
      return <g key={key} className="ep-a-graph-node" data-state={nodeState(node.path, active)}>
        <path className="ep-a-arc" d={arc(start, end, r0, r1, center)} fill={fill(node)} tabIndex={0}
          role="button" aria-label={graphNodeLabel(node, change)} aria-pressed={key === graphKey(active)}
          onClick={() => onSelect(node.path)} onDoubleClick={node.children.length ? () => onZoom(node.path) : undefined}
          onKeyDown={event => activation(event, () => onSelect(node.path))}>
          <title>{graphNodeLabel(node, change)}</title>
        </path>
        {depth <= 2 && arcWidth > 31 && <g className="ep-a-segment-label" aria-hidden="true">
          <text x={x} y={y - 2} textAnchor="middle">{contract(node.name, Math.max(2, Math.floor(arcWidth / 11)))}</text>
          <text x={x} y={y + 12} textAnchor="middle">{node.records.length}{change ? ` ${signed(change)}` : ''}</text>
        </g>}
      </g>;
    })}
    <g className="ep-a-sun-center" role={rootFocus ? 'button' : undefined} tabIndex={rootFocus ? 0 : undefined}
      aria-label={rootFocus ? '返回上一层' : undefined} onClick={rootFocus ? onBack : undefined}
      onKeyDown={rootFocus ? event => activation(event, onBack) : undefined}>
      <circle cx={center} cy={center} r={78} />
      <text className="ep-a-sun-label" textAnchor="middle" x={center} y={center - 29}>{contract(rootTitle, 13)}</text>
      <text className="ep-a-sun-total" data-graph-total={root.records.length} textAnchor="middle" x={center} y={center + 12}>{root.records.length}</text>
      <text className="ep-a-sun-label" textAnchor="middle" x={center} y={center + 33}>笔 · {life}</text>
      {delta !== undefined && <text data-tone={delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'} textAnchor="middle" x={center} y={center + 51}>
        {delta ? `${signed(delta)} 较对比起点` : '较对比起点持平'}
      </text>}
    </g>
  </svg>;
}

function Pyramid({ root, active, changes, fill, onSelect, onZoom, onBack }: GraphDrawingProps) {
  const layout = graphLayout(root);
  const depth = layout.reduce((maximum, entry) => Math.max(maximum, entry.depth), 0);
  const width = 920;
  const row = 56;
  const stride = row + 28;
  const position = (level: number, fraction: number) => {
    const span = width * (0.31 + 0.67 * level / Math.max(1, depth));
    return ((width - span) / 2) + span * fraction;
  };
  const y = (level: number) => 4 + stride * level;
  return <div className="ep-a-pyramid-scroll"><svg className="ep-a-pyramid" viewBox={`0 0 ${width} ${y(depth) + row + 4}`} role="group" aria-label="分类金字塔">
    {layout.filter(entry => entry.depth).map(({ node, start, end, depth: level }) => {
      const previous = y(level - 1) + row;
      return <path key={graphKey(node.path)} className="ep-a-pyramid-link" d={
        `M ${position(level - 1, start)} ${previous} L ${position(level - 1, end)} ${previous} L ${position(level, end)} ${y(level)} L ${position(level, start)} ${y(level)} Z`
      } />;
    })}
    {layout.map(({ node, start, end, depth: level }) => {
      const key = graphKey(node.path);
      const a = position(level, start);
      const b = position(level, end);
      const available = b - a;
      const x = (a + b) / 2;
      const change = changes.get(key);
      const action = level === 0 && root.path.length ? onBack : () => onSelect(node.path);
      const hasName = available >= 52;
      return <g className="ep-a-graph-node ep-a-pyramid-node" data-state={nodeState(node.path, active)} key={key}>
        <rect x={a + Math.min(1, available / 4)} y={y(level)} width={Math.max(0.1, available - 2)} height={row}
          rx={Math.min(5, available / 4)} fill={level ? fill(node) : 'hsl(var(--surface-sunken))'} role="button" tabIndex={0}
          aria-pressed={key === graphKey(active)} aria-label={level === 0 && root.path.length ? '返回上一层' : graphNodeLabel(node, change)}
          onClick={action} onDoubleClick={level > 0 && node.children.length ? () => onZoom(node.path) : undefined}
          onKeyDown={event => activation(event, action)}><title>{graphNodeLabel(node, change)}</title></rect>
        <g className="ep-a-segment-label" aria-hidden="true">
          {hasName && <text x={x} y={y(level) + 22} textAnchor="middle">{contract(node.name, Math.floor(available / 19))}</text>}
          {(available > 34 || !level) && <text data-graph-total={level ? undefined : node.records.length} x={x}
            y={y(level) + (hasName ? 43 : 34)} textAnchor="middle">{node.records.length}{change ? ` ${signed(change)}` : ''}</text>}
        </g>
      </g>;
    })}
  </svg></div>;
}

function changeMap(rows: PlanningGraphChange[]) {
  const categories = new Map<string, { path: GraphPath; delta: number }>();
  for (const row of rows) {
    const tags = tagsOf(row.tags);
    const groups = [...new Set(tags.map(groupOf))];
    const paths = [...groups.map(group => [group]), ...tags.map(tag => [groupOf(tag), tag])];
    for (const path of paths) {
      const key = graphKey(path);
      const previous = categories.get(key);
      categories.set(key, { path, delta: (previous?.delta ?? 0) + row.delta });
    }
  }
  return categories;
}

function GraphComparison({ rows, since, label, categories, currentNodes, onSelect, onRecord }: {
  rows: PlanningGraphChange[]; since: string; label: string; categories: ReturnType<typeof changeMap>;
  currentNodes: Map<string, GraphNode>; onSelect: (path: GraphPath) => void; onRecord: SelectRecord;
}) {
  const changed = [...categories.values()].filter(item => item.delta && item.path.length === 2)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.path[1].localeCompare(b.path[1], 'zh-CN')).slice(0, 5);
  const maximum = Math.max(1, ...changed.map(item => Math.abs(item.delta)));
  const counts = rows.reduce((result, row) => {
    const key = row.collateral ? 'collateral' : row.movement;
    return result.set(key, (result.get(key) ?? 0) + row.delta);
  }, new Map<keyof PlanningCounts | 'collateral', number>());
  const tiles = [
    ['created', '新增', 'up'], ['repaid', '主动偿还', 'down'], ['collateral', '连带偿还', 'down'],
    ['extinct', '随功能消灭', 'quiet'], ['merged', '合并', 'quiet'], ['reopened', '复发', 'reopened'],
  ] as const;
  const extra = flows.filter(({ key }) => ['imported', 'dropped', 'transferredIn', 'transferredOut'].includes(key) && counts.has(key));
  return <section className="ep-a-panel ep-a-changes" aria-label="变化动态">
    <header className="ep-a-heading"><h2><i aria-hidden="true" />自{label}以来</h2><span>{dateLabel(since)} → 现在</span></header>
    <div className="ep-a-change-tiles">{tiles.map(([key, name, tone]) => <div key={key}>
      <strong data-tone={counts.get(key) ? tone : 'quiet'}>{signed(counts.get(key) ?? 0)}</strong><span>{name}</span>
    </div>)}</div>
    {extra.length > 0 && <p className="ep-a-compare-extra">{extra.map(({ key, label: name }) => `${name} ${signed(counts.get(key) ?? 0)}`).join(' · ')}</p>}
    <div className="ep-a-change-group"><h3>变化最大的分类</h3>
      {changed.length ? <ul className="ep-a-meter-rows">{changed.map(({ path, delta }) => {
        const name = labelOf(path[1]);
        const key = graphKey(path);
        return <li key={key}>
          {currentNodes.has(key) ? <button type="button" className="ep-a-link" title={displayPath(path)} onClick={() => onSelect(path)}>{name}</button>
            : <span title={displayPath(path)}>{name}</span>}
          <span className="ep-a-meter-track" aria-hidden="true"><i data-tone={delta > 0 ? 'up' : 'down'} style={{ width: `${Math.abs(delta) / maximum * 100}%` }} /></span>
          <b data-tone={delta > 0 ? 'up' : 'down'}>{signed(delta)}</b>
        </li>;
      })}</ul> : <p className="ep-a-empty">这段时间分类的未还数量持平</p>}
    </div>
    <div className="ep-a-change-group"><h3>动态 <span>{rows.length} 条</span></h3>
      <ActivityList rows={rows.slice(0, 12)} screen={false} onSelect={onRecord} empty="这段时间没有新变化" />
    </div>
  </section>;
}

function graphTagCounts(records: PlanningGraphDebt[]) {
  const counts = new Map<string, number>();
  for (const row of records) {
    for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a, left], [b, right]) => right - left || a.localeCompare(b, 'zh-CN')).slice(0, 8);
}

function Cooccurrences({ records, pair, onPair }: {
  records: PlanningGraphDebt[]; pair?: [string, string]; onPair: (pair: [string, string] | undefined) => void;
}) {
  const labels = graphTagCounts(records);
  const cells = labels.map(([a, count], i) => labels.map(([b], j) =>
    i === j ? count : i < j ? records.filter(row => row.tags.includes(a) && row.tags.includes(b)).length : 0));
  const max = Math.max(1, ...cells.flatMap((row, i) => row.slice(i + 1)));

  return <section className="ep-a-panel ep-a-cooccurrence">
    <header className="ep-a-heading"><h2>标签共现</h2><span>同时带有两个标签的债务数</span></header>
    {labels.length ? <div className="ep-a-table-scroll"><table>
      <thead><tr><td></td>{labels.map(([tag]) => <th scope="col" key={tag} title={tag}>{tag}</th>)}</tr></thead>
      <tbody>{labels.map(([tag], i) => <tr key={tag}><th scope="row" title={tag}>{tag}</th>
        {labels.map(([other], j) => {
          const value = cells[i][j];
          const pressed = pair?.[0] === tag && pair[1] === other;
          return <td key={other} data-diagonal={i === j}>
            {i === j ? value : i < j && value > 0 ? <button type="button" aria-pressed={pressed}
              aria-label={`同时带「${tag}」和「${other}」：${value} 笔`} onClick={() => onPair(pressed ? undefined : [tag, other])}
              style={{ background: `color-mix(in oklab, hsl(var(--info-soft)), hsl(var(--info)) ${20 + value * 38 / max}%)` }}>
              {value}
            </button> : i < j ? <span aria-label="0 笔">—</span> : null}
          </td>;
        })}
      </tr>)}</tbody>
    </table></div> : <p className="ep-a-empty">当前范围没有可用于共现的标签</p>}
  </section>;
}

function GraphSelection({ node, focus, pair, onFocus, onChild, onRecord, openCategory }: {
  node: GraphNode;
  focus: GraphPath;
  pair?: [string, string];
  onFocus: (path: GraphPath) => void;
  onChild: (path: GraphPath) => void;
  onRecord: SelectRecord;
  openCategory?: () => void;
}) {
  const rows = node.records;
  const overdue = rows.filter(overdueOrReview).length;
  const reopened = rows.filter(row => row.reopened).length;
  const hits = rows.reduce((sum, row) => sum + row.recentHits, 0);
  const priorityOrder = { high: 0, mid: 1, low: 2 };
  const first = [...rows].sort((a, b) => Number(overdueOrReview(b)) - Number(overdueOrReview(a))
    || priorityOrder[a.priority] - priorityOrder[b.priority] || a.title.localeCompare(b.title, 'zh-CN')).slice(0, 8);
  return <section className="ep-a-panel ep-a-graph-selection" aria-label="选中分类的债务">
    <header className="ep-a-heading">
      <h2>{pair ? `${pair[0]} × ${pair[1]}` : displayPath(node.path) || '全部分类'}</h2>
      {!pair && node.path.length > focus.length && !!node.children.length && <button type="button" className="ep-button" onClick={() => onFocus(node.path)}>以它为中心</button>}
    </header>
    <dl className="ep-a-selection-stats">
      <div><dt>债务</dt><dd>{rows.length} 笔</dd></div>
      <div><dt>逾期或待回看</dt><dd>{rows.length ? Math.round(overdue * 100 / rows.length) : 0}%</dd></div>
      <div><dt>复发过</dt><dd>{reopened} 笔</dd></div>
      <div><dt>近 30 天被踩</dt><dd>{hits} 次</dd></div>
    </dl>
    {!pair && node.path.length > 0 && node.children.length > 0 && <ul className="ep-a-child-list" aria-label="下一层分类">
      {node.children.map(child => <li key={graphKey(child.path)}>
        <button type="button" className="ep-a-link" onClick={() => onChild(child.path)}>{child.name} {child.records.length}</button>
      </li>)}
    </ul>}
    {first.length > 0 ? <ul className="ep-a-outlook">{first.map(row => <li key={row.id}>
      <DebtNumber row={{ debtId: row.id, title: row.title }} screen={false} onSelect={onRecord} />
      <span>{row.reviewDue ? '到期回看' : row.overdue ? '计划逾期' : lifeLabels[row.outcome]}</span>
    </li>)}</ul> : <p className="ep-a-empty">当前筛选没有符合条件的债务</p>}
    {openCategory && <button type="button" className="ep-button" onClick={openCategory}>在清单中查看 <ChevronRight /></button>}
  </section>;
}

type PlanningGraphProps = {
  data: PlanningStats;
  onSelect: SelectRecord;
  onCategory?: (tag: string, outcome: PlanningGraphOutcome | 'all', exact?: boolean) => void;
  scopeLabel?: string;
  projectLabel?: string;
};

function GraphContent({ graph, scopeLabel, projectLabel, onSelect, onCategory, sessionKey }: {
  graph: NonNullable<PlanningStats['graph']>;
  scopeLabel: string;
  projectLabel: string;
  onSelect: SelectRecord;
  onCategory: PlanningGraphProps['onCategory'];
  sessionKey: string;
}) {
  const [view, setView] = useState<'sun' | 'pyramid'>('sun');
  const [dimension, setDimension] = useState<Dimension>('priority');
  const [color, setColor] = useState<ColorMode>('category');
  const [period, setPeriod] = useState<GraphPeriod>('visit');
  const [selectedOutcomes, setSelectedOutcomes] = useState<PlanningGraphOutcome[]>(['unpaid']);
  const [reopenedOnly, setReopenedOnly] = useState(false);
  const [focus, setFocus] = useState<GraphPath>([]);
  const [selected, setSelected] = useState<GraphPath>([]);
  const [pair, setPair] = useState<[string, string]>();
  const [previousVisit] = useState(() => {
    try { return Date.parse(window.localStorage.getItem(sessionKey) ?? ''); } catch { return NaN; }
  });

  useEffect(() => {
    try { window.localStorage.setItem(sessionKey, graph.asOf); } catch { /* storage can be unavailable */ }
  }, [sessionKey, graph.asOf]);

  const asOf = Date.parse(graph.asOf);
  const hasPrevious = Number.isFinite(previousVisit) && previousVisit < asOf && previousVisit >= asOf - 90 * DAY;
  const baseline = period === 'visit' && hasPrevious ? previousVisit : asOf - (period === 'visit' ? 7 : Number(period)) * DAY;
  const since = new Date(baseline).toISOString();
  const comparisonLabel = period === 'visit' && hasPrevious ? '上次查看' : `${period === 'visit' ? 7 : period} 天前`;
  const changes = useMemo(() => graph.changes.filter(row => row.at > since), [graph.changes, since]);
  const categoryChanges = useMemo(() => changeMap(changes), [changes]);
  const lifeCounts = useMemo(() => graph.debts.reduce((result, row) =>
    result.set(row.outcome, (result.get(row.outcome) ?? 0) + 1), new Map<PlanningGraphOutcome, number>()), [graph.debts]);
  const records = useMemo(() => graph.debts.filter(row => selectedOutcomes.includes(row.outcome) && (!reopenedOnly || row.reopened)),
    [graph.debts, selectedOutcomes, reopenedOnly]);
  const tree = useMemo(() => buildGraph(records, dimension, projectLabel), [records, dimension, projectLabel]);
  const nodes = useMemo(() => new Map(graphLayout(tree).map(({ node }) => [graphKey(node.path), node])), [tree]);
  const root = nodes.get(graphKey(focus)) ?? tree;
  const node = pair ? { name: '共现', path: [], children: [], records: records.filter(row => pair.every(tag => row.tags.includes(tag))) }
    : nodes.get(graphKey(selected)) ?? root;
  const showDeltas = selectedOutcomes.length === 1 && selectedOutcomes[0] === 'unpaid' && !reopenedOnly;
  const nodeChanges = useMemo(() => showDeltas ? new Map([...categoryChanges].map(([key, change]) => [key, change.delta])) : new Map<string, number>(),
    [categoryChanges, showDeltas]);
  const groupColors = useMemo(() => {
    const groups = new Set(graph.debts.flatMap(row => tagsOf(row.tags).map(groupOf)));
    return new Map([...groups].map(group => [group, categoryColor(group)]));
  }, [graph.debts]);
  const colorMaximum = color === 'category' ? 0 : [...nodes.values()].reduce((max, row) => Math.max(max, nodeMetric(row, color)), 0);
  const fill = (target: GraphNode) => {
    if (color !== 'category') {
      const percent = 15 + 72 * nodeMetric(target, color) / Math.max(1e-9, colorMaximum);
      return `color-mix(in oklab, hsl(var(--surface-raised)), hsl(var(--primary)) ${percent}%)`;
    }
    const key = groupColors.get(target.path[0]) ?? 'group-gray';
    const tint = target.path.length <= 1 ? 100 : target.path.length === 2 ? 73 : 47;
    return `color-mix(in oklab, hsl(var(--surface-raised)), hsl(var(--${key})) ${tint}%)`;
  };
  const choose = (path: GraphPath) => {
    if (!within(root.path, path)) setFocus([]);
    setSelected(path);
    setPair(undefined);
  };
  const zoom = (path: GraphPath) => {
    setFocus(path);
    setSelected(path);
    setPair(undefined);
  };
  const reset = () => zoom([]);
  const filterOutcome = (outcome: PlanningGraphOutcome) => {
    if (selectedOutcomes.length === 1 && selectedOutcomes[0] === outcome) return;
    setSelectedOutcomes(current => current.includes(outcome) ? current.filter(value => value !== outcome) : [...current, outcome]);
    reset();
  };
  const legend = color === 'category' ? tree.children : [];
  const tag = node.path[1] ?? node.path[0];
  const exactOutcome = selectedOutcomes.length === 1 ? selectedOutcomes[0] : selectedOutcomes.length === outcomes.length ? 'all' : undefined;
  const openCategory = onCategory && tag && !pair && !reopenedOnly && node.path.length < 3 && exactOutcome
    ? () => onCategory(tag, exactOutcome, node.path.length === 2) : undefined;
  let delta: number | undefined;
  if (showDeltas && root.path.length < 3) {
    delta = root.path.length ? nodeChanges.get(graphKey(root.path)) ?? 0 : changes.reduce((sum, row) => sum + row.delta, 0);
  }
  const drawing: GraphDrawingProps = {
    root, active: pair ? [] : node.path, scopeLabel, life: selectedOutcomes.length === 1 ? lifeLabels[selectedOutcomes[0]] : '已选结局',
    delta, changes: nodeChanges, fill, onSelect: choose, onZoom: zoom, onBack: () => zoom(root.path.slice(0, -1)),
  };
  const layers = ['标签组', '标签', dimensionLabels[dimension]].slice(root.path.length).join('、');

  return <section className="ep-a-graph" aria-label="债务分类图谱">
    <div className="ep-a-graph-controls">
      <div className="ep-a-outcomes" role="group" aria-label="看哪些债务">
        {outcomes.map(outcome => <button type="button" className="ep-a-chip" key={outcome}
          aria-pressed={selectedOutcomes.includes(outcome)} onClick={() => filterOutcome(outcome)}>
          {lifeLabels[outcome]} <span>{lifeCounts.get(outcome) ?? 0}</span>
        </button>)}
        <button type="button" className="ep-a-chip" aria-pressed={reopenedOnly} onClick={() => { setReopenedOnly(value => !value); reset(); }}>
          <RotateCcw aria-hidden="true" />只看复发过
        </button>
      </div>
      <div className="ep-a-graph-display">
        <div className="ep-a-seg" role="group" aria-label="图谱视图">
          <button type="button" aria-pressed={view === 'sun'} onClick={() => setView('sun')}>旭日</button>
          <button type="button" aria-pressed={view === 'pyramid'} onClick={() => setView('pyramid')}>金字塔</button>
        </div>
        <label><span className="sr-only">着色</span><select aria-label="着色" value={color} onChange={event => setColor(event.target.value as ColorMode)}>
          {Object.entries(colorLabels).map(([value, label]) => <option value={value} key={value}>着色：{label}</option>)}
        </select></label>
        <label><span className="sr-only">外圈</span><select aria-label="外圈" value={dimension} onChange={event => {
          setDimension(event.target.value as Dimension);
          if (selected.length === 3) setSelected(selected.slice(0, 2));
        }}>
          {Object.entries(dimensionLabels).map(([value, label]) => <option value={value} key={value}>外圈：{label}</option>)}
        </select></label>
        <label><span className="sr-only">对比</span><select aria-label="对比" value={period} onChange={event => setPeriod(event.target.value as GraphPeriod)}>
          <option value="visit">对比上次查看</option>
          {(['7', '30', '90'] as const).map(days => <option value={days} key={days}>对比 {days} 天前</option>)}
        </select></label>
      </div>
    </div>
    <div className="ep-a-graph-stage">
      <div className="ep-a-panel ep-a-visual">
        <header className="ep-a-heading">
          <nav className="ep-a-crumbs" aria-label="图谱当前层级">
            <button type="button" className="ep-a-link" onClick={reset} aria-current={root.path.length === 0 ? 'page' : undefined}>全部 {tree.records.length}</button>
            {root.path.map((part, index) => <span key={graphKey(root.path.slice(0, index + 1))}>
              <ChevronRight aria-hidden="true" /><button type="button" className="ep-a-link" onClick={() => zoom(root.path.slice(0, index + 1))}
                aria-current={index === root.path.length - 1 ? 'page' : undefined}>{index === 1 ? labelOf(part) : part}</button>
            </span>)}
            {root.path.length > 0 && <button type="button" className="ep-a-link" onClick={drawing.onBack}><ArrowLeft aria-hidden="true" />返回上一层</button>}
          </nav>
          {legend.length > 0 && <ul className="ep-a-legend ep-a-graph-legend" aria-label="分类图例">{legend.map(group =>
            <li key={group.name}>
              <button type="button" className="ep-a-link" onClick={() => choose(group.path)}><i style={{ background: fill(group) }} aria-hidden="true" />{group.name}</button>
            </li>)}</ul>}
          {color !== 'category' && <div className="ep-a-ramp"><i aria-hidden="true" />{colorLabels[color]}
            {' '}0 – {color === 'hits' ? number(colorMaximum) : `${number(colorMaximum * 100)}%`}</div>}
        </header>
        {view === 'sun' ? <Sunburst {...drawing} /> : <Pyramid {...drawing} />}
        <p className="ep-a-figure-note">
          {records.length ? <>{view === 'sun' ? '由内向外' : '由上向下'}依次为{layers}。同一笔债务可归入多个标签，中心按债务去重。
            {showDeltas && ' 分类变化按记录的当前标签汇总。'}</> : '当前筛选没有债务可显示'}
        </p>
      </div>
      <GraphComparison rows={changes} since={since} label={comparisonLabel} categories={categoryChanges} currentNodes={nodes}
        onSelect={choose} onRecord={onSelect} />
    </div>
    <div className="ep-a-graph-lower">
      <GraphSelection node={node} focus={root.path} pair={pair} onFocus={zoom} onChild={choose} onRecord={onSelect} openCategory={openCategory} />
      <Cooccurrences records={records} pair={pair} onPair={next => { setPair(next); setSelected(next ? [] : root.path); }} />
    </div>
  </section>;
}

export function PlanningGraph({ data, onSelect, onCategory, scopeLabel = '全部分类', projectLabel = data.projectId }: PlanningGraphProps) {
  if (!data.graph) return <section className="ep-a-panel" aria-label="债务分类图谱"><h2>债务分类图谱</h2><p className="ep-a-empty">暂无可查看的分类数据</p></section>;
  const sessionKey = `cds.planning.graph:${data.projectId}:${data.graph.branch ?? ''}`;
  return <GraphContent key={sessionKey} graph={data.graph} scopeLabel={scopeLabel} projectLabel={projectLabel}
    onSelect={onSelect} onCategory={onCategory} sessionKey={sessionKey} />;
}
