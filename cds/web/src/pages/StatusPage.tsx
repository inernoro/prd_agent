/*
 * StatusPage — CDS 自建存活监控状态页（Uptime Kuma 形态）。
 *
 * 数据源是 CDS 自己的探测器（GET /api/uptime/*），不接任何外部 SaaS：
 *   顶部整体状态横幅 → 每个服务一行（状态 + 90 段可用率柱条 + 24h 可用率 +
 *   平均响应）→ 底部故障时间线。
 *
 * 落地的几条项目纪律：
 *   - 颜色只走 token / Tailwind 语义类，双主题都可读（cds-theme-tokens）；
 *   - up/down 不只靠颜色：柱条 down 段带斜纹（形状差异）+ 每行有文字状态 +
 *     lucide 图标，照顾色觉障碍；
 *   - 加载态是柱条形状的骨架屏，不是静止 spinner（禁止空白等待）；
 *   - 加载 / 有数据 / 失败是互斥三态（lib/statusView 的 resolveStatusViewPhase）：
 *     首次加载失败只渲染错误卡片，绝不再让骨架屏一直转着说「正在读取」；
 *   - 空状态给引导文案 + 「首批数据约 N 秒后出现」，不是「暂无数据」；
 *   - 主产物区 flex-1 min-h-0 填满（content-fills-canvas）；
 *   - 手机端柱条段数减半并允许横向滚动，页面本身绝不横向撑破。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, EyeOff, HelpCircle, PauseCircle, RefreshCw, ShieldAlert } from 'lucide-react';
import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { ApiError, apiRequest } from '@/lib/api';
import { describeStatusLoadError, resolveStatusViewPhase } from '@/lib/statusView';

type UptimeStatus = 'up' | 'down' | 'paused' | 'unknown';
type BucketStatus = 'up' | 'down' | 'partial' | 'none';

interface UptimeSample {
  t: number;
  up: boolean;
  ms: number;
  code?: number;
  err?: string;
}

interface UptimeBucket {
  from: number;
  to: number;
  up: number;
  down: number;
  avgLatencyMs: number | null;
  status: BucketStatus;
}

interface UptimeTargetSummary {
  id: string;
  name: string;
  branchId: string;
  projectId: string;
  profileId: string;
  probeKind: 'http' | 'container';
  status: UptimeStatus;
  pausedReason?: string;
  /** 命中 CDS_UPTIME_EXCLUDE：未纳入监控，不算故障 */
  excluded?: boolean;
  /** 端口不说 HTTP，已自动改按容器状态判定 */
  degraded?: boolean;
  degradeReason?: string;
  lastSample: UptimeSample | null;
  availability24h: number | null;
  availability7d: number | null;
  avgLatencyMs24h: number | null;
  sampleCount24h: number;
  buckets: UptimeBucket[];
  openIncidentSince: number | null;
}

interface UptimeSummary {
  enabled: boolean;
  generatedAt: number;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  firstDataEtaSeconds: number;
  lastCycleAt: number | null;
  excludePatterns?: string[];
  overall: {
    total: number;
    up: number;
    down: number;
    paused: number;
    unknown: number;
    excluded?: number;
    ok: boolean;
  };
  targets: UptimeTargetSummary[];
}

interface UptimeIncidentView {
  id: string;
  targetId: string;
  targetName: string;
  branchId: string;
  projectId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  cause: string;
  ongoing: boolean;
}

const DESKTOP_SEGMENTS = 90;
const MOBILE_SEGMENTS = 40;
const POLL_INTERVAL_MS = 30_000;

