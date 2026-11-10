import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, Bell, ChevronDown, ChevronRight, Plus, Search, Wind } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { buildWorkspaceModel, visibleWorkspaceServices, workspaceHealthCell, type WorkspaceCategory, type WorkspaceService, type WorkspaceState } from '@/lib/monitorWorkspace';
import { formatRelative, type UptimeBucket, type UptimeIncidentView, type UptimeSummary, type UptimeTargetSummary } from '@/lib/monitorCenter';
import { planMonitorLayout, categoryMonitorLayout, MONITOR_LEVELS, type MonitorDensity, type MonitorLevel, type MonitorLayout, type LayoutBand, type LayoutPart } from '@/lib/monitorLayout';
import { measurementView } from '@/lib/monitorMeasurement';
import { ServiceDetail } from './MonitorServiceDetail';
import { effectiveNotifications, useWorkspaceNotifications, type NotificationSnapshot } from './useMonitorNotifications';
import './monitor-workspace.css';

type Density = MonitorDensity;
type LayerKey = 'g' | 'c' | 's';
type Box = { x: number; y: number; w: number; h: number };
type Location = { kind: LayerKey; categoryId?: string; serviceId?: string; skipReturn?: boolean; rect?: Box };
type Pose = CSSProperties;
const STATES: Record<WorkspaceState, string> = { ok: '正常', bad: '异常', warn: '待确认', none: '无观测' };
const serviceStateLabel = (service: WorkspaceService): string => service.fresh ? '等待首次观测' : STATES[service.state];
const BUCKET_STATES = { up: 'ok', down: 'fail', partial: 'part', none: 'gap' } as const;
const BUCKET_LABELS = { up: '通过', down: '失败', partial: '部分失败', none: '无观测' } as const;
const IDENTITY: Pose = { transform: 'none', opacity: 1, clipPath: 'inset(0)', visibility: 'visible', pointerEvents: 'auto', transition: 'none' };
const HIDDEN: Pose = { ...IDENTITY, opacity: 0, visibility: 'hidden', pointerEvents: 'none' };
const EASE = 'cubic-bezier(.22,.8,.24,1)';
const time = (at: number): string => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

export interface MonitorWorkspaceProps {
  targets: UptimeTargetSummary[];
  summary: UptimeSummary;
  incidents: UptimeIncidentView[];
  now: number;
  onAdd: () => void;
  onNotify: (targetId?: string) => void;
  onProbe: (targetId: string) => Promise<void>;
  onManage: (targetId?: string) => void;
  onReload: () => void;
  entry?: { targetId: string; incidentId: string; detectedAt?: string };
}

function Glyph({ state, large = false }: { state: WorkspaceState; large?: boolean }) {
  return <span className={`gl ${state}${large ? ' lg' : ''}`} role="img" aria-label={STATES[state]} />;
}

function HistoryStrip({ buckets, mini = false }: { buckets: UptimeBucket[]; mini?: boolean }) {
  return <div className={mini ? 'hist-mini' : 'hist'} aria-label="历史观测状态">{buckets.length ? buckets.map((b, i) => <span key={`${b.from}:${i}`} className={`hc ${BUCKET_STATES[b.status]}`} title={`${time(b.from)}–${time(b.to)} · ${BUCKET_LABELS[b.status]} · ${b.up + b.down} 次观测`} />) : Array.from({ length: 48 }, (_, i) => <span key={i} className="hc gap" title="尚无观测数据" />)}</div>;
}

function Sparkline({ buckets }: { buckets: UptimeBucket[] }) {
  const values = buckets.map((b, i) => ({ i, value: b.avgLatencyMs })).filter((v): v is { i: number; value: number } => v.value != null);
  if (values.length < 2) return <HistoryStrip buckets={buckets} mini />;
  const max = Math.max(1, ...values.map((v) => v.value));
  // Keep gaps empty: separate polylines prevent implying unobserved intervals succeeded.
  const groups: typeof values[] = [];
  for (const v of values) { const last = groups[groups.length - 1]; if (last && last[last.length - 1].i === v.i - 1) last.push(v); else groups.push([v]); }
  return <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="实际观测响应延迟">{groups.map((group, i) => <polyline key={i} points={group.map((v) => `${v.i / Math.max(1, buckets.length - 1) * 100},${27 - v.value / max * 23}`).join(' ')} />)}</svg>;
}

function ServiceTile({ service: s, mode, matches, selected, searched = false, anchor, onOpen }: { service: WorkspaceService; mode: MonitorLevel; matches: boolean; selected: boolean; searched?: boolean; anchor: string; onOpen: () => void }) {
  const metric = measurementView(s.target.lastSample), attention = s.state === 'bad' || s.state === 'warn';
  const actual = metric?.actual ?? (s.state === 'none' ? serviceStateLabel(s) : s.latency);
  const expected = metric ? `预期 ${metric.expected}` : s.state === 'none' ? s.reason : `24h ${s.rate}`;
  const title = `${s.name} · ${serviceStateLabel(s)}${metric ? ` · ${metric.name} 实际 ${metric.actual}，预期 ${metric.expected}（${metric.gap}）` : ` · ${s.reason}`}`;
  return <button className={`it ${mode} ${s.state}${matches ? '' : ' dim'}${selected ? ' sel' : ''}${searched && matches ? ' hit' : ''}`} data-anchor={anchor} onClick={onOpen} title={title}>
    <span className="i-n"><Glyph state={s.state} /><span className="nm">{s.name}</span><span className="i-v">{attention ? metric?.shortGap ?? serviceStateLabel(s) : s.state === 'none' ? serviceStateLabel(s) : ''}</span></span>
    <span className={`i-s ${s.state}`}>{serviceStateLabel(s)} · {metric ? `${metric.name} ${metric.actual}` : s.reason}</span>
    <span className="i-m"><span className="mono">{mode === 'L1' && attention && metric ? metric.shortGap : actual}</span><span>{mode === 'L1' && attention ? s.ago : expected}</span><span className="ago">{s.ago}</span></span>
    {mode === 'L1' ? <Sparkline buckets={s.target.buckets} /> : null}
  </button>;
}

