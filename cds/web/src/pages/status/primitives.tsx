/*
 * 监控中心的基础视觉件：状态标、来源标、可用率柱条、骨架屏、错误卡。
 *
 * 纪律：
 *   - 颜色只走 token / Tailwind 语义类（ok / warn / destructive / surface-*），双主题都可读；
 *   - up / down 不只靠颜色：柱条 down 段带斜纹 + 图标 + 文字，照顾色觉障碍；
 *   - 加载态是产物形状的 shimmer，不是静止 spinner。
 */
import { useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, EyeOff, HelpCircle, PauseCircle, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  SOURCE_META,
  describeBucket,
  type ProbeSource,
  type UptimeBucket,
  type UptimeStatus,
} from '@/lib/monitorCenter';
import { describeStatusLoadError } from '@/lib/statusView';

export const STATUS_META: Record<UptimeStatus, { label: string; icon: typeof CheckCircle2; pill: string; dot: string }> = {
  up: { label: '正常', icon: CheckCircle2, pill: 'border-ok/40 bg-ok-soft text-ok', dot: 'bg-ok' },
  down: { label: '故障', icon: AlertTriangle, pill: 'border-destructive/40 bg-destructive/10 text-destructive', dot: 'bg-destructive' },
  paused: { label: '已暂停', icon: PauseCircle, pill: 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground', dot: 'bg-[hsl(var(--hairline-strong))]' },
  unknown: { label: '待确认', icon: HelpCircle, pill: 'border-warn/40 bg-warn-soft text-warn', dot: 'bg-warn' },
};

const EXCLUDED_META = {
  label: '未纳入监控',
  icon: EyeOff,
  pill: 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground',
  dot: 'bg-[hsl(var(--hairline-strong))]',
} as const;

/** 按容器状态判定的「正常」不是观测：单独一档，暖色，不给绿。 */
const UNMEASURED_META = {
  label: '未实测',
  icon: HelpCircle,
  pill: 'border-warn/40 bg-warn-soft text-warn',
  dot: 'bg-warn',
} as const;

export function statusMetaOf(status: UptimeStatus, excluded?: boolean, measured?: boolean): { label: string; icon: typeof CheckCircle2; pill: string; dot: string } {
  if (excluded) return EXCLUDED_META;
  if (measured === false && status !== 'down' && status !== 'paused') return UNMEASURED_META;
  return STATUS_META[status];
}

export function StatusPill({ status, excluded, measured, size = 'sm' }: { status: UptimeStatus; excluded?: boolean; measured?: boolean; size?: 'sm' | 'lg' }): JSX.Element {
  const meta = statusMetaOf(status, excluded, measured);
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border font-medium',
        size === 'lg' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-[0.6875rem]',
        meta.pill,
      )}
    >
      <Icon className={size === 'lg' ? 'h-4 w-4' : 'h-3 w-3'} />
      {meta.label}
    </span>
  );
}

