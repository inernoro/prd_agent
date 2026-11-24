import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CircleAlert, ExternalLink, X } from 'lucide-react';
import type { PlanningBoard } from '../../../../src/shared/engineering-planning';
import { planProgress, stepIsLate } from './planning-progress';
import type { PlanningSelection } from './PlanningViews';
import { shortId } from './planning-ui';
import {
  type Cause, type Lane, type Relation, type TimeItem, day, days, keyOf, monthDay, neighbours, stalledPull, timelineCauses, timelineItems, timelineRange, timelineRelations,
} from './planning-timeline-model';

const laneNames: Record<Lane, string> = { decision: '决策', debt: '债务', plan: '落地' };
const lanes: Lane[] = ['decision', 'debt', 'plan'];
const toneNames = { neutral: '进行中', warn: '待定或高息', bad: '逾期', ok: '已完成', muted: '已结束或延期' };
export const timelineRanges = [[8, '近 8 周'], [12, '近 12 周'], [26, '近半年']] as const;
const ROW = 36;

function useNarrow() {
  const query = '(max-width: 719px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => { const list = window.matchMedia(query); const on = () => setNarrow(list.matches); list.addEventListener('change', on); return () => list.removeEventListener('change', on); }, []);
  return narrow;
}

export function useTimelineModel(board: PlanningBoard | undefined) {
  return useMemo(() => {
    if (!board) return { items: [] as TimeItem[], relations: [] as Relation[], causes: [] as Cause[] };
    const items = timelineItems(board);
    const relations = timelineRelations(board, items);
    return { items, relations, causes: timelineCauses(board, items, relations) };
  }, [board]);
}

type Props = {
  data: PlanningBoard; model: ReturnType<typeof useTimelineModel>; weeks: number; onWeeks: (weeks: number) => void;
  focus: string; onFocus: (key: string) => void; onSelect: (selection: PlanningSelection) => void;
};

export function PlanningTimelineLanes({ data, model, weeks, onWeeks, focus, onFocus, onSelect }: Props) {
  const narrow = useNarrow();
  const { items, relations, causes } = model;
  const range = timelineRange(data.today, weeks);
  const total = days(range.start, range.end);
  const selected = items.find(item => item.key === focus);
  const near = selected ? neighbours(selected.key, relations) : [];
  const lit = new Set([selected?.key, ...near.map(row => row.key)].filter(Boolean) as string[]);
  const inRange = (date: string) => date >= range.start && date < range.end;
  const visible = items.filter(item => lit.has(item.key) || inRange(item.start) || item.marks.some(mark => inRange(mark.at))
    || (item.lane === 'debt' && item.open ? false : item.start < range.end && item.end >= range.start));
  const earlier = items.length - visible.length;

  return <section className="pt" aria-label="工程规划时间线" data-focus={selected ? selected.key : undefined}>
    <div className="pt-toolbar">
      <div className="pt-segment" role="group" aria-label="时间范围">{timelineRanges.map(([value, label]) =>
        <button key={value} type="button" aria-pressed={weeks === value} onClick={() => onWeeks(value)}>{label}</button>)}</div>
      <ul className="pt-legend" aria-label="图例">
        {(['neutral', 'warn', 'bad', 'ok', 'muted'] as const).map(tone => <li key={tone} data-tone={tone}><i aria-hidden />{toneNames[tone]}</li>)}
        <li data-mark="due"><i aria-hidden />到期</li><li data-mark="step"><i aria-hidden />步骤</li>
      </ul>
      {earlier > 0 && <span className="pt-earlier">另有 {earlier} 项在时间范围之外</span>}
    </div>
    <div className="pt-body">
      {narrow ? <WeekList items={visible} range={range} today={data.today} lit={lit} focus={focus} onFocus={onFocus} />
        : <Chart items={visible} range={range} total={total} today={data.today} lit={lit} focus={focus} near={near} onFocus={onFocus} />}
      <aside className="pt-side" aria-label={selected ? `${selected.id} 的因果和关联` : '要关注'}>
        {selected ? <Detail item={selected} near={near} items={items} data={data} onFocus={onFocus} onSelect={onSelect} />
          : <Attention causes={causes} onFocus={onFocus} />}
      </aside>
    </div>
  </section>;
}

/* 每条泳道里按开始时间排，条和标签不重叠就放在同一行 */
function pack(items: TimeItem[], x: (date: string) => number, width: number) {
  const ends: number[] = [];
  return items.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id)).map(item => {
    const left = Math.max(0, x(item.start));
    const label = Math.min(280, 24 + shortId(item.id).length * 7.2 + item.title.length * 13 + item.state.length * 12);
    const right = Math.min(width, Math.max(x(item.end), left + label));
    let row = ends.findIndex(end => end + 10 < left);
    if (row < 0) { row = ends.length; ends.push(right); } else ends[row] = right;
    return { item, row };
  });
}

