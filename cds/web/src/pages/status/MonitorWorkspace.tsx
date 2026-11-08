import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, Bell, ChevronDown, ChevronRight, Plus, Search, Send } from 'lucide-react';
import { apiRequest } from '@/lib/api';
import { buildWorkspaceModel, workspaceMinimapRows, type WorkspaceCategory, type WorkspaceService, type WorkspaceState } from '@/lib/monitorWorkspace';
import { formatRelative, type UptimeBucket, type UptimeHistory, type HistoryRange, type UptimeIncidentView, type UptimeSummary, type UptimeTargetSummary } from '@/lib/monitorCenter';
import { judgeAlarm } from '@/lib/alarmVerdict';
import './monitor-workspace.css';

type Density = 'auto' | 'detail' | 'label' | 'summary';
const automaticDensity = (count: number): Exclude<Density, 'auto'> => count <= 24 ? 'detail' : count <= 90 ? 'label' : 'summary';
type LayerKey = 'g' | 'c' | 's';
type Box = { x: number; y: number; w: number; h: number };
type Location = { kind: LayerKey; categoryId?: string; serviceId?: string; rect?: Box };
type Pose = CSSProperties;
const STATES: Record<WorkspaceState, string> = { ok: '正常', bad: '异常', warn: '待确认', none: '无观测' };
const serviceStateLabel = (service: WorkspaceService): string => service.fresh ? '等待首次观测' : STATES[service.state];
const BUCKET_STATES = { up: 'ok', down: 'fail', partial: 'part', none: 'gap' } as const;
const BUCKET_LABELS = { up: '通过', down: '失败', partial: '部分失败', none: '无观测' } as const;
const IDENTITY: Pose = { transform: 'none', opacity: 1, clipPath: 'inset(0)', visibility: 'visible', pointerEvents: 'auto', transition: 'none' };
const HIDDEN: Pose = { ...IDENTITY, opacity: 0, visibility: 'hidden', pointerEvents: 'none' };
const EASE = 'cubic-bezier(.22,.8,.24,1)';
interface WorkspaceChannel { id: string; name: string; kind: string; enabled: boolean; projects: string[]; events: string[]; }
interface WorkspaceNotificationSettings { defaultChannelIds?: string[]; overrides?: Record<string, string[]>; mutedUntil?: Record<string, number>; acknowledgedAt?: Record<string, number>; }
interface NotificationSnapshot {
  settings?: WorkspaceNotificationSettings;
  definitions?: WorkspaceChannel[];
  error: string;
  updateSettings: (settings: WorkspaceNotificationSettings) => void;
}
function useWorkspaceNotifications(generatedAt: number): NotificationSnapshot {
  const [settings, setSettings] = useState<WorkspaceNotificationSettings>();
  const [definitions, setDefinitions] = useState<WorkspaceChannel[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      apiRequest<{ settings: WorkspaceNotificationSettings }>('/api/uptime/notifications', { signal: controller.signal }),
      apiRequest<{ channels: WorkspaceChannel[] }>('/api/cds-system/alarm-channels', { signal: controller.signal }),
    ]).then(([response, channels]) => {
      if (controller.signal.aborted) return;
      setSettings(response.settings); setDefinitions(channels.channels); setError('');
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '通知设置读取失败，请重试。');
    });
    return () => controller.abort();
  }, [generatedAt]);
  return { settings, definitions, error, updateSettings: (value) => { setSettings(value); setError(''); } };
}
function effectiveNotifications(snapshot: NotificationSnapshot, summary: UptimeSummary, target?: UptimeTargetSummary) {
  const known = snapshot.settings !== undefined && snapshot.definitions !== undefined && !snapshot.error;
  const channelIds = target ? snapshot.settings?.overrides?.[target.id] ?? snapshot.settings?.defaultChannelIds : snapshot.settings?.defaultChannelIds;
  const mutedUntil = target ? snapshot.settings?.mutedUntil?.[target.id] ?? 0 : 0;
  const selectedIds = new Set(snapshot.definitions?.filter((c) => c.enabled && (channelIds === undefined || channelIds.includes(c.id)) && (!target || ((!c.projects.length || c.projects.includes(target.projectId)) && c.events.includes(target.source === 'custom' ? 'business-down' : 'infra-down')))).map((c) => c.id));
  const channels = known ? summary.alarmChannels?.filter((c) => selectedIds.has(c.id)) ?? [] : [];
  const legacy = known && (channelIds === undefined || channelIds.includes('legacy-map')) ? summary.alarm : undefined;
  const verdict = known ? judgeAlarm(legacy, channels) : judgeAlarm(undefined, undefined);
  return { known, channelIds, mutedUntil, channels, legacy, verdict };
}
const time = (at: number): string => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const percent = (value: number | null): string => value == null ? '—' : `${(value * 100).toFixed(2)}%`;

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
}