const STATUS_META: Record<UptimeStatus, { label: string; icon: typeof CheckCircle2; className: string }> = {
  up: { label: '正常', icon: CheckCircle2, className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  down: { label: '故障', icon: AlertTriangle, className: 'border-destructive/40 bg-destructive/10 text-destructive' },
  paused: { label: '已暂停', icon: PauseCircle, className: 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground' },
  unknown: { label: '待确认', icon: HelpCircle, className: 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground' },
};

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 767px)').matches : false);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (): void => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

function formatPercent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return '暂无数据';
  return `${(ratio * 100).toFixed(ratio >= 0.9995 ? 0 : 2)}%`;
}

function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec} 秒`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min} 分 ${totalSec % 60} 秒`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时 ${min % 60} 分`;
  return `${Math.floor(hour / 24)} 天 ${hour % 24} 小时`;
}

function bucketTitle(bucket: UptimeBucket): string {
  const window = `${formatClock(bucket.from)} — ${formatClock(bucket.to)}`;
  if (bucket.status === 'none') return `${window}\n无采样（服务未运行或尚未探测）`;
  const total = bucket.up + bucket.down;
  return [
    window,
    `成功 ${bucket.up} / 共 ${total} 次`,
    bucket.avgLatencyMs !== null ? `平均响应 ${formatLatency(bucket.avgLatencyMs)}` : null,
  ].filter(Boolean).join('\n');
}

/** 柱条单段。颜色 + 高度 + 斜纹三重编码，不只靠颜色区分 up/down。 */
function BarSegment({ bucket }: { bucket: UptimeBucket }): JSX.Element {
  const base = 'w-full shrink-0 rounded-[2px] transition-colors';
  if (bucket.status === 'none') {
    return (
      <span
        className={`${base} h-1/3 self-end bg-[hsl(var(--hairline-strong))]/50`}
        title={bucketTitle(bucket)}
        aria-label="无采样"
      />
    );
  }
  const stripe = bucket.status === 'up'
    ? undefined
    : {
      backgroundImage:
        'repeating-linear-gradient(45deg, transparent 0 2px, hsl(var(--destructive-foreground) / 0.6) 2px 3px)',
    };
  const tone = bucket.status === 'up'
    ? 'h-full bg-emerald-500'
    : bucket.status === 'partial'
      ? 'h-full bg-amber-500'
      : 'h-full bg-destructive';
  return (
    <span
      className={`${base} ${tone}`}
      style={stripe}
      title={bucketTitle(bucket)}
      aria-label={bucket.status === 'up' ? '正常' : bucket.status === 'partial' ? '部分失败' : '故障'}
    />
  );
}

/** 未纳入监控（命中排除名单）单独一档：中性色，明确区别于「已暂停」。 */
const EXCLUDED_META = {
  label: '未纳入监控',
  icon: EyeOff,
  className: 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground',
} as const;

function StatusPill({ status, excluded }: { status: UptimeStatus; excluded?: boolean }): JSX.Element {
  const meta = excluded ? EXCLUDED_META : STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}

/** 加载骨架：柱条形状的 shimmer，不是静止 spinner。 */
function StatusSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="正在读取存活监控数据">
      <div className="cds-loading-skeleton-line h-16 w-full rounded-lg" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-3">
          <div className="cds-loading-skeleton-line mb-3 h-4 w-40" />
          <div className="flex h-8 items-stretch gap-[2px]">
            {Array.from({ length: 40 }).map((_, idx) => (
              <span
                key={idx}
                className="cds-loading-skeleton-line w-full shrink-0 rounded-[2px]"
                style={{ animationDelay: `${(idx % 10) * 60}ms` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function OverallBanner({ summary }: { summary: UptimeSummary }): JSX.Element {
  const { overall } = summary;
  if (!summary.enabled) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <PauseCircle className="h-4 w-4" />
          存活监控已关闭
        </div>
        <div className="text-xs text-muted-foreground">
          当前实例设置了 CDS_UPTIME_ENABLED=0。移除该环境变量并重启 CDS 即可恢复周期探测。
        </div>
      </div>
    );
  }
  const excludedCount = overall.excluded ?? 0;
  const tone = overall.down > 0
    ? 'border-destructive/40 bg-destructive/10 text-destructive'
    : overall.up > 0
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground';
  const Icon = overall.down > 0 ? AlertTriangle : overall.up > 0 ? CheckCircle2 : Activity;
  const headline = overall.down > 0
    ? `${overall.down} 个服务异常`
    : overall.up > 0
      ? '全部服务正常'
      : '尚未探测到运行中的服务';
  return (
    <div className={`flex flex-col gap-2 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${tone}`}>
      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5 shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-semibold">{headline}</div>
          <div className="text-xs opacity-80">
            共 {overall.total} 个监控目标：正常 {overall.up} · 异常 {overall.down} · 暂停 {overall.paused} · 待确认 {overall.unknown}
            {excludedCount > 0 ? ` · 未纳入监控 ${excludedCount}` : ''}
          </div>
          {excludedCount > 0 ? (
            <div className="text-[11px] opacity-70">
              排除规则（CDS_UPTIME_EXCLUDE）：{(summary.excludePatterns || []).join('、')}
            </div>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 text-xs opacity-80">
        每 {summary.intervalSeconds} 秒探测一次 · 连续 {summary.failureThreshold} 次失败判定故障
      </div>
    </div>
  );
}

function TargetRow({ target, segments }: { target: UptimeTargetSummary; segments: number }): JSX.Element {
  const shown = useMemo(
    () => (target.buckets.length > segments ? target.buckets.slice(target.buckets.length - segments) : target.buckets),
    [target.buckets, segments],
  );
  return (
    <div className="rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusPill status={target.status} excluded={target.excluded} />
          <span className="truncate text-sm font-medium">{target.name}</span>
          <span className="hidden shrink-0 rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
            {target.probeKind === 'http' ? 'HTTP 探测' : '按容器状态判定'}
          </span>
          {target.degraded ? (
            <span
              className="hidden shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 sm:inline-flex dark:text-amber-300"
              title={target.degradeReason}
            >
              <ShieldAlert className="h-3 w-3" />
              已自动降级
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          <span title="最近 24 小时可用率">24h {formatPercent(target.availability24h)}</span>
          <span title="最近 24 小时平均响应时间">{formatLatency(target.avgLatencyMs24h)}</span>
        </div>
      </div>

      {/* 柱条：手机端段数减少，仍放不下时容器内横向滚动，绝不撑破 body */}
      <div className="mt-3 overflow-x-auto" style={{ overscrollBehavior: 'contain' }}>
        <div className="flex h-8 min-w-[280px] items-stretch gap-[2px]" role="img" aria-label={`${target.name} 最近 24 小时可用率分布`}>
          {shown.map((bucket) => <BarSegment key={bucket.from} bucket={bucket} />)}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>{shown.length} 段 · 覆盖最近 24 小时</span>
        {target.sampleCount24h > 0 ? <span>采样 {target.sampleCount24h} 次</span> : null}
        {target.availability7d !== null ? <span>7d {formatPercent(target.availability7d)}</span> : null}
        {target.status === 'paused' && target.pausedReason ? (
          <span className="text-muted-foreground">{target.pausedReason}</span>
        ) : null}
        {target.degraded && target.degradeReason ? (
          <span className="text-muted-foreground">{target.degradeReason}</span>
        ) : null}
        {target.status === 'down' && target.lastSample?.err ? (
          <span className="text-destructive">最近失败原因：{target.lastSample.err}</span>
        ) : null}
        {target.openIncidentSince ? (
          <span className="text-destructive">故障持续中，始于 {formatClock(target.openIncidentSince)}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 失败态卡片（引导式空状态）：讲清哪里出错 + 下一步怎么办 + 一个「重新加载」，
 * 而不是「加载失败」四个字，更不是一边报错一边转骨架。
 */
function StatusErrorCard({ message, onRetry, retrying }: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}): JSX.Element {
  const view = describeStatusLoadError(message);
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-10 text-center"
    >
      <AlertTriangle className="h-7 w-7 text-destructive" />
      <div className="text-sm font-semibold text-destructive">{view.title}</div>
      <div className="max-w-md text-xs leading-5 text-muted-foreground">{view.hint}</div>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        <RefreshCw className={retrying ? 'animate-spin' : undefined} />
        {retrying ? '重试中' : '重新加载'}
      </Button>
      <div className="text-[11px] text-muted-foreground">
        页面每 {POLL_INTERVAL_MS / 1000} 秒也会自动重试一次
      </div>
    </div>
  );
}

function IncidentTimeline({ incidents }: { incidents: UptimeIncidentView[] }): JSX.Element {
  if (incidents.length === 0) {
    return (
      <div className="rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-6 text-center text-sm text-muted-foreground">
        暂未记录到故障事件。连续失败达到阈值时，这里会自动合成一条事件并统计持续时长。
      </div>
    );
  }
  return (
    <ol className="flex flex-col gap-2">
      {incidents.map((incident) => (
        <li
          key={incident.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-3 py-2 text-xs"
        >
          <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${incident.ongoing ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground'}`}>
            {incident.ongoing ? <AlertTriangle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
            {incident.ongoing ? '进行中' : '已恢复'}
          </span>
          <span className="min-w-0 truncate font-medium">{incident.targetName}</span>
          <span className="text-muted-foreground">{formatClock(incident.startedAt)}</span>
          <span className="text-muted-foreground">持续 {formatDuration(incident.durationMs)}</span>
          <span className="min-w-0 truncate text-muted-foreground">{incident.cause}</span>
        </li>
      ))}
    </ol>
  );
}

