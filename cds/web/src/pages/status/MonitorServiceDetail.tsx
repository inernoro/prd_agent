import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ChevronRight, Link2, X } from 'lucide-react';
import { apiRequest } from '@/lib/api';
import { buildMeasurementChart, formatMeasurementValue, incidentNotificationSnapshot, measurementView } from '@/lib/monitorMeasurement';
import { formatRelative, type HistoryRange, type UptimeBucket, type UptimeHistory, type UptimeIncidentView, type UptimeSummary } from '@/lib/monitorCenter';
import type { WorkspaceCategory, WorkspaceService, WorkspaceState } from '@/lib/monitorWorkspace';
import { effectiveNotifications, type NotificationSnapshot, type WorkspaceNotificationSettings } from './useMonitorNotifications';
import './monitor-service-detail.css';

const STATES: Record<WorkspaceState, string> = { ok: '正常', bad: '异常', warn: '待确认', none: '无观测' };
const BUCKET_STATES = { up: 'ok', down: 'fail', partial: 'part', none: 'gap' } as const;
const BUCKET_LABELS = { up: '满足检查条件', down: '检查失败', partial: '部分失败', none: '无观测' } as const;
const percent = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(2)}%`;
const time = (at: number): string => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

export interface ServiceDetailEntry {
  incidentId?: string;
  /** URL reference only. A timestamp never supplies the content of an observation. */
  detectedAt?: string;
  source?: string;
}

export interface ServiceDetailProps {
  service: WorkspaceService;
  category: WorkspaceCategory;
  summary: UptimeSummary;
  incidents: UptimeIncidentView[];
  now: number;
  onNotify: () => void;
  onProbe: () => Promise<void>;
  onManage: () => void;
  notifications: NotificationSnapshot;
  entry?: ServiceDetailEntry;
  onOpenService?: (targetId: string) => void;
}

function Glyph({ state, large = false }: { state: WorkspaceState; large?: boolean }): JSX.Element {
  return <span className={`gl ${state}${large ? ' lg' : ''}`} role="img" aria-label={STATES[state]} />;
}

function HistoryStrip({ buckets }: { buckets: readonly UptimeBucket[] }): JSX.Element {
  return <div className="hist" aria-label="历史检查状态">{buckets.length ? buckets.map((bucket, i) => <span key={`${bucket.from}:${i}`} className={`hc ${BUCKET_STATES[bucket.status]}`} title={`${time(bucket.from)}–${time(bucket.to)} · ${BUCKET_LABELS[bucket.status]} · ${bucket.up + bucket.down} 次观测`} />)
    : Array.from({ length: 48 }, (_, i) => <span key={i} className="hc gap" title="尚无观测数据" />)}</div>;
}

export function ServiceDetail({ service: service, category, summary, incidents, now, onNotify, onProbe, onManage, notifications, entry, onOpenService }: ServiceDetailProps): JSX.Element {
  const target = service.target;
  const label = service.fresh ? '等待首次观测' : STATES[service.state];
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState('');
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationMutationError, setNotificationMutationError] = useState('');
  const [linkClosed, setLinkClosed] = useState(false);
  const settings = notifications.settings;
  const acknowledgedAt = settings?.acknowledgedAt?.[service.id];
  const acknowledged = Boolean(acknowledgedAt && acknowledgedAt >= (target.openIncidentSince ?? target.statusSince ?? 0));
  const mutedUntil = settings?.mutedUntil?.[service.id] ?? 0;
  const muted = mutedUntil > now;
  const notificationError = notificationMutationError || notifications.error;
  const config = effectiveNotifications(notifications, summary, target);
  const measurement = useMemo(() => service.state === 'none' ? null : measurementView(target.lastSample), [service.state, target.lastSample]);
  const serviceIncidents = useMemo(() => incidents.filter((incident) => incident.targetId === service.id), [incidents, service.id]);
  const [linkedIncident, setLinkedIncident] = useState<{ id: string; targetId: string; value: UptimeIncidentView | null }>();
  const [linkError, setLinkError] = useState('');
  const entryIncident = linkedIncident && linkedIncident.id === entry?.incidentId && linkedIncident.targetId === service.id
    ? linkedIncident.value ?? undefined : entry?.incidentId ? serviceIncidents.find((incident) => incident.id === entry.incidentId) : undefined;
  const snapshot = incidentNotificationSnapshot(entryIncident, service.id, entry?.detectedAt);
  const eventSample = snapshot.sample;
  const eventMeasurement = measurementView(eventSample);
  const eventAt = snapshot.at;
  const resolvedRecovery = Boolean(entryIncident?.endedAt && entryIncident.endedSample?.up && !entryIncident.endedSample.noData);
  const related = useMemo(() => {
    const releaseId = serviceIncidents.find((incident) => incident.releaseId)?.releaseId;
    return releaseId ? incidents.filter((incident) => incident.releaseId === releaseId && incident.targetId !== service.id).slice(0, 5) : [];
  }, [incidents, serviceIncidents, service.id]);

  useEffect(() => { setLinkClosed(false); }, [service.id, entry?.incidentId, entry?.detectedAt]);
  useEffect(() => {
    if (!entry?.incidentId) { setLinkedIncident(undefined); setLinkError(''); return; }
    const controller = new AbortController();
    const id = entry.incidentId;
    setLinkError('');
    void apiRequest<{ incident: UptimeIncidentView }>(`/api/uptime/incidents/${encodeURIComponent(id)}`, { signal: controller.signal }).then(({ incident }) => {
      if (controller.signal.aborted) return;
      if (incident.id !== id || incident.targetId !== service.id) {
        setLinkedIncident({ id, targetId: service.id, value: null });
        setLinkError('这条通知对应的故障记录无法核对，请查看当前服务状态。');
      } else setLinkedIncident({ id, targetId: service.id, value: incident });
    }).catch(() => {
      if (controller.signal.aborted) return;
      setLinkedIncident({ id, targetId: service.id, value: null });
      setLinkError('原始通知事件暂不可用，可能已清理或不在当前访问范围内。');
    });
    return () => controller.abort();
  }, [entry?.incidentId, entry?.detectedAt, service.id, summary.generatedAt]);
  const updateNotification = async (body: { acknowledged?: boolean; muteUntil?: number | null }): Promise<void> => {
    setNotificationBusy(true);
    setNotificationMutationError('');
    try {
      const response = await apiRequest<{ settings: WorkspaceNotificationSettings }>('/api/uptime/notifications', { method: 'PUT', body: { targetId: service.id, ...body } });
      notifications.updateSettings(response.settings);
    } catch (error) {
      setNotificationMutationError(error instanceof Error ? error.message : '通知设置未保存，请重试。');
    } finally { setNotificationBusy(false); }
  };
  const check = async (): Promise<void> => {
    setProbing(true);
    setProbeError('');
    try { await onProbe(); }
    catch (error) { setProbeError(error instanceof Error ? error.message : '检查未完成，请重试。'); }
    finally { setProbing(false); }
  };

  const [range, setRange] = useState<HistoryRange>('24h');
  const [history, setHistory] = useState<{ id: string; range: HistoryRange; value: UptimeHistory }>();
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [rates, setRates] = useState<Partial<Record<HistoryRange, string>>>({});
  useEffect(() => { setRange('24h'); setHistory(undefined); setRates({}); }, [service.id]);
  useEffect(() => {
    const controller = new AbortController();
    setHistoryBusy(true);
    setHistoryError('');
    void apiRequest<UptimeHistory>(`/api/uptime/targets/${encodeURIComponent(service.id)}/history?range=${range}&points=48`, { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setHistory({ id: service.id, range, value });
      const total = value.points.reduce((sum, bucket) => sum + bucket.up + bucket.down, 0);
      const up = value.points.reduce((sum, bucket) => sum + bucket.up, 0);
      setRates((previous) => ({ ...previous, [range]: total ? percent(up / total) : '—' }));
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setHistoryError(error instanceof Error ? error.message : '历史记录读取失败，请重新选择时间范围重试。');
    }).finally(() => { if (!controller.signal.aborted) setHistoryBusy(false); });
    return () => controller.abort();
  }, [service.id, range, summary.generatedAt]);

  const currentHistory = history?.id === service.id && history.range === range ? history.value : undefined;
  const buckets = currentHistory?.points ?? (range === '24h' ? target.buckets : []);
  const aggregatedMetric = useMemo(() => Boolean(target.lastSample?.measurement && measurement
    && buckets.some((bucket) => bucket.measurement?.aggregation === 'average')), [buckets, measurement, target.lastSample]);
  const metricChart = useMemo(() => {
    if (!target.lastSample?.measurement || !measurement) return null;
    const samples = aggregatedMetric
      ? buckets.map((bucket) => ({ t: bucket.from + (bucket.to - bucket.from) / 2, noData: bucket.status === 'none', measurement: bucket.measurement }))
      : (currentHistory?.recentSamples ?? []).filter((sample) => sample.t >= (currentHistory?.from ?? 0) && sample.t <= (currentHistory?.to ?? now));
    return buildMeasurementChart(samples, target.lastSample.measurement);
  }, [aggregatedMetric, buckets, currentHistory, measurement, target.lastSample, now]);
  const latencyPaths = useMemo(() => {
    const high = Math.max(1, ...buckets.map((bucket) => bucket.avgLatencyMs ?? 0));
    const paths: string[] = [];
    let previous = -2;
    for (const [i, bucket] of buckets.entries()) {
      if (bucket.avgLatencyMs === null) continue;
      const point = `${i / Math.max(1, buckets.length - 1) * 480} ${92 - bucket.avgLatencyMs / high * 80}`;
      if (i !== previous + 1) paths.push(`M${point}`);
      else paths[paths.length - 1] += ` L${point}`;
      previous = i;
    }
    return paths;
  }, [buckets]);
  const rangeLabel = range === '24h' ? '最近 24 小时' : range === '7d' ? '最近 7 天' : '最近 30 天';
  const events = serviceIncidents.flatMap((incident) => [
    ...(incident.releaseId ? [{ at: incident.startedAt - (incident.releaseAgeMs ?? 0), state: 'chg', text: `相关发布：${incident.releaseId}；系统记录的时间关联，不代表已确认根因。` }] : []),
    { at: incident.startedAt, state: 'bad', text: incident.cause || '检查失败，判定为异常' },
    ...(incident.endedAt ? [{ at: incident.endedAt, state: 'ok', text: incident.endedSample?.up && !incident.endedSample.noData ? '满足恢复判据，本次异常已结束' : '本次故障记录已结束；未保留可验证的恢复采样' }] : []),
  ]).sort((a, b) => b.at - a.at).slice(0, 12);
  const notificationText = !config.known ? '通知规则尚未读取成功，当前无法确认此服务会通知谁。'
    : muted ? `已静默至 ${time(mutedUntil)}，期间不新增通知；已交给通知渠道或独立接收端的消息不保证撤回，观测继续更新。`
    : config.channelIds?.length === 0 ? '此服务未选择通知通道，不新增异常或恢复通知；已交给通知渠道或独立接收端的消息不保证撤回。'
    : config.channels.length === 0 && (!config.legacy || config.legacy.status === 'unconfigured') ? '当前没有可用于此服务的通知通道，请检查通道的项目与事件订阅。'
    : config.verdict.text.replace(/（缺 [^）]*）/g, '');
  const notificationScope = settings?.overrides && Object.prototype.hasOwnProperty.call(settings.overrides, service.id) ? '此服务单独设置' : '沿用全局默认';
  const observationLocation = target.alarmIdentity?.observer.location || '已接入观测来源';
  const needsAttention = service.state === 'bad' || service.state === 'warn';
  const historyRanges = [{ key: '24h', label: '24 小时', fallback: service.rate }, { key: '7d', label: '7 天', fallback: percent(target.availability7d) }, { key: '30d', label: '30 天', fallback: '—' }] as const;

  return <div className="sv monitor-service-detail">
    {entry && !linkClosed ? <div className="lk" role="status">
      <span className="lk-src"><Link2 className="ic s" />从通知链接打开</span>
      {entry.incidentId ? <span className="tag">{entry.incidentId}</span> : null}
      <span className="lk-at">{eventAt ? `${snapshot.kind === 'recovery' ? '恢复记录于' : entry?.detectedAt ? '告警触发于' : '故障记录于'} ${time(eventAt)}` : linkError || '原始通知事件暂不可核对'}</span>
      <span className="lk-then">{eventSample?.noData ? '当时未取得有效观测，不能据此判断服务正常' : eventMeasurement ? `当时 ${eventMeasurement.name} ${eventMeasurement.actual}，预期 ${eventMeasurement.expected}` : eventSample ? `当时检查${eventSample.up ? '通过' : '失败'}；未保留结构化指标读数` : '未取得匹配的历史采样，不补造通知时读数'}</span>
      <span className={`lk-now ${service.state}`}>{resolvedRecovery ? `${time(entryIncident!.endedAt!)} 已恢复 · ` : ''}{measurement ? `现在 ${measurement.actual}` : `现在${label}`}{service.state === 'bad' ? ' · 仍异常' : ''}</span>
      <span className="sp" /><span className="lk-hint">返回会回到全局里它所在的位置</span>
      <button className="xb sm" aria-label="关闭通知提示" onClick={() => setLinkClosed(true)}><X className="ic s" /></button>
    </div> : null}
    <div className="svh">
      <div><p className="eyebrow">{category.name} · {target.environmentLabel} · {service.custom ? '我的服务' : '平台服务'}</p><h2>{service.name}</h2></div>
      <span className={`pill ${service.state}`}><Glyph state={service.state} />当前 · {label}</span><span className="sp" />
      {service.state === 'bad' ? <><button className="btn ghost sm" disabled={notificationBusy || settings === undefined} onClick={() => void updateNotification({ acknowledged: !acknowledged })}>{acknowledged ? '已确认 · 撤销' : '确认处理'}</button><button className="btn ghost sm" disabled={notificationBusy || settings === undefined} onClick={() => void updateNotification({ muteUntil: muted ? null : Date.now() + 30 * 60_000 })}>{muted ? '取消静默' : '静默 30 分钟'}</button></> : null}
      <button className="btn ghost sm" disabled={probing} onClick={() => void check()}>{probing ? '正在检查…' : '立即检查'}</button><button className="btn ghost sm" onClick={onNotify}>通知设置</button>
    </div>
    <div className="svm">
      {probeError || notificationError ? <p role="alert" className="detail-error">{probeError || notificationError}</p> : null}
      <div className="two rv rv2">
        <div className={`now ${service.state}`}>
          <h3>{measurement ? `预期与实际 · ${measurement.name}` : '当前状态'}</h3>
          <div className="big"><Glyph state={service.state} large />{label}</div><p className="why">{service.reason}</p>
          {measurement ? <><div className="cmp"><div className="cmp-c"><span className="k">实际</span><b className={`cv-a ${service.state}`}>{measurement.actual}</b></div><div className="cmp-c"><span className="k">预期</span><b>{measurement.expected}</b></div></div>{measurement.numeric ? <div className={`cbar ${service.state}${target.lastSample?.measurement?.op === 'gt' || target.lastSample?.measurement?.op === 'gte' ? ' ge' : ''}`} aria-hidden="true"><span className="cb-f" style={{ width: `${measurement.numeric.actualPercent}%` }} /><span className="cb-t" style={{ left: `${measurement.numeric.expectedPercent}%` }} /></div> : null}<p className="cmp-g">{measurement.gap}</p></> : <p className="note">{target.healthCheck ? '尚未取得带指标值的有效采样，预期条件可在下方检查说明核对。' : '此项尚未提供业务指标与预期值，不以响应延迟冒充业务指标。'}</p>}
          <p className="meta">{target.statusSince ? `当前状态开始于 ${time(target.statusSince)}` : '等待有效的观测结果'}</p><p className="meta">最近检查 {service.ago} · 每 {target.intervalSeconds} 秒 · {observationLocation}</p>
        </div>
        {needsAttention ? <div className="card imp"><h3>影响</h3><dl className="ikv"><dt>扫码与调用</dt><dd>—</dd><dt>品牌租户</dt><dd>—</dd><dt>行业分布</dt><dd>—</dd><dt>消费者感知</dt><dd>—</dd></dl><p className="note">尚未取得业务影响数据，不能据此判断影响为零。当前检查覆盖 {category.name} · {target.environmentLabel}。</p></div>
          : <div className="card"><h3>历史通过率</h3><div className="rates" role="group" aria-label="历史时间范围">{historyRanges.map((item) => <button key={item.key} className={`rate${range === item.key ? ' active' : ''}`} aria-pressed={range === item.key} onClick={() => setRange(item.key)}><b>{rates[item.key] ?? item.fallback}</b><span>{item.label}</span></button>)}</div><p className="note">当前状态与历史通过率独立；灰色无观测时段保留但不计入通过率。</p></div>}
      </div>
      <div className="card rv rv2">
        <div className="card-h"><h3>{rangeLabel} · 检查记录</h3><div className="legend"><span><i className="lg-ok" />满足检查条件</span><span><i className="lg-part" />部分失败</span><span><i className="lg-fail" />检查失败</span><span><i className="lg-gap" />无观测</span></div></div>
        {needsAttention ? <div className="detail-history-ranges" role="group" aria-label="历史时间范围">{historyRanges.map((item) => <button key={item.key} aria-pressed={range === item.key} onClick={() => setRange(item.key)}>{item.label} <span className="mono">{rates[item.key] ?? item.fallback}</span></button>)}</div> : null}
        <div aria-busy={historyBusy}>{historyBusy ? <div className="history-progress" role="status" aria-label="正在读取历史观测" /> : null}{historyError ? <p className="detail-error" role="alert">{historyError}</p> : null}<HistoryStrip buckets={buckets} /></div>
        <div className="ticks">{[4, 3, 2, 1, 0].map((step) => { const at = now - step / 4 * (range === '24h' ? 24 : range === '7d' ? 168 : 720) * 3_600_000; return <span key={step}>{step === 0 ? '现在' : range === '24h' ? time(at) : new Date(at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</span>; })}</div>
        <div className="lat-h"><span>{measurement ? measurement.name : '响应延迟'}{metricChart ? aggregatedMetric ? ' · 上报指标采样均值' : ` · 最近 ${metricChart.samples} 次指标采样` : ''}</span><span className="mono">{measurement ? `当前 ${measurement.actual} · 当前预期 ${measurement.expected}` : `当前 ${service.latency} · 平均 ${target.avgLatencyMs24h === null ? '—' : `${Math.round(target.avgLatencyMs24h)} ms`}`}</span></div>
        {measurement ? metricChart ? <><div className="latw"><svg className="lat" viewBox="0 0 480 100" preserveAspectRatio="none" role="img" aria-label={aggregatedMetric ? '上报指标采样均值与当前预期' : '已保留的真实指标采样与当前预期'}><line className="th" x1="0" x2="480" y1={metricChart.thresholdY} y2={metricChart.thresholdY} />{metricChart.paths.map((path, i) => <path key={i} className="ln" d={path} />)}{metricChart.failingPaths.map((path, i) => <path key={i} className="lnb" d={path} />)}{metricChart.points.map((point, i) => <circle key={i} cx={point.x} cy={point.y} r={metricChart.samples === 1 ? 2.5 : 1.25} className={point.failed ? 'metric-point bad' : 'metric-point'} />)}</svg><span className="thl" style={{ '--threshold-y': `${metricChart.thresholdY}%` } as CSSProperties}>当前预期 {measurement.expected}</span></div><div className="ticks"><span>{time(metricChart.from)}</span><span>{time(metricChart.to)}</span></div><p className="note">{aggregatedMetric ? '每个点是该时段内相同指标合同的有效读数均值；上报 P95 的均值不代表整个时段的 P95。' : '曲线只绘制接口保留的真实指标采样。'}缺失读数处断开，不以响应延迟替代指标。</p></> : <div className="lat lat-empty">尚无可绘制的数字指标历史；当前读数与预期在上方显示</div>
          : latencyPaths.length ? <svg className="lat" viewBox="0 0 480 100" preserveAspectRatio="none" role="img" aria-label={`${rangeLabel}实际响应延迟`}>{latencyPaths.map((path, i) => <path key={i} className="ln" d={path} />)}</svg> : <div className="lat lat-empty">尚无可用延迟观测，首次检查后自动显示</div>}
      </div>
      <div className="grid2 rv rv3">
        <div className="card"><h3>各探测点当前</h3><div className="rt"><span className="rh">观测来源</span><span className="rh">当前</span><span className="rh">实际</span><span className="rh">检查</span><span>{observationLocation}</span><span className="c"><Glyph state={service.state} />{label}</span><span className="mono">{measurement?.actual ?? service.latency}</span><span className="mono">{service.ago}</span></div><p className="note">{target.observeMode === 'passive' ? '读取真实业务调用的观测窗口' : '按设定间隔主动检查'}；仅展示已接入的观测来源，不生成虚拟地区。</p></div>
        <div className="card"><h3>{service.state === 'bad' ? '异常经过' : '最近事件'}</h3><div className="ev">{events.length ? events.map((event, i) => <div className="evi" key={`${event.at}:${i}`}><span className="t">{time(event.at)}</span><span className={`evd ${event.state}`} aria-hidden="true" /><span>{event.text}</span></div>) : <p className="note">暂无已记录的故障或恢复事件。</p>}</div></div>
      </div>
    </div>
    <div className="svs rv rv3">
      {related.length ? <div className="card"><div className="card-h"><h3>可能相关</h3><span className="tag">{related.length} 项</span></div><p className="lbl">同一关联发布记录；仅为排查线索，不代表已确认共同原因。</p><div className="rl">{related.map((incident) => <button key={incident.id} className="rli" disabled={!onOpenService} onClick={() => onOpenService?.(incident.targetId)}><Glyph state={incident.ongoing ? 'bad' : 'ok'} /><span className="rl-b"><span className="rl-n">{incident.targetName}</span><span className="rl-l">{incident.releaseId}</span></span><span className={`rl-v ${incident.ongoing ? 'bad' : 'ok'}`}>{incident.ongoing ? '异常未结束' : '记录已结束'}</span></button>)}</div></div> : null}
      <div className="card"><div className="card-h"><h3>{muted ? '通知已静默' : '异常会通知'}</h3><span className="tag">{notificationScope}</span></div><p className="lbl">已配置的适用通道</p><div className="chips">{config.channels.map((channel) => <span key={channel.id} className="chip">{channel.name}</span>)}{config.legacy && config.legacy.status !== 'unconfigured' ? <span className="chip">{config.legacy.channel}</span> : null}</div><p className="lbl">发到哪里</p><div className="chl-list">{config.channels.map((channel) => <div className="chl" key={channel.id}><span className="chn2">{channel.name}</span><span className="dest">{channel.kind}</span><span className={channel.status === 'healthy' ? 'dl-ok' : 'detail-channel-pending'}>{channel.status === 'healthy' ? '通道最近投递成功' : channel.status === 'failing' ? '通道最近发送失败' : '待验证'}</span></div>)}</div>{config.legacy && config.legacy.status !== 'unconfigured' ? <div className="chl"><span className="chn2">{config.legacy.channel}</span><span className="dest">MAP</span><span className={config.legacy.status === 'healthy' ? 'dl-ok' : 'detail-channel-pending'}>{config.legacy.status === 'healthy' ? '通道最近投递成功' : config.legacy.status === 'failing' ? '通道最近发送失败' : '尚未验证送达'}</span></div> : null}<p className="note">{notificationText}</p><button className="btn ghost sm full" onClick={onNotify}>为此服务调整通知</button></div>
      <div className="card"><h3>如何检查</h3><dl className="kv"><dt>方式</dt><dd>{target.observeMode === 'passive' ? '被动观测' : '主动检查'}</dd><dt>检查说明</dt><dd>{target.probeDescription}</dd>{target.healthCheck ? <Fragment><dt>指标条件</dt><dd>{target.healthCheck.componentId} · {target.healthCheck.field} {target.healthCheck.op} {target.healthCheck.value}</dd></Fragment> : null}<dt>频率</dt><dd>每 {target.intervalSeconds} 秒</dd><dt>超时</dt><dd>{formatMeasurementValue(target.timeoutMs / 1000, '秒')}</dd><dt>最近检查</dt><dd>{target.lastSample ? formatRelative(target.lastSample.t, now) : '尚未检查'}</dd></dl><button className="linkb" onClick={onManage}>管理此项监控 <ChevronRight className="ic xs" /></button></div>
    </div>
  </div>;
}
