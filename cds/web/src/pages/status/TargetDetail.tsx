/*
 * 右栏：单目标详情。
 *
 *   头部：状态 + 名字 + 来源 + 探测方式 + 操作（立即探测 / 暂停恢复 / 编辑 / 删除 / 打开来源页）
 *   数字：当前状态持续多久、24h / 7d / 30d 可用率、平均响应、采样次数、故障次数
 *   图：可选时间范围的可用率柱条 + 响应时间曲线（走 /api/uptime/targets/:id/history）
 *   本目标的故障事件、探测配置与为什么没在探（暂停 / 排除 / 降级原因）
 *
 * 只有 source=custom 的目标才有编辑 / 暂停 / 删除：系统推导出来的目标要去它的
 * 来源页（分支 / 发布中心）改，这里只给跳转，不伪装成能改。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  ChevronLeft,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Zap,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { ApiError, apiRequest } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  HISTORY_RANGES,
  PROBE_KIND_LABEL,
  SOURCE_META,
  availabilityOfBuckets,
  describeStatusSince,
  formatClock,
  formatDuration,
  formatLatency,
  formatPercent,
  formatRelative,
  formatShortClock,
  type HistoryRange,
  type UptimeHistory,
  type UptimeIncidentView,
  type UptimeTargetSummary,
} from '@/lib/monitorCenter';
import { LatencyChart } from './LatencyChart';
import { AvailabilityBar, SegmentedControl, SourceBadge, Stat, StatusPill } from './primitives';

type HistoryState =
  | { status: 'idle' }
  | { status: 'loading'; range: HistoryRange }
  | { status: 'ok'; range: HistoryRange; history: UptimeHistory }
  | { status: 'error'; range: HistoryRange; message: string };

export interface TargetActions {
  probeNow: (target: UptimeTargetSummary) => Promise<void>;
  toggleEnabled: (target: UptimeTargetSummary) => Promise<void>;
  edit: (target: UptimeTargetSummary) => void;
  remove: (target: UptimeTargetSummary) => Promise<void>;
}

function useHistory(targetId: string, range: HistoryRange, generatedAt: number): HistoryState {
  const [state, setState] = useState<HistoryState>({ status: 'idle' });
  useEffect(() => {
    let cancelled = false;
    setState((prev) => (prev.status === 'ok' && prev.history.id === targetId && prev.range === range
      ? prev
      : { status: 'loading', range }));
    apiRequest<UptimeHistory>(`/api/uptime/targets/${encodeURIComponent(targetId)}/history?range=${range}&points=180`)
      .then((history) => { if (!cancelled) setState({ status: 'ok', range, history }); })
      .catch((err) => {
        if (cancelled) return;
        setState({ status: 'error', range, message: err instanceof ApiError ? err.message : String(err) });
      });
    return () => { cancelled = true; };
    // generatedAt 进依赖：每次摘要刷新后曲线也跟着刷，不然 24h 视图会停在打开那一刻。
  }, [targetId, range, generatedAt]);
  return state;
}

function sourceLink(target: UptimeTargetSummary): { to: string; label: string } | null {
  if (target.source === 'branch' && target.branchId) return { to: `/branch-panel/${encodeURIComponent(target.branchId)}`, label: '打开分支' };
  if (target.source === 'release') return { to: '/release-center', label: '打开发布中心' };
  return null;
}

export function TargetDetail({
  target,
  incidents,
  generatedAt,
  now,
  actions,
  busy,
  onBack,
}: {
  target: UptimeTargetSummary;
  incidents: ReadonlyArray<UptimeIncidentView>;
  generatedAt: number;
  now: number;
  actions: TargetActions;
  /** 正在进行的操作（按钮防连点 + 显示进度） */
  busy: 'probe' | 'toggle' | 'remove' | null;
  /** 窄屏：返回列表 */
  onBack?: () => void;
}): JSX.Element {
  const [range, setRange] = useState<HistoryRange>('24h');
  const history = useHistory(target.id, range, generatedAt);
  const own = useMemo(() => incidents.filter((i) => i.targetId === target.id).slice(0, 20), [incidents, target.id]);
  const link = sourceLink(target);
  const isCustom = target.source === 'custom';
  const rangeBuckets = history.status === 'ok' ? history.history.points : null;
  const rangeAvailability = rangeBuckets ? availabilityOfBuckets(rangeBuckets) : null;
  const statusTone = target.status === 'down' ? 'danger' : target.status === 'up' ? 'ok' : target.status === 'unknown' ? 'warn' : 'default';
  const canProbe = !target.excluded && target.status !== 'paused';
  const unmeasured = target.measured === false;
  const viewpoint = target.source === 'branch'
    ? (target.userView ? 'CDS 主机 → 容器端口（进程视角） + 预览域名整条链路（用户视角）' : 'CDS 主机 → 容器端口（进程视角，单点）')
    : 'CDS 主机出网 → 目标地址，单点；与用户视角一致但不等价（内网 DNS / 出网策略可能不同）';
  const recentSamples = history.status === 'ok' ? (history.history.recentSamples || []) : [];

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]">
      <header className="flex shrink-0 flex-col gap-3 border-b border-[hsl(var(--hairline))] p-4">
        <div className="flex flex-wrap items-start gap-3">
          {onBack ? (
            <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 lg:hidden">
              <ChevronLeft />
              列表
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={target.status} excluded={target.excluded} measured={target.measured} size="lg" />
              <h2 className="min-w-0 truncate text-lg font-semibold leading-tight">{target.name}</h2>
              <SourceBadge source={target.source} full />
              {target.degraded ? (
                <span className="inline-flex items-center gap-1 rounded border border-warn/40 bg-warn-soft px-1.5 py-0.5 text-[10px] text-warn" title={target.degradeReason}>
                  <ShieldAlert className="h-3 w-3" />
                  已自动降级
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span className={cn('font-medium', statusTone === 'danger' ? 'text-destructive' : statusTone === 'ok' ? 'text-ok' : '')}>
                {describeStatusSince(target.status, target.statusSince, now)}
              </span>
              <span className="min-w-0 truncate font-mono" title={target.probeDescription}>{target.probeDescription}</span>
              {target.source === 'branch' && target.userView ? (
                <span className="inline-flex items-center gap-2 rounded border border-[hsl(var(--hairline-strong))] px-1.5 py-0.5 text-[11px]" title={`用户视角：${target.userView.url}`}>
                  <span className="inline-flex items-center gap-1">进程 <span className={cn('inline-block h-2 w-2 rounded-full', target.status === 'down' && !(target.lastSample?.err || '').includes('用户视角') ? 'bg-destructive' : unmeasured ? 'bg-warn' : 'bg-ok')} /></span>
                  <span className="inline-flex items-center gap-1">用户视角 <span className={cn('inline-block h-2 w-2 rounded-full', target.userView.status === 'up' ? 'bg-ok' : target.userView.status === 'down' ? 'bg-destructive' : 'bg-[hsl(var(--hairline-strong))]')} /></span>
                </span>
              ) : (
                <span className="rounded border border-[hsl(var(--hairline-strong))] px-1.5 py-0.5 text-[11px]">视角：{target.source === 'branch' ? 'CDS 主机 → 容器端口' : 'CDS 主机 → 公网地址'}</span>
              )}
            </div>
            {(target.tags || []).length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {(target.tags || []).map((tag) => (
                  <span key={tag} className="rounded bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={() => void actions.probeNow(target)} disabled={!canProbe || busy !== null} title={canProbe ? '立刻探测一次并记入台账' : '暂停或未纳入监控的目标不能探测'}>
              <Zap className={busy === 'probe' ? 'animate-pulse' : undefined} />
              {busy === 'probe' ? '探测中' : '立即探测'}
            </Button>
            {isCustom ? (
              <>
                <Button variant="outline" size="sm" onClick={() => void actions.toggleEnabled(target)} disabled={busy !== null}>
                  {target.enabled === false ? <Play /> : <Pause />}
                  {busy === 'toggle' ? '处理中' : target.enabled === false ? '恢复探测' : '暂停'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => actions.edit(target)} disabled={busy !== null}>
                  <Pencil />
                  编辑
                </Button>
                <ConfirmAction
                  trigger={(
                    <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" disabled={busy !== null}>
                      <Trash2 />
                      删除
                    </Button>
                  )}
                  title={`删除监控「${target.name}」？`}
                  description="定义与全部采样、故障记录会一起清掉，这个动作不可恢复。"
                  confirmLabel="删除"
                  pending={busy === 'remove'}
                  onConfirm={() => actions.remove(target)}
                />
              </>
            ) : link ? (
              <Button variant="outline" size="sm" asChild>
                <Link to={link.to}>
                  <ArrowUpRight />
                  {link.label}
                </Link>
              </Button>
            ) : null}
          </div>
        </div>

        {target.status === 'down' && target.lastSample?.err ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
            <span className="font-medium">最近失败原因：</span>{target.lastSample.err}
            {target.openIncidentSince ? <span className="opacity-80">（故障始于 {formatClock(target.openIncidentSince)}）</span> : null}
          </div>
        ) : null}
        {unmeasured && target.status !== 'down' ? (
          <div className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs leading-5 text-warn">
            这条没有可探测的 HTTP 端口，只能按容器状态判定——读的是 CDS 自己的记录，不是观测。它不算「正常」，也不计入可用率。
            {target.degradeReason ? ` ${target.degradeReason}` : ''}
          </div>
        ) : null}
        {target.userView?.unreachable ? (
          <div className="rounded-md border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs leading-5 text-muted-foreground">
            用户视角暂不可用：探测器够不着预览域名（{target.userView.lastSample?.err || '连接失败'}），这不算目标故障。
          </div>
        ) : null}
        {target.status === 'paused' && target.pausedReason ? (
          <div className="rounded-md border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs leading-5 text-muted-foreground">
            {target.pausedReason}
          </div>
        ) : null}
        {target.excluded && target.pausedReason ? (
          <div className="rounded-md border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs leading-5 text-muted-foreground">
            {target.pausedReason}
          </div>
        ) : null}
        {target.degraded && target.degradeReason ? (
          <div className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs leading-5 text-warn">{target.degradeReason}</div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4" style={{ overscrollBehavior: 'contain' }}>
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label="近 24h 可用率" value={formatPercent(target.availability24h)} tone={target.availability24h !== null && target.availability24h < 0.99 ? 'warn' : 'default'} hint={target.sampleCount24h > 0 ? `采样 ${target.sampleCount24h} 次` : '尚无采样'} />
            <Stat label="近 7 日可用率" value={formatPercent(target.availability7d)} hint="自然日（UTC，含今天）" />
            <Stat label="平均响应" value={formatLatency(target.avgLatencyMs24h)} hint="近 24h" />
            <Stat
              label="最近一次探测"
              value={target.lastSample ? formatLatency(target.lastSample.ms) : '—'}
              tone={target.lastSample ? (target.lastSample.up ? 'ok' : 'danger') : 'default'}
              hint={target.lastSample ? `${target.lastSample.up ? '成功' : '失败'}${target.lastSample.code ? ` · HTTP ${target.lastSample.code}` : ''} · ${formatRelative(target.lastSample.t, now)}` : '尚未探测'}
            />
            <Stat label="故障次数" value={String(target.incidentCount)} tone={target.incidentCount > 0 ? 'warn' : 'default'} hint="台账内累计" />
            <Stat label="探测间隔" value={`${target.intervalSeconds} 秒`} hint={`超时 ${Math.round(target.timeoutMs / 1000)} 秒`} />
          </div>

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <h3 className="text-sm font-semibold">可用率与响应时间</h3>
                {history.status === 'ok' && range !== '24h' ? (
                  <span className="text-xs text-muted-foreground">
                    {HISTORY_RANGES.find((r) => r.value === range)?.label}可用率 {formatPercent(rangeAvailability)}
                  </span>
                ) : null}
              </div>
              <SegmentedControl<HistoryRange> value={range} options={HISTORY_RANGES} onChange={setRange} ariaLabel="时间范围" />
            </div>
            {range === '24h' ? (
              <div className="overflow-x-auto" style={{ overscrollBehavior: 'contain' }}>
                <AvailabilityBar buckets={target.buckets} segments={90} className="min-w-[320px]" label={`${target.name} 最近 24 小时可用率分布`} />
              </div>
            ) : rangeBuckets ? (
              <div className="overflow-x-auto" style={{ overscrollBehavior: 'contain' }}>
                <AvailabilityBar buckets={rangeBuckets} segments={rangeBuckets.length} className="min-w-[320px]" label={`${target.name} 最近 ${range} 可用率分布`} />
              </div>
            ) : null}
            {history.status === 'loading' || history.status === 'idle' ? (
              <div className="flex h-44 items-end gap-[3px] rounded-lg border border-[hsl(var(--hairline))] p-3" role="status" aria-label="正在读取时序">
                {Array.from({ length: 40 }).map((_, idx) => (
                  <span key={idx} className="cds-loading-skeleton-line w-full" style={{ height: `${30 + ((idx * 37) % 60)}%`, animationDelay: `${(idx % 10) * 60}ms` }} />
                ))}
              </div>
            ) : history.status === 'error' ? (
              <div className="flex h-44 flex-col items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 text-xs text-destructive">
                <span>读取时序失败：{history.message}</span>
                <Button variant="outline" size="sm" onClick={() => setRange((r) => r)}>
                  <RefreshCw />
                  重试
                </Button>
              </div>
            ) : (
              <LatencyChart points={history.history.points} range={range} />
            )}
            <div className="text-[11px] text-muted-foreground">
              {range === '24h'
                ? `90 段 · 覆盖最近 24 小时，原始采样按 ${target.intervalSeconds} 秒一次 · 灰段 = 无采样（不计入可用率分母）`
                : '按自然日聚合（UTC）：每一段是一天，曲线是当天平均响应'}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-sm font-semibold">原始采样（最近 {recentSamples.length} 次）</h3>
              <span className="text-[11px] text-muted-foreground">判定就是从这些数据来的，可自行核对；每 {target.intervalSeconds} 秒一次，连续失败达阈值判故障，一次成功即恢复</span>
            </div>
            <div className="overflow-x-auto rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]" style={{ overscrollBehavior: 'contain' }}>
              <div className="min-w-[520px]">
                <div className="grid grid-cols-[100px_60px_70px_80px_minmax(0,1fr)] gap-3 bg-[hsl(var(--surface-sunken))] px-3 py-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
                  <span>时间</span><span>结果</span><span>状态码</span><span>耗时</span><span>原因</span>
                </div>
                {recentSamples.length === 0 ? (
                  <div className="border-t border-[hsl(var(--hairline))] px-3 py-4 text-center text-xs text-muted-foreground">
                    {history.status === 'ok' ? '尚无采样' : '读取中'}
                  </div>
                ) : recentSamples.map((s) => (
                  <div key={s.t} className="grid grid-cols-[100px_60px_70px_80px_minmax(0,1fr)] gap-3 border-t border-[hsl(var(--hairline))] px-3 py-1.5 font-mono text-xs">
                    <span>{formatShortClock(s.t)}</span>
                    <span className={cn('font-semibold', s.up ? 'text-ok' : 'text-destructive')}>{s.up ? '成功' : '失败'}</span>
                    <span>{s.code ?? '—'}</span>
                    <span>{formatLatency(s.ms)}</span>
                    <span className="truncate text-muted-foreground" title={s.err}>{s.err || ''}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">本目标的故障事件</h3>
            {own.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[hsl(var(--hairline-strong))] px-4 py-5 text-center text-xs text-muted-foreground">
                没有记录到故障事件。连续失败达到阈值时会自动合成一条并统计持续时长。
              </div>
            ) : (
              <ol className="flex flex-col gap-1.5">
                {own.map((incident) => (
                  <li key={incident.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50 px-3 py-2 text-xs">
                    <span className={cn('inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-medium', incident.ongoing ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-[hsl(var(--hairline-strong))] text-muted-foreground')}>
                      {incident.ongoing ? '进行中' : '已恢复'}
                    </span>
                    <span className="font-mono text-muted-foreground">{formatClock(incident.startedAt)}</span>
                    <span className="text-muted-foreground">持续 {formatDuration(incident.durationMs)}</span>
                    <span className="min-w-0 flex-1 truncate text-foreground/90" title={incident.cause}>{incident.cause}</span>
                    {incident.releaseId ? (
                      <span className="shrink-0 rounded-full border border-[hsl(var(--hairline-strong))] px-2 py-0.5 font-mono text-[11px] text-muted-foreground" title={`故障判定发生在发布 ${incident.releaseId} 完成之后 ${formatDuration(incident.releaseAgeMs ?? 0)}`}>
                        疑似 {incident.releaseId}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">探测配置</h3>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50 px-3 py-2.5 text-xs">
              <dt className="text-muted-foreground">来源</dt>
              <dd>{SOURCE_META[target.source].label} · {SOURCE_META[target.source].hint}</dd>
              <dt className="text-muted-foreground">方式</dt>
              <dd>{PROBE_KIND_LABEL[target.probeKind]}{unmeasured ? '（不是观测，读的是 CDS 自己的记录）' : '（真实请求）'}</dd>
              <dt className="text-muted-foreground">视角</dt>
              <dd>{viewpoint}</dd>
              {target.userView ? (
                <>
                  <dt className="text-muted-foreground">用户视角地址</dt>
                  <dd className="break-all font-mono">{target.userView.url}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">规则</dt>
              <dd className="break-all font-mono">{target.probeDescription}</dd>
              {target.probeUrl ? (
                <>
                  <dt className="text-muted-foreground">地址</dt>
                  <dd className="break-all font-mono">{target.probeUrl}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">节奏</dt>
              <dd>每 {target.intervalSeconds} 秒一次，单次超时 {target.timeoutMs} ms</dd>
              <dt className="text-muted-foreground">标识</dt>
              <dd className="break-all font-mono text-muted-foreground">{target.id}</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