function Chart({ items, range, total, today, lit, focus, near, onFocus }: {
  items: TimeItem[]; range: ReturnType<typeof timelineRange>; total: number; today: string; lit: Set<string>; focus: string;
  near: ReturnType<typeof neighbours>; onFocus: (key: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [links, setLinks] = useState<string[]>([]);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const track = el.querySelector('.pt-track') as HTMLElement | null;
    const measure = () => setWidth(Math.max(6, Math.floor(track?.getBoundingClientRect().width ?? el.getBoundingClientRect().width - 80)));
    measure(); const observer = new ResizeObserver(measure); observer.observe(el); return () => observer.disconnect();
  }, []);
  const x = (date: string) => Math.round(days(range.start, date) / total * width);
  const chartX = (date: string) => Math.min(width - 6, Math.max(0, x(date)));
  const placed = lanes.map(lane => ({ lane, rows: pack(items.filter(item => item.lane === lane), chartX, width) }));
  /* 连线：从选中项的条起点到每个关联项的条起点，位置从排好版的 DOM 读 */
  useLayoutEffect(() => {
    const el = box.current; if (!el || !focus) { setLinks([]); return; }
    const origin = el.getBoundingClientRect();
    const anchor = (key: string) => { const bar = el.querySelector(`[data-key="${CSS.escape(key)}"] .pt-bar`); if (!bar) return null; const r = bar.getBoundingClientRect(); return [r.left - origin.left + 3, r.top - origin.top + r.height / 2]; };
    const from = anchor(focus);
    setLinks(from ? near.map(row => anchor(row.key)).filter(Boolean).map(to => {
      const [x1, y1] = from, [x2, y2] = to!; const mid = (y1 + y2) / 2;
      return `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`;
    }) : []);
  }, [focus, near, width, items]);
  const todayX = x(today);
  return <div className="pt-chart" ref={box} style={{ ['--pt-week' as string]: `${width / range.weekStarts.length}px`, ['--pt-today' as string]: `${todayX}px` }}>
    <div className="pt-axis" aria-hidden>
      <span className="pt-gutter" />
      <div className="pt-weeks">{range.weekStarts.map(week => <span key={week} data-now={week === range.thisWeek || undefined}>{monthDay(week)}</span>)}
        <b className="pt-today-label" style={{ left: todayX }}>今天 {monthDay(today)}</b></div>
    </div>
    {placed.map(({ lane, rows }) => {
      const height = Math.max(1, ...rows.map(row => row.row + 1)) * ROW + 10;
      return <div className="pt-lane" key={lane} data-lane={lane}>
        <h3 className="pt-gutter">{laneNames[lane]}<small>{rows.length}</small></h3>
        <ol className="pt-track" style={{ height }}>
          {rows.map(({ item, row }) => {
            const left = chartX(item.start), right = Math.min(width, x(item.end));
            const bar = Math.max(6, right - left);
            const dueAt = item.due ? Math.min(Math.max(x(item.due) - left, 0), bar) : undefined;
            return <li key={item.key} data-key={item.key} data-tone={item.tone} data-open={item.open || undefined} data-late={item.late > 0 || undefined}
              data-dim={lit.size > 0 && !lit.has(item.key) || undefined} data-focus={item.key === focus || undefined} data-clipped={x(item.start) < 0 || undefined}
              style={{ top: row * ROW + 6, left, maxWidth: width - left }}>
              <button type="button" className="pt-item" aria-pressed={item.key === focus} onClick={() => onFocus(item.key === focus ? '' : item.key)}
                title={`${item.id} ${item.title} · ${item.state}`}>
                <span className="pt-label"><b>{shortId(item.id)}</b>{item.title}<em>{item.state}</em></span>
                <span className="pt-bar" style={{ width: bar, ...(item.late && dueAt !== undefined ? { ['--pt-due' as string]: `${dueAt}px` } : {}) }} />
              </button>
              {item.marks.filter(mark => mark.at >= range.start && mark.at <= range.end).map((mark, index) =>
                <i key={index} className="pt-mark" data-kind={mark.kind} data-tone={mark.tone} style={{ left: chartX(mark.at) - left }} title={mark.label} aria-label={mark.label} />)}
            </li>;
          })}
        </ol>
      </div>;
    })}
    <svg className="pt-links" aria-hidden>{links.map((d, i) => <path key={i} d={d} />)}</svg>
  </div>;
}