function AlertNotification({ service, notifications, summary, now }: { service: WorkspaceService; notifications: NotificationSnapshot; summary: UptimeSummary; now: number }) {
  const config = effectiveNotifications(notifications, summary, service.target);
  const names = config.channels.map((c) => c.name).concat(config.legacy && config.legacy.status !== 'unconfigured' ? [config.legacy.channel] : []);
  const text = !config.known ? '通知规则待确认' : config.mutedUntil > now ? `已静默至 ${time(config.mutedUntil)}` : names.length ? `${names.length} 条通知通道` : '未配置适用的通知通道';
  return <span className="ai-n ai-one"><span className="ai-nt">{text}</span>{config.mutedUntil <= now && names.slice(0, 2).map((name, i) => <span className="chn" key={`${name}:${i}`}>{name}</span>)}</span>;
}

export function MonitorWorkspace({ targets, summary, incidents, now, onAdd, onNotify, onProbe, onManage, entry }: MonitorWorkspaceProps): JSX.Element {
  const route = useLocation();
  const firstSeen = useRef({ categories: new Map<string, number>(), services: new Map<string, number>() });
  const model = useMemo(() => {
    const next = buildWorkspaceModel(targets, now, summary);
    for (const category of next.categories) {
      if (!firstSeen.current.categories.has(category.id)) firstSeen.current.categories.set(category.id, firstSeen.current.categories.size);
      for (const service of category.services) if (!firstSeen.current.services.has(service.id)) firstSeen.current.services.set(service.id, firstSeen.current.services.size);
      category.services.sort((a, b) => firstSeen.current.services.get(a.id)! - firstSeen.current.services.get(b.id)!);
    }
    next.categories.sort((a, b) => firstSeen.current.categories.get(a.id)! - firstSeen.current.categories.get(b.id)!);
    next.services.sort((a, b) => firstSeen.current.services.get(a.id)! - firstSeen.current.services.get(b.id)!);
    return next;
  }, [targets, now, summary]);
  const root = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const busyRef = useRef(false);
  const [stack, setStack] = useState<Location[]>([{ kind: 'g' }]);
  const stackRef = useRef(stack); stackRef.current = stack;
  const [poses, setPoses] = useState<Record<LayerKey, Pose>>({ g: IDENTITY, c: HIDDEN, s: HIDDEN });
  const [stage, setStage] = useState<Partial<Record<LayerKey, string>>>({});
  const [categoryId, setCategoryId] = useState<string>();
  const [serviceId, setServiceId] = useState<string>();
  const [selection, setSelection] = useState<string>();
  const [markedAlert, setMarkedAlert] = useState<string>();
  const [entryActive, setEntryActive] = useState(false);
  const [query, setQuery] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [status, setStatus] = useState<WorkspaceState | 'all'>('all');
  const [source, setSource] = useState<'all' | 'public' | 'custom'>('all');
  const [density, setDensity] = useState<Density>('auto');
  const [sort, setSort] = useState<'original' | 'issues'>('original');
  const [railOpen, setRailOpen] = useState(false);
  const [noneOpen, setNoneOpen] = useState(true);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [size, setSize] = useState({ width: 1200, height: 750, narrow: window.innerWidth <= 760 });
  const current = stack[stack.length - 1];
  const layoutCache = useRef<{ key: string; categoryIds: string[]; value: MonitorLayout; tracks?: string; counts: Record<string, number> }>();
  const measuredRows = useRef<{ key: string; value: string }>();
  const visibleSlots = useRef(new Map<string, string[]>());
  const layoutKey = JSON.stringify([density, size.width, size.height, size.narrow]);
  const ids = model.categories.map(c => c.id), previous = layoutCache.current;
  if (!previous || previous.key !== layoutKey || previous.categoryIds.some(id => !ids.includes(id))) {
    layoutCache.current = { key: layoutKey, categoryIds: ids, counts: Object.fromEntries(model.categories.map(c => [c.id, c.services.length])), value: planMonitorLayout(model.categories.map(c => ({ id: c.id, count: c.services.length, reserve: c.custom ? 3 : 0 })), size.width, size.height, density, size.narrow) };
    visibleSlots.current.clear();
  } else if (ids.length > previous.categoryIds.length) {
    const added = model.categories.map((category, i) => ({ category, i })).filter(({ category }) => !previous.categoryIds.includes(category.id));
    const extra: LayoutBand[] = added.map(({ category, i }) => { const columns = Math.max(1, Math.floor((size.width - 40) / 182)), rows = Math.ceil(category.services.length / columns); return { level: MONITOR_LEVELS.L2, rows, height: 52 + rows * 47, spans: [24], parts: [{ indices: [i], stacked: false, span: 24, width: size.width - 24, columns, rows, visible: category.services.length }] }; });
    const tracks = measuredRows.current?.key === layoutKey ? measuredRows.current.value : previous.tracks;
    layoutCache.current = { key: layoutKey, categoryIds: ids, counts: { ...previous.counts, ...Object.fromEntries(added.map(({ category }) => [category.id, category.services.length])) }, tracks: `${tracks ?? previous.value.bands.map(b => `${b.height}px`).join(' ')} ${extra.map(b => `${b.height}px`).join(' ')}`, value: { ...previous.value, bands: [...previous.value.bands, ...extra], fits: false } };
  }
  const layout = layoutCache.current!.value;
  useLayoutEffect(() => { const grid = root.current?.querySelector<HTMLElement>('.cg'); if (!grid) return; const record = () => { const value = getComputedStyle(grid).gridTemplateRows; if (value !== 'none') measuredRows.current = { key: layoutKey, value }; }; record(); const observer = new ResizeObserver(record); observer.observe(grid); return () => observer.disconnect(); }, [layoutKey, ids.join('|'), layout.bands.length]);
  const category = model.categories.find((c) => c.id === categoryId);
  const service = model.services.find((s) => s.id === serviceId);
  const q = query.trim().toLocaleLowerCase();
  const matches = (s: WorkspaceService, c: WorkspaceCategory) => (!q || `${s.name} ${c.name}`.toLocaleLowerCase().includes(q)) && (status === 'all' || s.state === status) && (source === 'all' || s.custom === (source === 'custom'));
  const results = q ? model.services.filter((s) => { const c = model.categories.find((entry) => entry.id === s.categoryId); return c && `${s.name} ${c.name}`.toLocaleLowerCase().includes(q); }).slice(0, 8) : [];
  const alerts = model.services.filter((s) => s.state === 'bad' || s.state === 'warn').sort((a, b) => (a.state === 'bad' ? 0 : 1) - (b.state === 'bad' ? 0 : 1) || (a.target.statusSince ?? now) - (b.target.statusSince ?? now));
  const notifications = useWorkspaceNotifications(summary.generatedAt);
  const globalNotification = effectiveNotifications(notifications, summary);
  const verdict = globalNotification.verdict;
  const globalNotificationText = !globalNotification.known ? '默认通知规则尚未读取成功，当前无法确认投递对象。'
    : globalNotification.channelIds?.length === 0 ? '默认未选择通知通道；未单独设置的服务不会发送通知。'
    : verdict.text.replace(/（缺 [^）]*）/g, '');
  const later = (ms: number, fn: () => void) => { const timer = setTimeout(fn, ms); timers.current.push(timer); };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const history = stackRef.current;
    const invalid = history.findIndex((entry) => (entry.categoryId && !model.categories.some((c) => c.id === entry.categoryId)) || (entry.serviceId && !model.services.some((s) => s.id === entry.serviceId)));
    if (invalid < 1) return;
    timers.current.forEach(clearTimeout); timers.current = []; busyRef.current = false;
    const valid = history.slice(0, invalid);
    setStack(valid); setStage({}); setPoses({ g: HIDDEN, c: HIDDEN, s: HIDDEN, [valid[valid.length - 1].kind]: IDENTITY });
  }, [model]);
  useEffect(() => {
    root.current?.querySelectorAll<HTMLElement>('.layer').forEach((layer) => layer.toggleAttribute('inert', !layer.classList.contains(`L${current.kind}`)));
  }, [current.kind]);
  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { setSize({ width: element.clientWidth, height: element.clientHeight, narrow: window.innerWidth <= 760 }); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const target = e.target as Element;
      if (!target.closest('.search')) setDropdownOpen(false);
    };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const findAnchor = (layer: LayerKey, id: string): HTMLElement | undefined => Array.from(root.current?.querySelectorAll<HTMLElement>(`.L${layer} [data-anchor]`) ?? []).find((e) => e.dataset.anchor === id);
  const relative = (el: HTMLElement): Box => {
    const layer = el.closest<HTMLElement>('.layer');
    if (layer) { const r = el.getBoundingClientRect(), bounds = layer.getBoundingClientRect(); if (r.top < bounds.top || r.bottom > bounds.bottom) layer.scrollTop += r.top - bounds.top - Math.max(8, (bounds.height - r.height) / 3); }
    const bounds = workspace.current!.getBoundingClientRect(), rect = el.getBoundingClientRect();
    return { x: rect.left - bounds.left, y: rect.top - bounds.top, w: Math.max(8, rect.width), h: Math.max(8, rect.height) };
  };
  // Camera coordinates come from getBoundingClientRect in physical CSS pixels;
  // they must remain in that coordinate system rather than scale with typography.
  const camera = (rect: Box) => { const scale = Math.max(1, Math.min(size.width / rect.w, size.height / rect.h)); return { scale, x: size.width / 2 - scale * (rect.x + rect.w / 2), y: size.height / 2 - scale * (rect.y + rect.h / 2) }; };
  const zoomed = (rect: Box): Pose => { const scale = Math.min(camera(rect).scale, 2.2), x = rect.x + rect.w / 2, y = rect.y + rect.h / 2; return { ...IDENTITY, transform: `translate(${x - scale * x}px,${y - scale * y}px) scale(${scale})`, opacity: 0, pointerEvents: 'none' }; };
  const collapsed = (rect: Box): Pose => {
    const cam = camera(rect), n = cam.scale;
    return { ...IDENTITY, transform: `translate(${-cam.x / n}px,${-cam.y / n}px) scale(${1 / n})`, clipPath: `inset(${Math.max(0, n * rect.y + cam.y)}px ${Math.max(0, size.width - (n * rect.x + cam.x + n * rect.w))}px ${Math.max(0, size.height - (n * rect.y + cam.y + n * rect.h))}px ${Math.max(0, n * rect.x + cam.x)}px round ${10 * n}px)`, opacity: 0, pointerEvents: 'none' };
  };
  const raf = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(() => later(16, fn)));
  const push = (entries: Location[]) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const from = stackRef.current[stackRef.current.length - 1].kind;
    const entry = entries[entries.length - 1], to = entry.kind;
    const rect = entry.rect ?? { x: 50, y: 50, w: 200, h: 110 };
    if (entry.categoryId) setCategoryId(entry.categoryId);
    setServiceId(entry.serviceId);
    setStack((prev) => prev.concat(entries)); setDropdownOpen(false);
    const initial = { g: HIDDEN, c: HIDDEN, s: HIDDEN }; initial[from] = IDENTITY; initial[to] = reduced ? { ...IDENTITY, opacity: 0 } : collapsed(rect);
    setPoses(initial); setStage({ [to]: 'pre' });
    raf(() => {
      setStage({}); setPoses({ ...initial, [from]: reduced ? { ...IDENTITY, opacity: 0, transition: 'opacity 160ms linear' } : { ...zoomed(rect), transition: `transform 520ms ${EASE}, opacity 520ms ${EASE}` }, [to]: { ...IDENTITY, transition: reduced ? 'opacity 160ms linear' : `transform 520ms ${EASE}, clip-path 520ms ${EASE}, opacity 220ms linear 40ms` } });
      later(reduced ? 190 : 560, () => { setPoses({ g: HIDDEN, c: HIDDEN, s: HIDDEN, [to]: IDENTITY }); busyRef.current = false; });
    });
  };
  const pop = (index = stackRef.current.at(-2)?.skipReturn ? stackRef.current.length - 3 : stackRef.current.length - 2, then?: () => void) => {
    const history = stackRef.current;
    if (busyRef.current || index < 0 || index >= history.length - 1) return;
    busyRef.current = true;
    const from = history[history.length - 1], to = history[index], via = history[index + 1];
    const anchor = findAnchor(to.kind, via.kind === 'c' ? `cat:${via.categoryId}` : `svc:${via.serviceId}`) ?? findAnchor(to.kind, `cat:${via.categoryId}`);
    const rect = anchor ? relative(anchor) : via.rect ?? { x: size.width / 2 - 90, y: size.height / 2 - 60, w: 180, h: 120 };
    const initial = { g: HIDDEN, c: HIDDEN, s: HIDDEN }; initial[from.kind] = IDENTITY; initial[to.kind] = reduced ? IDENTITY : zoomed(rect); setPoses(initial);
    raf(() => {
      setStage({ [from.kind]: 'out' }); setPoses({ ...initial, [to.kind]: { ...IDENTITY, transition: reduced ? 'none' : `transform 460ms ${EASE}, opacity 460ms ${EASE}` }, [from.kind]: reduced ? { ...IDENTITY, opacity: 0, transition: 'opacity 160ms linear' } : { ...collapsed(rect), transition: `transform 460ms ${EASE}, clip-path 460ms ${EASE}, opacity 180ms linear 280ms` } });
      later(reduced ? 190 : 500, () => { setStack(history.slice(0, index + 1)); setPoses({ g: HIDDEN, c: HIDDEN, s: HIDDEN, [to.kind]: IDENTITY }); setStage({}); busyRef.current = false; if (to.kind === 'g') setEntryActive(false); if (then) later(40, then); });
    });
  };
  const openCategory = (c: WorkspaceCategory) => {
    if (busyRef.current) return;
    if (stackRef.current.length > 1) { const existing = stackRef.current.findIndex((e) => e.kind === 'c' && e.categoryId === c.id); if (existing > 0) { if (existing < stackRef.current.length - 1) pop(existing); return; } pop(0, () => openCategory(c)); return; }
    const el = findAnchor('g', `cat:${c.id}`); if (!el) return;
    setSelection(c.id); setEntryActive(false);
    push([{ kind: c.services.length === 1 ? 's' : 'c', categoryId: c.id, serviceId: c.services.length === 1 ? c.services[0].id : undefined, rect: relative(el) }]);
  };
  const openService = (s: WorkspaceService) => {
    if (busyRef.current || stackRef.current.at(-1)?.serviceId === s.id) return;
    const c = model.categories.find((entry) => entry.id === s.categoryId); if (!c) return;
    setSelection(s.id); setMarkedAlert(s.id); setEntryActive(false);
    const from = stackRef.current.at(-1)!;
    if (from.kind === 's' && from.categoryId === c.id && stackRef.current.length > 2) { pop(stackRef.current.length - 2, () => openService(s)); return; }
    if (from.kind !== 'g' && !(from.kind === 'c' && from.categoryId === c.id)) { pop(0, () => openService(s)); return; }
    const el = findAnchor(from.kind, `svc:${s.id}`) ?? findAnchor('g', `cat:${c.id}`); if (!el) return;
    const entries: Location[] = [];
    if (from.kind === 'g' && c.services.length > 1) { const ce = findAnchor('g', `cat:${c.id}`); entries.push({ kind: 'c', categoryId: c.id, rect: ce ? relative(ce) : relative(el), skipReturn: true }); }
    entries.push({ kind: 's', categoryId: c.id, serviceId: s.id, rect: relative(el) }); push(entries);
  };
  const resetDensity = (value: Density) => { if (busyRef.current) return; setDensity(value); setStack((prev) => prev.map((entry) => ({ ...entry, rect: undefined }))); };
  const categoryDensity = categoryMonitorLayout(category?.services.length ?? 0, size.width, size.height);
  const categoryServices = category ? sort === 'issues' ? [...category.services].sort((a, b) => ({ bad: 0, warn: 1, none: 2, ok: 3 }[a.state]) - ({ bad: 0, warn: 1, none: 2, ok: 3 }[b.state])) : category.services : [];
  const tokens = (c: WorkspaceCategory, labels = false) => (Object.keys(STATES) as WorkspaceState[]).filter((state) => c.counts[state]).map((state) => <span className={`ctok ${state === 'ok' ? 'okt' : ''}`} key={state}><Glyph state={state} /><b>{c.counts[state]}</b>{labels ? STATES[state] : null}</span>);
  // A user navigation to the same /status URL still means returning to the overview.
  useEffect(() => {
    timers.current.forEach(clearTimeout); timers.current = []; busyRef.current = false;
    setStack([{ kind: 'g' }]); setPoses({ g: IDENTITY, c: HIDDEN, s: HIDDEN }); setStage({});
    setCategoryId(undefined); setServiceId(undefined); setSelection(undefined); setMarkedAlert(undefined); setEntryActive(false); handledEntry.current = undefined;
  }, [route.key]);
  const handledEntry = useRef<string>();
  const entryKey = entry ? `${route.key}:${entry.targetId}:${entry.incidentId}:${entry.detectedAt ?? ''}` : '';
  useEffect(() => {
    if (!entry || !entryKey || handledEntry.current === entryKey) return;
    const item = model.services.find(s => s.id === entry.targetId), group = model.categories.find(c => c.id === item?.categoryId);
    if (!item || !group) return;
    handledEntry.current = entryKey; setCategoryId(group.id); setServiceId(item.id); setSelection(item.id); setMarkedAlert(item.id); setEntryActive(true);
    setStack([{ kind: 'g' }, ...(group.services.length > 1 ? [{ kind: 'c' as const, categoryId: group.id, skipReturn: true }] : []), { kind: 's', categoryId: group.id, serviceId: item.id }]);
    setPoses({ g: HIDDEN, c: HIDDEN, s: IDENTITY }); setStage({}); busyRef.current = false;
  }, [entryKey, model]);
  const regions = [...new Set(model.services.map(s => s.region))];
  const badRegions = regions.filter(region => model.services.some(s => s.region === region && s.state === 'bad'));
  const noneGroups = new Map<string, { category: WorkspaceCategory; reason: string; services: WorkspaceService[] }>();
  model.services.filter(s => s.state === 'none').forEach(s => {
    const group = model.categories.find(c => c.id === s.categoryId)!;
    const key = `${group.id}:${s.reason}`, value = noneGroups.get(key) ?? { category: group, reason: s.reason, services: [] };
    value.services.push(s); noneGroups.set(key, value);
  });
  const recovered = incidents.filter(e => e.endedAt && model.services.some(s => s.id === e.targetId)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 4);
  const renderCategory = (c: WorkspaceCategory, part: LayoutPart, level: MonitorLevel, stacked: boolean) => {
    const initialCount = layoutCache.current!.counts[c.id] ?? c.services.length;
    const capacity = stacked ? c.services.length : part.visible >= initialCount ? Math.min(c.services.length, part.columns * part.rows) : part.visible;
    const slotKey = `${layoutKey}:${c.id}`;
    const shown = visibleWorkspaceServices(c.services, capacity, visibleSlots.current.get(slotKey)); visibleSlots.current.set(slotKey, shown.map(s => s.id));
    const shownIds = new Set(shown.map(s => s.id)), hidden = c.services.filter(s => !shownIds.has(s.id));
    const hb = hidden.filter(s => s.state === 'bad').length, hw = hidden.filter(s => s.state === 'warn').length, hn = hidden.filter(s => s.state === 'none').length;
    const selected = selection === c.id || Boolean(selection && hidden.some(s => s.id === selection));
    const lv = MONITOR_LEVELS[level], rows = Math.max(1, part.rows), ovH = Math.min(lv.rowHeight, 30);
    const gridStyle: CSSProperties = { gridTemplateColumns: `repeat(${stacked ? 1 : part.columns},minmax(0,1fr))`, ...(stacked ? { gridAutoRows: `${lv.rowHeight}px` } : { gridTemplateRows: hidden.length ? `${rows > 1 ? `repeat(${rows - 1},minmax(${lv.rowHeight}px,1fr)) ` : ''}minmax(${ovH}px,auto)` : `repeat(${rows},minmax(${lv.rowHeight}px,1fr))` }) };
    return <div key={c.id} className={`${stacked ? 'sg' : 'cat'} ${level}${c.services.some(s => matches(s, c)) ? '' : ' dim'}${selected ? ' sel' : ''}`} data-anchor={`cat:${c.id}`}>
      <button className={stacked ? 'sgh' : 'ch'} onClick={() => openCategory(c)} aria-label={`打开${c.name}，${c.services.length}项服务`}><span className="cn">{c.name}</span><span className="cc">{c.services.length} 项</span>{c.custom ? <span className="tag acc">自定义</span> : null}<span className="ctoks">{tokens(c)}</span>{!stacked ? <span className="go"><ChevronRight className="ic s" /></span> : null}</button>
      <div className="cb2"><div className="cgrid" style={gridStyle}>
        {shown.map(s => <ServiceTile key={s.id} service={s} mode={level} matches={matches(s, c)} selected={selection === s.id} searched={Boolean(q)} anchor={`svc:${s.id}`} onOpen={() => openService(s)} />)}
        {c.custom && !hidden.length ? <button className={`it-add ${level}`} onClick={onAdd} title="接入我的服务"><Plus className="ic xs" /><span className="ia-t">接入我的服务</span></button> : null}
        {hidden.length ? <button className="ovf" style={{ gridColumn: '1 / -1', gridRow: rows }} title={`另 ${hidden.length} 项未在首屏显示：${hb} 异常、${hw} 待确认、${hn} 无观测，进入分类查看全部`} onClick={() => openCategory(c)}><span className="ovn">另 <b>{hidden.length}</b> 项</span>{hb ? <span className="ovs ob"><Glyph state="bad" />{hb}<span className="ovt">异常</span></span> : null}{hw ? <span className="ovs ow"><Glyph state="warn" />{hw}<span className="ovt">待确认</span></span> : null}{hn ? <span className="ovs on"><Glyph state="none" />{hn}<span className="ovt">无观测</span></span> : null}{!hb && !hw && !hn ? <span className="ok2">均满足预期</span> : null}<span className="go2">进入分类 →</span></button> : null}
      </div></div>
    </div>;
  };
  const renderStack = (part: LayoutPart, band: LayoutBand) => {
    const count = part.stackColumns ?? 1, columns: Array<Array<{ i: number; height: number }>> = Array.from({ length: count }, () => []);
    const heights = part.indices.map(i => { const c = model.categories[i], n = (layoutCache.current!.counts[c.id] ?? c.services.length) + (c.custom ? 3 : 0); return { i, height: 26 + n * (band.level.rowHeight + band.level.gap) - band.level.gap + 8 }; });
    const target = heights.reduce((sum, s) => sum + s.height, 0) / count; let column = 0, used = 0;
    heights.forEach(slot => { if (used > 0 && used + slot.height > target + 12 && column < count - 1) { column++; used = 0; } columns[column].push(slot); used += slot.height; });
    return <div className="stk" style={{ gridColumn: `span ${part.span}`, gridTemplateColumns: `repeat(${count},minmax(0,1fr))` }}>{columns.map((slots, i) => <div className="stack-column" key={i}>{slots.map(slot => <div className="stack-slot" key={model.categories[slot.i].id} style={{ height: slot.height }}>{renderCategory(model.categories[slot.i], part, band.level.key, true)}</div>)}</div>)}</div>;
  };
  return <div className="monitor-workspace" ref={root}>
    <div className="main">
      <div className="t2"><div className="search"><Search className="ic s" /><input type="search" aria-label="搜索服务或分类" placeholder={`搜索 ${model.services.length} 项服务、分类`} value={query} onChange={e => { setQuery(e.target.value); setDropdownOpen(true); setSelection(undefined); }} onFocus={() => setDropdownOpen(true)} onKeyDown={e => { if (e.key === 'Escape') setDropdownOpen(false); if (e.key === 'Enter' && results[0]) openService(results[0]); }} />{dropdownOpen && q ? <div className="dd"><p className="dd-h">{results.length ? `匹配服务 · 最多显示 8 项` : '没有找到匹配的服务或分类'}</p>{results.map(s => <button key={s.id} onClick={() => openService(s)}><Glyph state={s.state} /><span className="nm">{s.name}</span><span className="loc">{model.categories.find(c => c.id === s.categoryId)?.name}</span></button>)}</div> : null}</div><select className="source-filter" aria-label="服务来源" value={source} onChange={e => { setSource(e.target.value as typeof source); setSelection(undefined); }}><option value="all">全部来源</option><option value="public">公共基础设施</option><option value="custom">我的服务</option></select><div className="tokens" role="group" aria-label="按当前状态筛选">{(Object.keys(STATES) as WorkspaceState[]).map(state => <button key={state} className={`tok ${state}${status === state ? ' on' : ''}`} aria-pressed={status === state} onClick={() => { setStatus(status === state ? 'all' : state); setSelection(undefined); }}><Glyph state={state} /><b>{model.counts[state]}</b><span className="tkl">{STATES[state]}</span></button>)}</div><span className="sp" /><span className="seg-l">密度</span><div className="seg vseg" role="group" aria-label="视图密度">{([{ key: 'auto', label: '自动' }, { key: 'L1', label: '卡片' }, { key: 'L2', label: '两行' }, { key: 'L3', label: '单行' }] as const).map(x => <button key={x.key} className={density === x.key ? 'on' : ''} aria-pressed={density === x.key} onClick={() => resetDensity(x.key)}>{x.label}</button>)}</div><button className={`rm-b${reduced ? ' on' : ''}`} aria-label="减少动态效果" title="减少动态效果" aria-pressed={reduced} onClick={() => setReduced(!reduced)}><Wind className="ic s" /></button></div>
      <div className="t2r"><button className="rail-tg" aria-expanded={railOpen} onClick={() => setRailOpen(!railOpen)}><h2>需要处理</h2><span className="cnt bad">{model.counts.bad} 异常</span><span className="cnt warn">{model.counts.warn} 待确认</span><ChevronDown className="ic s chev" /></button></div>
      <section className="wsw" aria-label="工作区"><div className="crumbs"><button className="cb" disabled={stack.length === 1} onClick={() => pop()} aria-label={stack.length === 1 ? '已在全部服务' : stack.at(-2)?.skipReturn || stack.length === 2 ? '返回全部服务' : '返回分类'}><ArrowLeft className="ic s" />返回</button>{stack.map((place, i) => <Fragment key={`${place.kind}:${i}`}>{i > 0 ? <span className="csep">/</span> : null}{i === stack.length - 1 ? <span className="crumb-t cur">{place.kind === 'g' ? '全部服务' : place.kind === 'c' ? model.categories.find(c => c.id === place.categoryId)?.name : model.services.find(s => s.id === place.serviceId)?.name}</span> : <button className="cb" onClick={() => pop(i)}>{place.kind === 'g' ? '全部服务' : model.categories.find(c => c.id === place.categoryId)?.name}</button>}</Fragment>)}<span className="sp" />{current.kind !== 'g' ? <div className="oth"><span className="lab">其他分类</span>{model.categories.filter(c => c.id !== categoryId && c.counts.bad + c.counts.warn > 0).map(c => <button key={c.id} className={`ochip${c.counts.bad ? '' : ' w'}`} onClick={() => openCategory(c)}><Glyph state={c.counts.bad ? 'bad' : 'warn'} />{c.name} · {c.counts.bad + c.counts.warn}</button>)}</div> : <span className="mode-l">密度按空间{density === 'auto' ? '自动' : '固定'} · {layout.bands[0]?.level.name ?? '单行'}</span>}</div>
        {entry && !model.services.some(s => s.id === entry.targetId) ? <div role="alert" className="entry-warning">通知对应的服务不存在，或当前账号没有访问权限。请选择可见的服务查看，未自动定位到其他服务。</div> : null}
        <div className="ws" ref={workspace}>
          <div className={`layer Lg ${stage.g ?? ''}${reduced ? ' nomo' : ''}`} aria-hidden={current.kind !== 'g'} style={poses.g}>{model.categories.length ? <div className={`cg${layout.fits && !layoutCache.current!.tracks ? ' fit' : ''}`} style={{ gridTemplateRows: layoutCache.current!.tracks ?? layout.bands.map(b => layout.narrow ? 'auto' : layout.fits ? `${b.height}fr` : `${b.height}px`).join(' ') }}>{layout.bands.flatMap((band, bi) => band.parts.map((part, pi) => part.stacked ? <Fragment key={`${bi}:${pi}`}>{renderStack(part, band)}</Fragment> : <div className="category-slot" key={`${bi}:${pi}`} style={{ gridColumn: `span ${part.span}` }}>{renderCategory(model.categories[part.indices[0]], part, band.level.key, false)}</div>))}</div> : <div className="workspace-empty"><h2>接入服务，开始统一观测</h2><p>已接入的公共基础设施和个人服务会铺满这里。</p><button className="btn pri" onClick={onAdd}><Plus className="ic s" />接入我的服务</button></div>}</div>
          <div className={`layer Lc ${stage.c ?? ''}${reduced ? ' nomo' : ''}`} aria-hidden={current.kind !== 'c'} style={poses.c}>{category ? <div className="lv"><div className="lvh"><div><p className="eyebrow">分类 · {category.custom ? '我的服务' : '公共基础设施'} · {category.services.length} 项</p><h2>{category.name}</h2></div><div className="ltoks">{tokens(category, true)}</div><span className="sp" /><div className="lvn rv rv2"><Bell className="ic xs" />异常时通知 <b>{globalNotification.known ? '按此服务实际通道设置' : '通知规则待确认'}</b><button className="linkb" onClick={() => onNotify()}>调整</button></div><div className="seg rv rv2" role="group" aria-label="排列"><button className={sort === 'original' ? 'on' : ''} onClick={() => setSort('original')}>原始顺序</button><button className={sort === 'issues' ? 'on' : ''} onClick={() => setSort('issues')}>异常优先</button></div></div><div className="ctiles rv rv2" style={{ gridTemplateColumns: `repeat(${categoryDensity.columns},minmax(0,1fr))`, gridAutoRows: `${categoryDensity.rowHeight}px`, rowGap: `${categoryDensity.gap}px` }}>{categoryServices.map(s => <ServiceTile key={s.id} service={s} mode={categoryDensity.level} matches={matches(s, category)} selected={current.kind === 's' && serviceId === s.id} searched={Boolean(q)} anchor={`svc:${s.id}`} onOpen={() => openService(s)} />)}</div></div> : null}</div>
          <div className={`layer Ls ${stage.s ?? ''}${reduced ? ' nomo' : ''}`} aria-hidden={current.kind !== 's'} style={poses.s}>{service && category ? <ServiceDetail key={service.id} service={service} category={category} summary={summary} incidents={incidents} now={now} onNotify={() => onNotify(service.id)} onProbe={() => onProbe(service.id)} onManage={() => onManage(service.id)} notifications={notifications} entry={entryActive && entry ? { incidentId: entry.incidentId, detectedAt: entry.detectedAt, source: '通知' } : undefined} onOpenService={id => { const item = model.services.find(s => s.id === id); if (item) openService(item); }} /> : null}</div>
        </div>
      </section>
      <aside className={`alw${railOpen ? '' : ' closed'}`} aria-label="需要处理的异常"><div className="hm"><div className="hm-h"><span className="hm-t">健康总览</span><span className={`hm-s${badRegions.length ? ' bad' : ''}`}>{badRegions.length ? `异常在 ${badRegions.slice(0, 3).join('、')}` : !model.services.length ? '尚未接入服务' : model.counts.none || model.counts.warn ? '有待确认或无观测服务' : '全部服务最近检查通过'}</span></div><div className="hm-scroll"><div className="hm-g" style={{ gridTemplateColumns: `70px repeat(${Math.max(1, regions.length)},minmax(24px,1fr))` }}><span />{regions.map(region => <span className="hm-hd" key={region} title={region}>{region}</span>)}{model.categories.map(c => <Fragment key={c.id}><button className={`hmr${categoryId === c.id && current.kind !== 'g' ? ' cur' : ''}`} title={c.name} onClick={() => openCategory(c)}>{c.name}</button>{regions.map(region => { const cell = workspaceHealthCell(c, region); return <button key={region} className={`hmc ${cell.state === 'empty' ? 'em' : cell.state}${current.kind !== 'g' && categoryId === c.id && service?.region === region ? ' cur' : ''}`} disabled={cell.state === 'empty'} title={cell.title} aria-label={cell.title} onClick={() => { const item = model.services.find(s => s.id === cell.serviceId); if (item) openService(item); else openCategory(c); }}>{cell.counts.bad + cell.counts.warn || ''}</button>; })}</Fragment>)}</div></div></div>
        <div className="al">{alerts.length === 0 ? <div className="al-empty">当前没有需要处理的异常</div> : null}{alerts.map(s => { const metric = measurementView(s.target.lastSample); return <button className={`ai ${s.state}${current.kind === 's' && serviceId === s.id ? ' cur' : current.kind === 'g' && markedAlert === s.id ? ' was' : ''}`} key={s.id} title={`${s.name} · ${s.reason}`} onClick={() => openService(s)}><span className="ai-h"><Glyph state={s.state} /><span className="nm">{s.name}</span><span className="dur">{s.target.statusSince ? formatRelative(s.target.statusSince, now) : '等待检查'}</span></span><span className="ai-gap"><b className={`ai-a ${s.state}`}>{metric?.actual ?? serviceStateLabel(s)}</b><span className="ai-e">{metric ? `${metric.name} · 预期 ${metric.expected}` : s.reason}</span>{metric ? <span className={`ai-x ${s.state}`}>{metric.shortGap}</span> : null}</span><span className="ai-where">{model.categories.find(c => c.id === s.categoryId)?.name} · {s.target.environmentLabel}</span><AlertNotification service={s} notifications={notifications} summary={summary} now={now} /></button>; })}
          {recovered.length ? <div className="al-sec"><p className="al-sh"><Glyph state="ok" />最近恢复 <b>{recovered.length}</b> 项</p>{recovered.map(e => { const s = model.services.find(value => value.id === e.targetId)!; return <button className="ain" key={e.id} onClick={() => openService(s)}><span className="r1">{s.name}</span><span className="r2">{model.categories.find(c => c.id === s.categoryId)?.name} · {formatRelative(e.endedAt!, now)}恢复</span></button>; })}</div> : null}
          <div className="al-sec"><button className="al-tg" aria-expanded={noneOpen} onClick={() => setNoneOpen(!noneOpen)}><Glyph state="none" />无观测 {model.counts.none} 项<span className="sp" />{noneOpen ? '收起' : '展开'}</button>{noneOpen ? [...noneGroups].map(([key, value]) => <button key={key} className="ain" onClick={() => value.services.length === 1 ? openService(value.services[0]) : openCategory(value.category)}><span className="r1"><Glyph state="none" />{value.category.name}<b>{value.services.length}</b></span><span className="r2">{value.reason}</span></button>) : null}</div>
        </div><div className="al-foot"><div className="al-def"><div className="al-def-r"><span className="al-def-h">默认通知</span><span className="sp" /><button className="linkb" onClick={() => onNotify()}>调整</button></div><span className="ai-n">{globalNotification.channels.map(c => <span className="chn" key={c.id}>{c.name}</span>)}{globalNotification.legacy && globalNotification.legacy.status !== 'unconfigured' ? <span className="chn">{globalNotification.legacy.channel}</span> : null}</span><span className="ai-loc">{globalNotificationText}</span></div></div>
      </aside>
    </div>
  </div>;
}