/** 列表行左侧的状态点：故障时带呼吸光晕，扫一眼就能定位。 */
export function StatusDot({ status, excluded, measured }: { status: UptimeStatus; excluded?: boolean; measured?: boolean }): JSX.Element {
  const meta = statusMetaOf(status, excluded, measured);
  const alive = status === 'down' && !excluded;
  return (
    <span className="relative inline-flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
      {alive ? <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', meta.dot)} /> : null}
      <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', meta.dot)} />
    </span>
  );
}

const SOURCE_TONE: Record<ProbeSource, string> = {
  custom: 'border-primary/40 bg-primary/10 text-primary',
  release: 'border-info/40 bg-info-soft text-info',
  branch: 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground',
};

export function SourceBadge({ source, full = false }: { source: ProbeSource; full?: boolean }): JSX.Element {
  const meta = SOURCE_META[source];
  return (
    <span
      className={cn('inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[0.625rem] font-medium leading-4', SOURCE_TONE[source])}
      title={meta.hint}
    >
      {full ? meta.label : meta.short}
    </span>
  );
}

function bucketTitle(bucket: UptimeBucket): string {
  return describeBucket(bucket).join('\n');
}

/** 柱条单段。颜色 + 高度 + 斜纹三重编码，不只靠颜色区分 up/down。 */
export function BarSegment({ bucket, compact = false }: { bucket: UptimeBucket; compact?: boolean }): JSX.Element {
  const base = 'min-w-0 flex-1 rounded-[2px] transition-colors';
  if (bucket.status === 'none') {
    return (
      <span
        className={cn(base, 'h-[40%] self-end bg-[hsl(var(--hairline-strong))]/85')}
        title={compact ? undefined : bucketTitle(bucket)}
        aria-label="无采样"
      />
    );
  }
  const stripe = bucket.status === 'up'
    ? undefined
    : { backgroundImage: 'repeating-linear-gradient(45deg, transparent 0 2px, hsl(var(--destructive-foreground) / 0.6) 2px 3px)' };
  const tone = bucket.status === 'up' ? 'h-full bg-ok' : bucket.status === 'partial' ? 'h-full bg-warn' : 'h-full bg-destructive';
  return (
    <span
      className={cn(base, tone)}
      style={stripe}
      title={compact ? undefined : bucketTitle(bucket)}
      aria-label={bucket.status === 'up' ? '正常' : bucket.status === 'partial' ? '部分失败' : '故障'}
    />
  );
}

/**
 * 可用率柱条：段数由调用方决定（列表迷你条 / 详情全宽条）。
 *
 * 全宽条在下方留一行**读数区**：指到哪一段就读哪一段，红段直接把当时的
 * 缩写日志打出来（2026-09-10 用户点名的第二条：「悬浮在故障的条状物上面
 * 能显示当时故障的缩写日志」）。
 *
 * 为什么是读数区而不是浮层：柱条活在 `overflow-x-auto` 里，任何绝对定位的
 * 浮层都会被这层滚动容器裁掉；而要绕开它就得自己算鼠标坐标——正是同一批
 * 反馈里第三条（竖线与鼠标差两公分）的成因。读数区不碰坐标，位置永远对。
 * 每段仍带原生 title 兜底，键盘与读屏用户走 aria-label。
 *
 * 高度写死（h-9 读数区）以免指来指去时整块布局跳动。
 */
export function AvailabilityBar({
  buckets,
  segments,
  className,
  compact = false,
  label,
}: {
  buckets: ReadonlyArray<UptimeBucket>;
  segments: number;
  className?: string;
  compact?: boolean;
  label: string;
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const shown = buckets.length > segments ? buckets.slice(buckets.length - segments) : buckets;

  if (compact) {
    return (
      <div className={cn('flex items-stretch h-4 gap-[1px]', className)} role="img" aria-label={label}>
        {shown.map((bucket) => <BarSegment key={bucket.from} bucket={bucket} compact />)}
      </div>
    );
  }

  const active = hover !== null ? shown[hover] : undefined;
  const bad = active ? active.down > 0 : false;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex h-9 items-stretch gap-[2px]" role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {shown.map((bucket, i) => (
          <span
            key={bucket.from}
            className="flex min-w-0 flex-1 items-stretch"
            onMouseEnter={() => setHover(i)}
            data-bucket-index={i}
          >
            <BarSegment bucket={bucket} />
          </span>
        ))}
      </div>
      <div
        className={cn(
          'flex h-9 flex-col justify-center rounded-md border px-2.5 py-1',
          bad ? 'border-destructive/40 bg-destructive/5' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]',
        )}
        aria-live="polite"
        data-testid="bar-readout"
      >
        {active ? (
          <>
            <div className="truncate font-mono text-[0.6875rem] leading-4 text-muted-foreground">
              {describeBucket(active).slice(0, 2).join(' · ')}
            </div>
            {describeBucket(active).length > 2 ? (
              <div className={cn('truncate font-mono text-[0.6875rem] leading-4', bad ? 'text-destructive' : 'text-muted-foreground')}>
                {describeBucket(active).slice(2).join(' · ')}
              </div>
            ) : null}
          </>
        ) : (
          <div className="font-mono text-[0.6875rem] leading-4 text-muted-foreground">把鼠标放到某一段上，看那段时间发生了什么</div>
        )}
      </div>
    </div>
  );
}

/** 详情页的统计格：眉标小而淡、数字大而紧，扫读时先看到数。 */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'ok' | 'warn' | 'danger';
  className?: string;
}): JSX.Element {
  const valueTone = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-destructive' : 'text-foreground';
  return (
    <div className={cn('min-w-0 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-3 py-2.5', className)}>
      <div className="font-mono text-[0.625rem] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('mt-1 truncate text-lg font-semibold tabular-nums leading-tight', valueTone)}>{value}</div>
      {hint ? <div className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}): JSX.Element {
  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-0.5" role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
            value === opt.value
              ? 'bg-[hsl(var(--surface-raised))] font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
          {typeof opt.count === 'number' ? <span className="font-mono text-[0.625rem] opacity-70">{opt.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** 加载骨架：横幅 + 左列表 + 右详情三块的形状，不是静止 spinner。 */
export function MonitorCenterSkeleton(): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3" role="status" aria-label="正在读取监控数据">
      <div className="cds-loading-skeleton-line h-20 w-full rounded-lg" />
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[21.25rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-2 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-3">
          <div className="cds-loading-skeleton-line h-8 w-full" />
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="cds-loading-skeleton-line h-2.5 w-2.5 rounded-full" />
              <div className="cds-loading-skeleton-line h-4 flex-1" style={{ animationDelay: `${i * 80}ms` }} />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-4">
          <div className="cds-loading-skeleton-line h-6 w-1/3" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="cds-loading-skeleton-line h-14" />)}
          </div>
          <div className="flex h-9 items-stretch gap-[2px]">
            {Array.from({ length: 60 }).map((_, idx) => (
              <span key={idx} className="cds-loading-skeleton-line w-full shrink-0 rounded-[2px]" style={{ animationDelay: `${(idx % 12) * 50}ms` }} />
            ))}
          </div>
          <div className="cds-loading-skeleton-line h-40 w-full" />
        </div>
      </div>
    </div>
  );
}

/** 失败态卡片（引导式）：讲清哪里出错 + 下一步怎么办 + 重试，而不是「加载失败」四个字。 */
export function MonitorCenterErrorCard({ message, onRetry, retrying, pollSeconds }: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
  pollSeconds: number;
}): JSX.Element {
  const view = describeStatusLoadError(message);
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-10 text-center">
      <AlertTriangle className="h-7 w-7 text-destructive" />
      <div className="text-sm font-semibold text-destructive">{view.title}</div>
      <div className="max-w-md text-xs leading-5 text-muted-foreground">{view.hint}</div>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        <RefreshCw className={retrying ? 'animate-spin' : undefined} />
        {retrying ? '重试中' : '重新加载'}
      </Button>
      <div className="text-[0.6875rem] text-muted-foreground">页面每 {pollSeconds} 秒也会自动重试一次</div>
    </div>
  );
}