export function StatusPage(): JSX.Element {
  const narrow = useIsNarrow();
  const segments = narrow ? MOBILE_SEGMENTS : DESKTOP_SEGMENTS;
  const [summary, setSummary] = useState<UptimeSummary | null>(null);
  const [incidents, setIncidents] = useState<UptimeIncidentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const [next, incidentPayload] = await Promise.all([
        apiRequest<UptimeSummary>(`/api/uptime/summary?segments=${DESKTOP_SEGMENTS}`),
        apiRequest<{ incidents: UptimeIncidentView[] }>('/api/uptime/incidents?limit=30'),
      ]);
      if (!mounted.current) return;
      setSummary(next);
      setIncidents(incidentPayload.incidents || []);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const hasTargets = (summary?.targets.length ?? 0) > 0;
  // 三态互斥：只有 loading 才允许出现骨架，error（且无数据）走引导式错误卡片。
  const phase = resolveStatusViewPhase({ hasSummary: summary !== null, error });

  return (
    <AppShell
      active="status"
      topbar={(
        <TopBar
          left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '存活状态' }]} />}
          right={(
            <>
              <PaletteHint />
              <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
                <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
                {refreshing ? '刷新中' : '刷新'}
              </Button>
            </>
          )}
        />
      )}
    >
      <Workspace wide className="cds-workspace--fill cds-workspace--fluid">
        <div className="flex h-full min-h-0 flex-col gap-3">
          {/* 有数据时本次轮询失败只做顶部提示，保留旧数据；无数据时交给错误卡片 */}
          {phase === 'ready' && error ? (
            <div className="shrink-0 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              最近一次刷新失败（显示的是上一次成功的数据）：{error}
            </div>
          ) : null}

          {phase === 'loading' ? (
            <div className="min-h-0 flex-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
              <StatusSkeleton />
            </div>
          ) : phase === 'error' || !summary ? (
            <div className="min-h-0 flex-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
              <StatusErrorCard message={error || '未知错误'} onRetry={() => void load()} retrying={refreshing} />
            </div>
          ) : (
            <>
              <div className="shrink-0">
                <OverallBanner summary={summary} />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                <div className="flex flex-col gap-3 pb-2">
                  {hasTargets ? (
                    summary.targets.map((target) => (
                      <TargetRow key={target.id} target={target} segments={segments} />
                    ))
                  ) : (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-raised))] px-4 py-10 text-center">
                      <Activity className="h-6 w-6 text-muted-foreground" />
                      <div className="text-sm font-medium">还没有可监控的服务</div>
                      <div className="max-w-md text-xs leading-5 text-muted-foreground">
                        存活监控只探测「正在运行」的分支服务。先在项目里部署一个分支，
                        探测器每 {summary.intervalSeconds} 秒跑一轮，
                        首批数据约 {summary.firstDataEtaSeconds} 秒后出现在这里。
                        分支被调度器降温期间会标记为「已暂停」，不计入故障。
                      </div>
                      <Button variant="outline" size="sm" asChild>
                        <a href="/project-list">去项目列表部署分支</a>
                      </Button>
                    </div>
                  )}

                  <div className="mt-2">
                    <h2 className="mb-2 text-sm font-semibold">故障时间线</h2>
                    <IncidentTimeline incidents={incidents} />
                  </div>
                </div>
              </div>

              <div className="shrink-0 text-[11px] text-muted-foreground">
                数据由 CDS 自建探测器采集（直连容器宿主端口，不经预览代理，因此不会影响分支的空闲降温）。
                最近一轮探测：{summary.lastCycleAt ? formatClock(summary.lastCycleAt) : '尚未开始'}
                {' · '}页面每 {POLL_INTERVAL_MS / 1000} 秒自动刷新
              </div>
            </>
          )}
        </div>
      </Workspace>
    </AppShell>
  );
}