/** Original design's 24-column band packing, measured against the actual workspace. */
function categoryLayout(categories: WorkspaceCategory[], mode: Exclude<Density, 'auto'>, width: number, height: number) {
  const unit = Math.max(8, (width - 24 - 230) / 24);
  const wOf = (span: number) => span * unit + (span - 1) * 10;
  const itemMin = mode === 'detail' ? 200 : 158;
  const catMin = mode === 'detail' ? 250 : mode === 'label' ? 196 : 214;
  const minSpan = Math.min(24, Math.max(3, Math.ceil((catMin + 10) / (unit + 10))));
  const perMax = Math.max(1, Math.floor(24 / minSpan));
  const weights = categories.map((c) => mode === 'summary' ? 1 + Math.min(c.services.length, 50) / 25 : Math.max(1, c.services.length));
  const count = categories.length;
  const band = (i: number, j: number) => {
    const idx = Array.from({ length: j - i }, (_, q) => q + i);
    if (idx.length > perMax) return null;
    const sum = idx.reduce((a, k) => a + weights[k], 0);
    const raw = idx.map((k) => Math.max(minSpan, 24 * weights[k] / sum));
    const spans = raw.map(Math.floor);
    let remaining = 24 - spans.reduce((a, b) => a + b, 0);
    const order = raw.map((x, q) => ({ fraction: x - Math.floor(x), q })).sort((a, b) => b.fraction - a.fraction);
    let cursor = 0;
    while (remaining > 0) { spans[order[cursor++ % order.length].q]++; remaining--; }
    while (remaining < 0) {
      let largest = -1;
      spans.forEach((x, p) => { if (x > minSpan && (largest < 0 || x > spans[largest])) largest = p; });
      if (largest < 0) return null;
      spans[largest]--; remaining++;
    }
    let rows = 1;
    const columns = idx.map((k, p) => {
      const n = mode === 'summary' ? 1 : Math.max(1, Math.min(Math.ceil(weights[k]), Math.floor((wOf(spans[p]) - 16 + 6) / (itemMin + 6))));
      rows = Math.max(rows, Math.ceil(weights[k] / n));
      return n;
    });
    const h = mode === 'summary' ? 196 * parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 : 46 + rows * (mode === 'detail' ? 112 : 44) + (rows - 1) * (mode === 'detail' ? 6 : 3) + 8;
    return { idx, spans, columns, rows, h };
  };
  type Band = NonNullable<ReturnType<typeof band>>;
  let best: { bands: Band[]; height: number; score: number } | undefined;
  for (let rowCount = Math.max(1, Math.ceil(count / perMax)); rowCount <= Math.min(count, 9); rowCount++) {
    const costs: number[][] = [[0]];
    const previous: number[][] = [[]];
    const avg = count / rowCount;
    for (let b = 1; b <= rowCount; b++) {
      costs[b] = []; previous[b] = [];
      for (let j = 1; j <= count; j++) {
        costs[b][j] = Infinity;
        for (let i = b - 1; i < j; i++) {
          if (!Number.isFinite(costs[b - 1][i])) continue;
          const candidate = band(i, j);
          if (!candidate) continue;
          const cost = mode === 'summary' ? (candidate.idx.length - avg) ** 2 : candidate.h + (candidate.idx.length - avg) ** 2 * .5;
          if (costs[b - 1][i] + cost < costs[b][j]) { costs[b][j] = costs[b - 1][i] + cost; previous[b][j] = i; }
        }
      }
    }
    if (!Number.isFinite(costs[rowCount]?.[count])) continue;
    const bands: Band[] = [];
    let j = count;
    for (let b = rowCount; b > 0; b--) { const i = previous[b][j]; const entry = band(i, j); if (entry) bands.unshift(entry); j = i; }
    const h = bands.reduce((a, b) => a + b.h, 0) + (bands.length - 1) * 10;
    const score = mode === 'summary' ? rowCount : h <= height ? h * .001 + rowCount * .05 : h;
    if (!best || score < best.score) best = { bands, height: h, score };
    if (mode === 'summary') break;
  }
  const span: number[] = [], cols: number[] = [], rows: number[] = [], fractions: string[] = [];
  const fits = Boolean(best && best.height <= height);
  if (best) best.bands.forEach((b) => {
    b.idx.forEach((k, p) => { span[k] = b.spans[p]; cols[k] = b.columns[p]; rows[k] = b.rows; });
    fractions.push(fits ? mode === 'summary' ? '1fr' : `${b.rows}fr` : mode === 'summary' ? '12.25rem' : 'auto');
  });
  else categories.forEach((c, k) => { span[k] = 24; cols[k] = 1; rows[k] = c.services.length; fractions.push('auto'); });
  return { span, cols, rows, template: fractions.join(' '), fits };
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

function ServiceTile({ service: s, category, mode, matches, selected, anchor, onOpen }: { service: WorkspaceService; category: WorkspaceCategory; mode: 'detail' | 'label' | 'summary'; matches: boolean; selected: boolean; anchor: string; onOpen: () => void }) {
  const classes = `${s.state}${matches ? '' : ' dim'}${selected ? ' sel' : ''}`;
  if (mode === 'label') return <button className={`row ${classes}`} data-anchor={anchor} onClick={onOpen} title={s.name}>
    <span className="l1"><Glyph state={s.state} /><span className="nm">{s.name}</span></span>
    <span className="l2"><span className="mono">{s.state === 'ok' ? s.latency : serviceStateLabel(s)}</span><span>{s.state === 'ok' ? `24h ${s.rate}` : s.reason}</span></span>
  </button>;
  if (mode === 'summary') return <button className={`rep ${classes}`} data-anchor={anchor} onClick={onOpen}><Glyph state={s.state} /><span className="nm">{s.name}</span><span className="v">{s.latency}</span></button>;
  return <button className={`tile ${classes}`} data-anchor={anchor} onClick={onOpen} title={`${category.name} · ${s.name}`}>
    <span className="tn"><Glyph state={s.state} /><span className="nm">{s.name}</span></span>
    <span className={`ts ${s.state}`}>{serviceStateLabel(s)} · {s.reason}</span>
    <span className="tm"><span>延迟 <b>{s.latency}</b></span><span>24h <b>{s.rate}</b></span><span className="ago">{s.ago}</span></span>
    <Sparkline buckets={s.target.buckets} />
  </button>;
}

function AlertNotification({ service, notifications, summary, now }: { service: WorkspaceService; notifications: NotificationSnapshot; summary: UptimeSummary; now: number }) {
  const config = effectiveNotifications(notifications, summary, service.target);
  const names = config.channels.map((c) => c.name).concat(config.legacy && config.legacy.status !== 'unconfigured' ? [config.legacy.channel] : []);
  const text = !config.known ? '通知规则待确认' : config.mutedUntil > now ? `已静默至 ${time(config.mutedUntil)}` : names.length ? `${names.length} 条通知通道` : '未配置适用的通知通道';
  return <span className="ai-n ai-one"><span className="ai-nt">{text}</span>{config.mutedUntil <= now && names.slice(0, 2).map((name, i) => <span className="chn" key={`${name}:${i}`}>{name}</span>)}</span>;
}

function ServiceDetail({ service: s, category, summary, incidents, now, onNotify, onProbe, onManage, notifications }: { service: WorkspaceService; category: WorkspaceCategory; summary: UptimeSummary; incidents: UptimeIncidentView[]; now: number; onNotify: () => void; onProbe: () => Promise<void>; onManage: () => void; notifications: NotificationSnapshot }) {
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState('');
  const notificationSettings = notifications.settings;
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationMutationError, setNotificationMutationError] = useState('');
  const notificationError = notificationMutationError || notifications.error;
  const acknowledgedAt = notificationSettings?.acknowledgedAt?.[s.id];
  const acknowledged = Boolean(acknowledgedAt && acknowledgedAt >= (s.target.openIncidentSince ?? s.target.statusSince ?? 0));
  const muteUntil = notificationSettings?.mutedUntil?.[s.id] ?? 0;
  const muted = muteUntil > now;
  const updateNotification = async (body: { acknowledged?: boolean; muteUntil?: number | null }) => {
    setNotificationBusy(true); setNotificationMutationError('');
    try { const response = await apiRequest<{ settings: WorkspaceNotificationSettings }>('/api/uptime/notifications', { method: 'PUT', body: { targetId: s.id, ...body } }); notifications.updateSettings(response.settings); }
    catch (error) { setNotificationMutationError(error instanceof Error ? error.message : '通知设置未保存，请重试。'); }
    finally { setNotificationBusy(false); }
  };
  const { known: knownNotifications, channelIds, channels, legacy, verdict } = effectiveNotifications(notifications, summary, s.target);
  const serviceNotificationText = !knownNotifications ? '通知规则尚未读取成功，当前无法确认此服务会通知谁。'
    : muted ? `此服务已静默至 ${time(muteUntil)}，期间不发送通知；观测继续更新。`
    : channelIds?.length === 0 ? '此服务未选择通知通道，异常与恢复均不发送通知。'
    : channels.length === 0 && (!legacy || legacy.status === 'unconfigured') ? '当前没有可用于此服务的通知通道，请检查通道的项目与事件订阅。'
    : verdict.text.replace(/（缺 [^）]*）/g, '');
  const events = incidents.filter((e) => e.targetId === s.id).flatMap((e) => [{ at: e.startedAt, state: 'bad', text: e.cause || '检测到异常' }, ...(e.endedAt ? [{ at: e.endedAt, state: 'ok', text: '检查恢复通过' }] : [])]).sort((a, b) => b.at - a.at).slice(0, 12);
  const [range, setRange] = useState<HistoryRange>('24h');
  const [history, setHistory] = useState<{ id: string; range: HistoryRange; value: UptimeHistory }>();
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [rates, setRates] = useState<Partial<Record<HistoryRange, string>>>({});
  useEffect(() => {
    setRange('24h'); setHistory(undefined); setRates({});
  }, [s.id]);
  useEffect(() => {
    const controller = new AbortController();
    setHistoryBusy(true); setHistoryError('');
    apiRequest<UptimeHistory>(`/api/uptime/targets/${encodeURIComponent(s.id)}/history?range=${range}&points=48`, { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setHistory({ id: s.id, range, value });
      const total = value.points.reduce((sum, b) => sum + b.up + b.down, 0);
      const up = value.points.reduce((sum, b) => sum + b.up, 0);
      setRates((prev) => ({ ...prev, [range]: total ? percent(up / total) : '—' }));
    }).catch((error: unknown) => { if (!controller.signal.aborted) setHistoryError(error instanceof Error ? error.message : '历史记录读取失败，请重新选择时间范围重试。'); }).finally(() => { if (!controller.signal.aborted) setHistoryBusy(false); });
    return () => controller.abort();
  }, [s.id, range, summary.generatedAt]);
  const currentHistory = history?.id === s.id && history.range === range ? history.value : undefined;
  const buckets = currentHistory?.points ?? (range === '24h' ? s.target.buckets : []);
  const points = buckets.map((b, i) => ({ i, v: b.avgLatencyMs })).filter((p): p is { i: number; v: number } => p.v != null);
  const max = Math.max(1, ...points.map((p) => p.v));
  const paths: string[] = [];
  for (const p of points) {
    const prev = points[points.indexOf(p) - 1];
    const point = `${p.i / Math.max(1, buckets.length - 1) * 480} ${92 - p.v / max * 80}`;
    if (!prev || prev.i !== p.i - 1) paths.push(`M${point}`); else paths[paths.length - 1] += ` L${point}`;
  }
  const check = async () => { setProbing(true); setProbeError(''); try { await onProbe(); } catch (error) { setProbeError(error instanceof Error ? error.message : '检查未完成，请重试。'); } finally { setProbing(false); } };
  return <div className="sv">
    <div className="svh"><div><p className="eyebrow">{category.name} / 服务详情</p><h2>{s.name}</h2></div><span className={`pill ${s.state}`}><Glyph state={s.state} />当前 · {serviceStateLabel(s)}</span><span className="sp" />{s.state === 'bad' && <><button className="btn ghost sm" disabled={notificationBusy || notificationSettings === undefined} onClick={() => void updateNotification({ acknowledged: !acknowledged })}>{acknowledged ? '已确认 · 撤销' : '确认处理'}</button><button className="btn ghost sm" disabled={notificationBusy || notificationSettings === undefined} onClick={() => void updateNotification({ muteUntil: muted ? null : Date.now() + 30 * 60_000 })}>{muted ? '取消静默' : '静默 30 分钟'}</button></>}<button className="btn ghost sm" disabled={probing} onClick={() => void check()}>{probing ? '正在检查…' : '立即检查'}</button><button className="btn ghost sm" onClick={onNotify}>通知设置</button></div>
    <div className="svm">
      {probeError && <p role="alert" className="ts bad">{probeError}</p>}{notificationError && <p role="alert" className="ts bad">{notificationError}</p>}{muted && <p className="note">已静默至 {time(muteUntil)}，观测继续更新。</p>}
      <div className="two rv rv2"><div className={`now ${s.state}`}><h3>当前状态</h3><div className="big"><Glyph state={s.state} large />{serviceStateLabel(s)}</div><p className="why">{s.reason}</p><p className="meta">{s.target.statusSince ? `状态开始于 ${time(s.target.statusSince)}` : '等待有效的观测结果'}</p><p className="meta">最近检查 {s.ago} · 每 {s.target.intervalSeconds} 秒 · {s.target.environmentLabel}</p></div><div className="card"><h3>历史通过率</h3><div className="rates" role="group" aria-label="历史时间范围">{([{ key: '24h', label: '最近 24 小时', fallback: s.rate }, { key: '7d', label: '最近 7 天', fallback: percent(s.target.availability7d) }, { key: '30d', label: '最近 30 天', fallback: '—' }] as const).map((r) => <button key={r.key} className={`rate${range === r.key ? ' active' : ''}`} aria-pressed={range === r.key} onClick={() => setRange(r.key)}><b>{rates[r.key] ?? r.fallback}</b><span>{r.label}</span></button>)}</div><p className="note">当前状态与历史通过率独立；无观测时段不计入通过率。</p></div></div>
      <div className="card rv rv2"><div className="card-h"><h3>{range === '24h' ? '最近 24 小时' : range === '7d' ? '最近 7 天' : '最近 30 天'}观测</h3><div className="legend"><span><i className="lg-ok" />通过</span><span><i className="lg-part" />部分失败</span><span><i className="lg-fail" />失败</span><span><i className="lg-gap" />无观测</span></div></div><div aria-busy={historyBusy}>{historyBusy && <div className="history-progress" role="status" aria-label="正在读取历史观测" />}{historyError && <p className="ts bad" role="alert">{historyError}</p>}<HistoryStrip buckets={buckets} /></div><div className="ticks">{[4, 3, 2, 1, 0].map((step) => { const at = now - step / 4 * (range === '24h' ? 24 : range === '7d' ? 168 : 720) * 3_600_000; return <span key={step}>{step === 0 ? '现在' : range === '24h' ? time(at) : new Date(at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</span>; })}</div><div className="lat-h"><span>响应延迟</span><span className="mono">当前 {s.latency} · 平均 {s.target.avgLatencyMs24h == null ? '—' : `${Math.round(s.target.avgLatencyMs24h)} ms`}</span></div>{points.length ? <svg className="lat" viewBox="0 0 480 100" preserveAspectRatio="none" role="img" aria-label="最近24小时实际响应延迟">{paths.map((d, i) => <path key={i} className="ln" d={d} />)}</svg> : <div className="lat lat-empty">尚无可用延迟观测，首次检查后自动显示</div>}</div>
      <div className="grid2 rv rv3"><div className="card"><h3>当前观测</h3><div className="rt"><span className="rh">环境</span><span className="rh">当前</span><span className="rh">延迟</span><span className="rh">检查</span><span>{s.target.environmentLabel}</span><span className="c"><Glyph state={s.state} />{serviceStateLabel(s)}</span><span className="mono">{s.latency}</span><span className="mono">{s.ago}</span></div><p className="note">{s.target.observeMode === 'passive' ? '读取真实业务调用的观测窗口' : '按设定间隔主动检查'}；仅展示已接入的观测来源。</p></div><div className="card"><h3>最近事件</h3><div className="ev">{events.length ? events.map((e, i) => <div className="evi" key={`${e.at}:${i}`}><span className="t">{time(e.at)}</span><span className={`evd ${e.state}`} /><span>{e.text}</span></div>) : <p className="note">暂无已记录的故障或恢复事件。</p>}</div></div></div>
    </div>
    <div className="svs rv rv3"><div className="card"><div className="card-h"><h3>{muted ? '通知已静默' : '异常通知'}</h3><span className="tag">通知通道</span></div><p className="lbl">发到哪里</p><div className="chl-list">{channels.map((c) => <div className="chl" key={c.id}><span className="chn2">{c.name}</span><span className="dest">{c.kind}</span><span className={c.status === 'healthy' ? 'dl-ok' : 'ts warn'}>{c.status === 'healthy' ? '最近投递成功' : c.status === 'failing' ? '发送失败' : '待验证'}</span></div>)}</div>{legacy && legacy.status !== 'unconfigured' && <div className="chl"><span className="chn2">{legacy.channel}</span><span className="dest">MAP</span><span className={legacy.status === 'healthy' ? 'dl-ok' : 'ts warn'}>{legacy.status === 'healthy' ? '最近投递成功' : legacy.status === 'failing' ? '上次未送达' : '尚未验证送达'}</span></div>}<p className="note">{serviceNotificationText}</p><button className="btn ghost sm full" onClick={onNotify}>为此服务调整通知</button></div><div className="card"><h3>如何检查</h3><dl className="kv"><dt>观测方式</dt><dd>{s.target.observeMode === 'passive' ? '被动观测' : '主动检查'}</dd><dt>检查说明</dt><dd>{s.target.probeDescription}</dd><dt>检查间隔</dt><dd>{s.target.intervalSeconds} 秒</dd><dt>超时</dt><dd>{s.target.timeoutMs / 1000} 秒</dd><dt>最近检查</dt><dd>{s.target.lastSample ? formatRelative(s.target.lastSample.t, now) : '尚未检查'}</dd></dl><button className="linkb" onClick={onManage}>管理此项监控 <ChevronRight className="ic xs" /></button></div></div>
  </div>;
}

export function MonitorWorkspace({ targets, summary, incidents, now, onAdd, onNotify, onProbe, onManage, onReload }: MonitorWorkspaceProps): JSX.Element {
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
  const [query, setQuery] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [status, setStatus] = useState<WorkspaceState | 'all'>('all');
  const [source, setSource] = useState<'all' | 'public' | 'custom'>('all');
  const [density, setDensity] = useState<Density>('auto');
  const [sort, setSort] = useState<'original' | 'issues'>('original');
  const [railOpen, setRailOpen] = useState(false);
  const [noneOpen, setNoneOpen] = useState(false);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [size, setSize] = useState({ width: 1200, height: 750 });
  const current = stack[stack.length - 1];
  const automaticMode = useRef<Exclude<Density, 'auto'>>();
  if (!automaticMode.current && model.services.length) automaticMode.current = automaticDensity(model.services.length);
  const mode = density === 'auto' ? automaticMode.current ?? 'detail' : density;
  const layoutCache = useRef<{ key: string; categoryIds: string[]; value: ReturnType<typeof categoryLayout> }>();
  const measuredRows = useRef<{ key: string; categoryIds: string; template: string }>();
  const layoutKey = JSON.stringify([mode, size.width, size.height]);
  const ids = model.categories.map((c) => c.id);
  const previous = layoutCache.current;
  if (!previous || previous.key !== layoutKey || previous.categoryIds.some((id) => !ids.includes(id))) {
    // Only an explicit density/viewport change, or a removed category, repacks the canvas.
    layoutCache.current = { key: layoutKey, categoryIds: ids, value: categoryLayout(model.categories, mode, size.width, size.height) };
  } else {
    const added = model.categories.filter((c) => !previous.categoryIds.includes(c.id));
    const snapshot = measuredRows.current;
    const measuredTemplate = snapshot?.key === layoutKey && snapshot.categoryIds === JSON.stringify(previous.categoryIds) ? snapshot.template : undefined;
    if (added.length) {
      // Freeze the actual old band heights before appending full-width rows below.
      // Existing category coordinates stay fixed; new rows use natural local sizing.
      const value = previous.value;
      const span = [...value.span], cols = [...value.cols], rows = [...value.rows];
      for (const category of added) {
        const columns = Math.max(1, Math.min(category.services.length, Math.floor((size.width - 40) / (mode === 'detail' ? 206 : 164))));
        span.push(24); cols.push(columns); rows.push(Math.ceil(category.services.length / columns));
      }
      layoutCache.current = { key: layoutKey, categoryIds: ids, value: { span, cols, rows, fits: false, template: `${measuredTemplate ?? value.template} ${added.map(() => 'auto').join(' ')}` } };
    } else if (!previous.value.fits && previous.value.template.includes('auto') && measuredTemplate) {
      // A previously appended row also keeps its measured height on later polling.
      layoutCache.current = { ...previous, value: { ...previous.value, template: measuredTemplate } };
    }
  }
  const layout = layoutCache.current!.value;
  useLayoutEffect(() => {
    const grid = root.current?.querySelector<HTMLElement>('.cg');
    if (!grid) return;
    const record = () => {
      const template = getComputedStyle(grid).gridTemplateRows;
      if (template && template !== 'none') measuredRows.current = { key: layoutKey, categoryIds: JSON.stringify(ids), template };
    };
    record();
    const observer = new ResizeObserver(record); observer.observe(grid);
    return () => observer.disconnect();
  }, [layoutKey, JSON.stringify(ids), layout.template]);
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
    const observer = new ResizeObserver(() => { setSize({ width: element.clientWidth, height: element.clientHeight }); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const target = e.target as Element;
      if (!target.closest('.search')) setDropdownOpen(false);
      if (!target.closest('.monitor-nav-menu')) root.current?.querySelector<HTMLDetailsElement>('.monitor-nav-menu')?.removeAttribute('open');
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
  const zoomed = (rect: Box): Pose => { const cam = camera(rect); return { ...IDENTITY, transform: `translate(${cam.x}px,${cam.y}px) scale(${cam.scale})`, opacity: .15, pointerEvents: 'none' }; };
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
    if (entry.serviceId) setServiceId(entry.serviceId);
    setStack((prev) => prev.concat(entries)); setDropdownOpen(false);
    const initial = { g: HIDDEN, c: HIDDEN, s: HIDDEN }; initial[from] = IDENTITY; initial[to] = reduced ? { ...IDENTITY, opacity: 0 } : collapsed(rect);
    setPoses(initial); setStage({ [to]: 'pre' });
    raf(() => {
      setStage({}); setPoses({ ...initial, [from]: reduced ? { ...IDENTITY, opacity: 0, transition: 'opacity 160ms linear' } : { ...zoomed(rect), transition: `transform 520ms ${EASE}, opacity 520ms ${EASE}` }, [to]: { ...IDENTITY, transition: reduced ? 'opacity 160ms linear' : `transform 520ms ${EASE}, clip-path 520ms ${EASE}, opacity 220ms linear 40ms` } });
      later(reduced ? 190 : 560, () => { setPoses({ g: HIDDEN, c: HIDDEN, s: HIDDEN, [to]: IDENTITY }); busyRef.current = false; });
    });
  };
  const pop = (index = stackRef.current.length - 2, then?: () => void) => {
    const history = stackRef.current;
    if (busyRef.current || index < 0 || index >= history.length - 1) return;
    busyRef.current = true;
    const from = history[history.length - 1], to = history[index], via = history[index + 1];
    const anchor = findAnchor(to.kind, via.kind === 'c' ? `cat:${via.categoryId}` : `svc:${via.serviceId}`) ?? findAnchor(to.kind, `cat:${via.categoryId}`);
    const rect = anchor ? relative(anchor) : via.rect ?? { x: size.width / 2 - 90, y: size.height / 2 - 60, w: 180, h: 120 };
    const initial = { g: HIDDEN, c: HIDDEN, s: HIDDEN }; initial[from.kind] = IDENTITY; initial[to.kind] = reduced ? IDENTITY : zoomed(rect); setPoses(initial);
    raf(() => {
      setStage({ [from.kind]: 'out' }); setPoses({ ...initial, [to.kind]: { ...IDENTITY, transition: reduced ? 'none' : `transform 460ms ${EASE}, opacity 460ms ${EASE}` }, [from.kind]: reduced ? { ...IDENTITY, opacity: 0, transition: 'opacity 160ms linear' } : { ...collapsed(rect), transition: `transform 460ms ${EASE}, clip-path 460ms ${EASE}, opacity 180ms linear 280ms` } });
      later(reduced ? 190 : 500, () => { setStack(history.slice(0, index + 1)); setPoses({ g: HIDDEN, c: HIDDEN, s: HIDDEN, [to.kind]: IDENTITY }); setStage({}); busyRef.current = false; if (then) later(40, then); });
    });
  };
  const openCategory = (c: WorkspaceCategory) => {
    if (busyRef.current) return;
    if (stackRef.current.length > 1) { const existing = stackRef.current.findIndex((e) => e.kind === 'c' && e.categoryId === c.id); if (existing > 0) { if (existing < stackRef.current.length - 1) pop(existing); return; } pop(0, () => openCategory(c)); return; }
    const el = findAnchor('g', `cat:${c.id}`); if (!el) return;
    push([{ kind: c.services.length === 1 ? 's' : 'c', categoryId: c.id, serviceId: c.services.length === 1 ? c.services[0].id : undefined, rect: relative(el) }]);
  };
  const openService = (s: WorkspaceService) => {
    if (busyRef.current || stackRef.current.at(-1)?.serviceId === s.id) return;
    const c = model.categories.find((entry) => entry.id === s.categoryId); if (!c) return;
    const from = stackRef.current.at(-1)!;
    if (from.kind === 's' && from.categoryId === c.id && stackRef.current.length > 2) { pop(stackRef.current.length - 2, () => openService(s)); return; }
    if (from.kind !== 'g' && !(from.kind === 'c' && from.categoryId === c.id)) { pop(0, () => openService(s)); return; }
    const el = findAnchor(from.kind, `svc:${s.id}`) ?? findAnchor('g', `cat:${c.id}`); if (!el) return;
    const entries: Location[] = [];
    if (from.kind === 'g' && c.services.length > 1) { const ce = findAnchor('g', `cat:${c.id}`); entries.push({ kind: 'c', categoryId: c.id, rect: ce ? relative(ce) : relative(el) }); }
    entries.push({ kind: 's', categoryId: c.id, serviceId: s.id, rect: relative(el) }); push(entries);
  };
  const resetDensity = (value: Density) => { if (busyRef.current) return; if (value === 'auto') automaticMode.current = automaticDensity(model.services.length); setDensity(value); setStack((prev) => prev.map((entry) => ({ ...entry, rect: undefined }))); };
  const categoryServices = category ? sort === 'issues' ? [...category.services].sort((a, b) => ({ bad: 0, warn: 1, none: 2, ok: 3 }[a.state]) - ({ bad: 0, warn: 1, none: 2, ok: 3 }[b.state])) : category.services : [];
  const tokens = (c: WorkspaceCategory, labels = false) => (Object.keys(STATES) as WorkspaceState[]).filter((state) => c.counts[state]).map((state) => <span className={`ctok ${state === 'ok' ? 'okt' : ''}`} key={state}><Glyph state={state} /><b>{c.counts[state]}</b>{labels ? STATES[state] : null}</span>);
  return <div className="monitor-workspace" ref={root}>
    <nav className="nav" aria-label="监控导航">
      <a className="logo" href="/project-list" aria-label="返回项目列表" title="返回项目列表"><svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg></a>
      <details className="monitor-nav-menu">
        <summary className="navb on" aria-label="切换监控视图" title="切换监控视图"><svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg></summary>
        <div className="monitor-nav-links"><a href="/status?view=catalog">监控列表</a><a href="/status?view=history">处理记录</a><a href="/status?view=owner">监控管理</a></div>
      </details>
      <button className="navb" aria-label="需要处理" title="需要处理" onClick={() => setRailOpen(!railOpen)}><svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>{model.counts.bad > 0 && <span className="badge">{model.counts.bad}</span>}</button>
      <button className="navb" aria-label="通知设置" title="通知设置" onClick={() => onNotify()}><svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg></button>
      <button className="navb" aria-label="接入我的服务" title="接入我的服务" onClick={onAdd}><svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22v-5M9 8V2M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" /></svg></button>
      <div className="nav-foot"><button className={`rm-b${reduced ? ' on' : ''}`} aria-label="减少动态效果" title="减少动态效果" aria-pressed={reduced} onClick={() => setReduced(!reduced)}><svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7" /></svg></button></div>
    </nav>
    <div className="main">
      <header className="t1"><h1>监控总览</h1><span className="scope">订阅 {model.services.length} 项服务 · {model.categories.length} 个分类</span><div className="tokens" role="group" aria-label="按当前状态筛选">{(Object.keys(STATES) as WorkspaceState[]).map((state) => <button key={state} className={`tok ${state}${status === state ? ' on' : ''}`} aria-pressed={status === state} onClick={() => setStatus(status === state ? 'all' : state)}><Glyph state={state} /><b>{model.counts[state]}</b>{STATES[state]}</button>)}</div><span className="sp" /><button className="fresh mono" onClick={onReload} title="刷新监控数据">刷新于 {time(summary.generatedAt)} · 只更新状态</button><button className="btn ghost" onClick={() => onNotify()}><Send className="ic s" />通知设置</button><button className="btn pri" onClick={onAdd}><Plus className="ic s" />接入我的服务</button></header>
      <div className="t2"><div className="search"><Search className="ic s" /><input type="search" aria-label="搜索服务或分类" placeholder="搜索服务、分类，结果可直接定位" value={query} onChange={(e) => { setQuery(e.target.value); setDropdownOpen(true); }} onFocus={() => setDropdownOpen(true)} onKeyDown={(e) => { if (e.key === 'Escape') setDropdownOpen(false); if (e.key === 'Enter' && results[0]) openService(results[0]); }} />{dropdownOpen && q && <div className="dd"><p className="dd-h">{results.length ? `匹配服务 · 最多显示 8 项` : '没有找到匹配的服务或分类'}</p>{results.map((s) => <button key={s.id} onClick={() => openService(s)}><Glyph state={s.state} /><span className="nm">{s.name}</span><span className="loc">{model.categories.find((c) => c.id === s.categoryId)?.name}</span></button>)}</div>}</div>{q && <button className="linkb" onClick={() => { setQuery(''); setDropdownOpen(false); }}>清除搜索</button>}<div className="seg" role="group" aria-label="来源">{([{ key: 'all', label: '全部来源' }, { key: 'public', label: '公共基础设施' }, { key: 'custom', label: '我的服务' }] as const).map((x) => <button key={x.key} className={source === x.key ? 'on' : ''} aria-pressed={source === x.key} onClick={() => setSource(x.key)}>{x.label}</button>)}</div><span className="sp" /><span className="seg-l">视图</span><div className="seg vseg" role="group" aria-label="视图密度">{([{ key: 'auto', label: '自动' }, { key: 'detail', label: '详细' }, { key: 'label', label: '紧凑' }, { key: 'summary', label: '概要' }] as const).map((x) => <button key={x.key} className={density === x.key ? 'on' : ''} aria-pressed={density === x.key} onClick={() => resetDensity(x.key)}>{x.label}</button>)}</div></div>
      <div className="t2r"><button className="rail-tg" aria-expanded={railOpen} onClick={() => setRailOpen(!railOpen)}><h2>需要处理</h2><span className="cnt bad">{model.counts.bad} 异常</span><span className="cnt warn">{model.counts.warn} 待确认</span><ChevronDown className="ic s chev" /></button></div>
      <section className="wsw" aria-label="工作区"><div className="crumbs"><button className="cb" disabled={stack.length === 1} onClick={() => pop()} aria-label="返回上一级"><ArrowLeft className="ic s" />返回</button>{stack.map((entry, i) => <Fragment key={`${entry.kind}:${i}`}>{i > 0 && <span className="csep">/</span>}{i === stack.length - 1 ? <span className="crumb-t cur">{entry.kind === 'g' ? '全部服务' : entry.kind === 'c' ? model.categories.find((c) => c.id === entry.categoryId)?.name : model.services.find((s) => s.id === entry.serviceId)?.name}</span> : <button className="cb" onClick={() => pop(i)}>{entry.kind === 'g' ? '全部服务' : model.categories.find((c) => c.id === entry.categoryId)?.name}</button>}</Fragment>)}<span className="sp" />{current.kind !== 'g' && <div className="oth"><span className="lab">其他分类</span>{model.categories.filter((c) => c.id !== categoryId && c.counts.bad + c.counts.warn > 0).map((c) => <button key={c.id} className={`ochip${c.counts.bad ? '' : ' w'}`} onClick={() => openCategory(c)}><Glyph state={c.counts.bad ? 'bad' : 'warn'} />{c.name} · {c.counts.bad + c.counts.warn}</button>)}</div>}{current.kind === 'g' && <span className="mode-l">{mode === 'detail' ? '服务详情' : mode === 'label' ? '分类与服务标签' : '分类状态分布'} · 位置保持稳定</span>}</div>
        <div className="ws" ref={workspace}>
          <div className={`layer Lg ${stage.g ?? ''}${reduced ? ' nomo' : ''}`} aria-hidden={current.kind !== 'g'} style={poses.g}>
            {model.categories.length ? <div className={`cg m-${mode}${layout.fits ? ' fit' : ''}`} style={{ gridTemplateRows: layout.template }}>{model.categories.map((c, i) => <div key={c.id} className={`cat${c.services.some((s) => matches(s, c)) ? '' : ' dim'}${categoryId === c.id && current.kind !== 'g' ? ' sel' : ''}`} style={{ gridColumn: `span ${layout.span[i]}` }} data-anchor={`cat:${c.id}`}><button className="ch" onClick={() => openCategory(c)} aria-label={`打开${c.name}，${c.services.length}项服务`}><span className="cn">{c.name}</span><span className="cc">{c.services.length} 项</span>{c.custom && <span className="tag acc">自定义</span>}<span className="ctoks">{tokens(c)}</span><span className="go"><ChevronRight className="ic s" /></span></button>{mode !== 'summary' ? <div className="cb2"><div className={mode === 'detail' ? 'tiles' : 'rows'} style={{ gridTemplateColumns: `repeat(${layout.cols[i]},minmax(0,1fr))` }}>{c.services.map((s) => <ServiceTile key={s.id} service={s} category={c} mode={mode} matches={matches(s, c)} selected={serviceId === s.id && current.kind !== 'g'} anchor={`svc:${s.id}`} onOpen={() => openService(s)} />)}</div></div> : <div className="sum">{c.services.some((s) => s.state === 'bad' || s.state === 'warn') && <div className="need">{c.services.filter((s) => s.state === 'bad' || s.state === 'warn').slice(0, 2).map((s) => <button key={s.id} className={`nd ${s.state}${matches(s, c) ? '' : ' dim'}`} data-anchor={`svc:${s.id}`} onClick={() => openService(s)}><Glyph state={s.state} /><span className="nm">{s.name}</span><span className="why">{serviceStateLabel(s)}</span></button>)}{c.counts.bad + c.counts.warn > 2 && <span className="more">另有 {c.counts.bad + c.counts.warn - 2} 项需关注</span>}</div>}<div className="reps"><span className="reps-h">代表服务</span>{c.services.filter((s) => s.state !== 'bad' && s.state !== 'warn').slice(0, 3).map((s) => <ServiceTile key={s.id} service={s} category={c} mode="summary" matches={matches(s, c)} selected={serviceId === s.id && current.kind !== 'g'} anchor={`svc:${s.id}`} onOpen={() => openService(s)} />)}</div><button className="more-b" onClick={() => openCategory(c)}>查看全部 {c.services.length} 项</button></div>}</div>)}</div> : <div className="workspace-empty"><h2>接入服务，开始统一观测</h2><p>已接入的公共基础设施和个人服务会铺满这里。</p><button className="btn pri" onClick={onAdd}><Plus className="ic s" />接入我的服务</button></div>}
          </div>
          <div className={`layer Lc ${stage.c ?? ''}${reduced ? ' nomo' : ''}`} aria-hidden={current.kind !== 'c'} style={poses.c}>{category && <div className="lv"><div className="lvh"><div><p className="eyebrow">分类 · {category.custom ? '我的服务' : '公共基础设施'} · {category.services.length} 项</p><h2>{category.name}</h2></div><div className="ltoks">{tokens(category, true)}</div><span className="sp" /><div className="lvn rv rv2"><Bell className="ic xs" />异常通知 <b>{verdict.live} 条通道最近投递成功</b><button className="linkb" onClick={() => onNotify()}>调整</button></div><div className="seg rv rv2" role="group" aria-label="排列"><button className={sort === 'original' ? 'on' : ''} onClick={() => setSort('original')}>原始顺序</button><button className={sort === 'issues' ? 'on' : ''} onClick={() => setSort('issues')}>异常优先</button></div></div><div className="ctiles rv rv2">{categoryServices.map((s) => <ServiceTile key={s.id} service={s} category={category} mode="detail" matches={matches(s, category)} selected={serviceId === s.id && current.kind === 's'} anchor={`svc:${s.id}`} onOpen={() => openService(s)} />)}</div></div>}</div>
          <div className={`layer Ls ${stage.s ?? ''}${reduced ? ' nomo' : ''}`} aria-hidden={current.kind !== 's'} style={poses.s}>{service && category && <ServiceDetail key={service.id} service={service} category={category} summary={summary} incidents={incidents} now={now} onNotify={() => onNotify(service.id)} onProbe={() => onProbe(service.id)} onManage={() => onManage(service.id)} notifications={notifications} />}</div>
        </div>
      </section>
      <aside className={`alw${railOpen ? '' : ' closed'}`} aria-label="需要处理的异常"><div className="al">{alerts.length === 0 && <div className="al-empty">当前没有需要处理的异常</div>}{alerts.map((s) => <button className={`ai ${s.state}${current.kind === 's' && serviceId === s.id ? ' cur' : ''}`} key={s.id} onClick={() => openService(s)}><span className="ai-h"><Glyph state={s.state} /><span className="nm">{s.name}</span><span className="dur">{s.target.statusSince ? formatRelative(s.target.statusSince, now) : '等待检查'}</span></span><span className={`ai-why ${s.state}`}>{s.reason}</span><span className="ai-where">{model.categories.find((c) => c.id === s.categoryId)?.name} · {s.target.environmentLabel}</span><AlertNotification service={s} notifications={notifications} summary={summary} now={now} /></button>)}<div className="al-sec"><button className="al-tg" aria-expanded={noneOpen} onClick={() => setNoneOpen(!noneOpen)}><Glyph state="none" />无观测 {model.counts.none} 项<span className="sp" />{noneOpen ? '收起' : '展开'}</button>{noneOpen && model.services.filter((s) => s.state === 'none').map((s) => <button key={s.id} className="ain" onClick={() => openService(s)}><span className="nm">{s.name}</span><span className="ai-loc">{model.categories.find((c) => c.id === s.categoryId)?.name} · {s.reason}</span></button>)}</div></div><div className="al-foot"><div className="mm"><div className="mm-h"><span>全局位置</span><b>{current.kind === 'g' ? '全部分类' : category?.name}</b></div><div className="mmg" style={{ gridTemplateRows: workspaceMinimapRows(layout.template) }}>{model.categories.map((c, i) => <button key={c.id} className={`mmb${c.counts.bad ? ' bad' : c.counts.warn ? ' warn' : ''}${categoryId === c.id && current.kind !== 'g' ? ' cur' : ''}`} style={{ gridColumn: `span ${layout.span[i]}` }} aria-label={`定位${c.name}`} title={c.name} onClick={() => openCategory(c)} />)}</div></div><div className="al-def"><div className="al-def-r"><span className="al-def-h">默认通知</span><span className="sp" /><button className="linkb" onClick={() => onNotify()}>调整</button></div><span className="ai-n">{globalNotification.channels.map((c) => <span className="chn" key={c.id}>{c.name}</span>)}{globalNotification.legacy && globalNotification.legacy.status !== 'unconfigured' && <span className="chn">{globalNotification.legacy.channel}</span>}</span><span className="ai-loc">{globalNotificationText}</span></div></div></aside>
    </div>
  </div>;
}