/* 手机：按周倒序列出发生的事，同一份数据换一种排法 */
function WeekList({ items, range, today, lit, focus, onFocus }: {
  items: TimeItem[]; range: ReturnType<typeof timelineRange>; today: string; lit: Set<string>; focus: string; onFocus: (key: string) => void;
}) {
  const happenings = items.flatMap(item => [
    { at: item.start, item, text: item.lane === 'decision' ? '提出' : item.lane === 'debt' ? '记下' : '开始' },
    ...item.marks.filter(mark => mark.kind !== 'step' || mark.tone === 'bad').map(mark => ({ at: mark.at, item, text: mark.label.replace(/^\d+月\d+日 /, '') })),
  ]).filter(row => row.at >= range.start && row.at <= range.end);
  const weeks = [...range.weekStarts].reverse().map(week => ({ week, rows: happenings.filter(row => row.at >= week && row.at < addDays(week, 7)).sort((a, b) => b.at.localeCompare(a.at)) }))
    .filter(group => group.rows.length);
  return weeks.length ? <ol className="pt-weeklist">{weeks.map(({ week, rows }) => <li key={week}>
    <h3>{week > today ? '之后' : week <= today && today < addDays(week, 7) ? '本周' : `${monthDay(week)} 那周`}</h3>
    <ul>{rows.map((row, index) => <li key={index} data-tone={row.item.tone} data-dim={lit.size > 0 && !lit.has(row.item.key) || undefined}>
      <button type="button" aria-pressed={row.item.key === focus} onClick={() => onFocus(row.item.key === focus ? '' : row.item.key)}>
        <time dateTime={row.at}>{monthDay(row.at)}</time><span className="pt-lane-tag" data-lane={row.item.lane}>{laneNames[row.item.lane]}</span>
        <span><b>{shortId(row.item.id)}</b> {row.item.title}<small>{row.text}</small></span>
      </button></li>)}</ul>
  </li>)}</ol> : <p className="pt-hint">所选时间范围内暂无事件。</p>;
}
const addDays = (date: string, n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

function Attention({ causes, onFocus }: { causes: Cause[]; onFocus: (key: string) => void }) {
  return <div className="pt-attention">
    <h2>要关注 <small>{causes.filter(c => c.tone === 'bad' || c.tone === 'warn').length}</small></h2>
    <p className="pt-hint">根因排在前面。点一项，时间线上会标出它牵动的决策、债务和落地。</p>
    <ol>{causes.map(cause => <li key={cause.key + cause.text} data-tone={cause.tone}>
      {cause.keys.length ? <button type="button" onClick={() => onFocus(cause.key)}><CircleAlert aria-hidden />{cause.text}<ArrowRight aria-hidden /></button>
        : <span><CircleAlert aria-hidden />{cause.text}</span>}
    </li>)}</ol>
  </div>;
}

function Detail({ item, near, items, data, onFocus, onSelect }: {
  item: TimeItem; near: ReturnType<typeof neighbours>; items: TimeItem[]; data: PlanningBoard;
  onFocus: (key: string) => void; onSelect: (selection: PlanningSelection) => void;
}) {
  const byKey = new Map(items.map(row => [row.key, row]));
  const effect = whatItAffects(item, near, byKey, data);
  const pulls = (data.pullRequests ?? []).filter(pr => (item.lane === 'decision' ? pr.decisionIds : item.lane === 'debt' ? pr.debtIds : []).includes(item.id));
  const designs = item.lane === 'decision' ? (data.designs ?? []).filter(design => design.decisionIds.includes(item.id)) : [];
  return <div className="pt-detail">
    <header>
      <span className="pt-lane-tag" data-lane={item.lane}>{laneNames[item.lane]}</span><b>{shortId(item.id)}</b>
      <em data-tone={item.tone}>{item.state}</em>
      <button type="button" className="pt-close" aria-label="取消选择" onClick={() => onFocus('')}><X aria-hidden /></button>
    </header>
    <h2>{item.title}</h2>
    {effect && <p className="pt-effect" data-tone={item.late ? 'bad' : item.tone}>{effect}</p>}
    <dl className="pt-facts">
      <dt>时间</dt><dd>{monthDay(item.start)} → {item.open ? (item.due ? `${monthDay(item.due)} 到期` : '进行中') : monthDay(item.end)}</dd>
      {item.owner && <><dt>负责人</dt><dd>{item.owner}</dd></>}
      {pulls.length > 0 && <><dt>PR</dt><dd>{pulls.map(pr => `#${pr.number} ${pr.state === 'merged' ? '已合并' : stalledPull(pr, data.today) ?? '进行中'}`).join('、')}</dd></>}
      {designs.length > 0 && <><dt>设计</dt><dd>{designs.map(design => `${design.id} ${design.title} V${design.version}`).join('、')}</dd></>}
    </dl>
    <h3>关联 <small>{near.length}</small></h3>
    {near.length ? <ul className="pt-near">{near.map(row => { const other = byKey.get(row.key)!; return <li key={row.key + row.field} data-tone={other.tone}>
      <button type="button" onClick={() => onFocus(row.key)}><span className="pt-lane-tag" data-lane={other.lane}>{laneNames[other.lane]}</span>
        <span><b>{shortId(other.id)}</b> {other.title}<small>{row.outgoing ? row.label : reverse(row.label, item.lane)} · {other.state}</small></span></button>
    </li>; })}</ul> : <p className="pt-hint">没有编号关联。要挂到决策上，在详情里改「所属决策」。</p>}
    {item.marks.length > 0 && <><h3>时间点</h3><ol className="pt-marks">{[...item.marks].sort((a, b) => a.at.localeCompare(b.at)).map((mark, index) =>
      <li key={index} data-tone={mark.tone}>{mark.label}</li>)}</ol></>}
    <footer><button type="button" className="ep-button" onClick={() => onSelect({ kind: item.lane, id: item.id })}><ExternalLink aria-hidden />打开详情</button></footer>
  </div>;
}

/* 关系写在「从」那一侧；从另一侧看时换成反方向的说法 */
function reverse(label: string, lane: Lane) {
  if (label === '来自这个决策') return '由它产生的债';
  if (label === '执行这个决策') return '执行它的落地计划';
  if (label === '被它取代') return '取代了它';
  if (label === '最初来自') return '最初由它产生';
  if (label.startsWith('第 ')) return lane === 'plan' ? label : `排在计划${label.replace(/：.*$/, '')}`;
  return label;
}

/* 因果一句话：这一项挡住了什么、被什么挡住。只用编号关联推出来的事实 */
function whatItAffects(item: TimeItem, near: ReturnType<typeof neighbours>, byKey: Map<string, TimeItem>, { plans, today }: PlanningBoard) {
  const open = near.map(row => ({ ...row, other: byKey.get(row.key)! })).filter(row => row.other.open);
  if (item.lane === 'decision' && item.tone === 'warn') {
    const debts = open.filter(row => row.field === 'debt.decisionId');
    return debts.length ? `还没定，挡住 ${debts.length} 笔债：${debts.map(row => shortId(row.other.id)).join('、')}` : '还没定，暂时没有挂在它上面的债';
  }
  if (item.lane === 'debt' && item.open) {
    const steps = plans.flatMap(plan => plan.steps.flatMap((step, index) =>
      step.kind === 'debt' && step.relatedId === item.id && (step.status === 'todo' || step.status === 'doing')
        ? [`${shortId(plan.id)} 第 ${index + 1} 步`] : []));
    const waiting = open.find(row => row.field === 'debt.decisionId' && row.other.tone === 'warn');
    const parts = [item.late ? `逾期 ${item.late} 天` : '', steps.length ? `挡住 ${steps.join('、')}` : '',
      waiting ? `在等 ${shortId(waiting.other.id)} 定下来` : ''].filter(Boolean);
    return parts.join('，') || null;
  }
  if (item.lane === 'plan') {
    const plan = plans.find(row => row.id === item.id);
    const late = plan ? planProgress(plan, today).late : 0;
    if (!plan || (!item.late && !late)) return null;
    const index = plan.steps.findIndex(row => item.late ? row.status === 'todo' || row.status === 'doing' : stepIsLate(row, today));
    const first = plan.steps[index];
    const related = first?.relatedId && (first.kind === 'decision' || first.kind === 'debt') ? byKey.get(keyOf(first.kind, first.relatedId)) : undefined;
    const reason = item.late ? `逾期 ${item.late} 天` : `${late} 个落地步骤逾期`;
    return `${reason}${first ? `，卡在第 ${index + 1} 步 ${related ? `${shortId(related.id)}（${related.title}）` : first.title}` : ''}`;
  }
  if (item.lane === 'decision' && item.open) {
    const debts = open.filter(row => row.other.lane === 'debt').length, plans = open.filter(row => row.other.lane === 'plan').length;
    return debts || plans ? `正在执行：${plans} 个落地计划，${debts} 笔未还的债` : null;
  }
  return null;
}

export { day, keyOf };
