import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import ShapeGrid from '@/components/effects/ShapeGrid';
import { cn } from '@/lib/utils';

export function Section({
  title,
  description,
  children,
  tone = 'default',
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'danger';
}): JSX.Element {
  return (
    <section className="border-b border-border pb-8 last:border-b-0">
      <h2 className={tone === 'danger' ? 'text-lg font-semibold text-destructive' : 'text-lg font-semibold'}>
        {title}
      </h2>
      {description ? (
        <div className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</div>
      ) : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="text-sm leading-6">{children}</div>
    </div>
  );
}

export function LoadingBlock({ label = '加载中' }: { label?: string }): JSX.Element {
  return <PartialLoadingPanel label={label} />;
}

/** 紧凑骨架的行宽序列(错落有致,像真实文本/列表在成形)。 */
const PANEL_SKELETON_ROWS = ['64%', '92%', '78%', '48%'] as const;

/**
 * 精致骨架屏(参考 OpenRouter)—— 全站加载态的 SSOT。
 * 取代旧的「大宝石 logo + 点阵背景」居中面板(用户反馈"很丑"):
 * 改为内容形状的 shimmer 占位,加载完成时视觉平滑接管,不突兀。
 * label/detail 仅供无障碍朗读(role=status + aria-label),不再作为大字居中。
 * 复用 index.css 的 .cds-loading-skeleton-line/-panel(reduced-motion 自动静止)。
 */
function PartialLoadingPanel({
  label,
  detail,
  className,
  expanded = false,
}: {
  label: string;
  detail?: ReactNode;
  className?: string;
  expanded?: boolean;
}): JSX.Element {
  const a11yLabel = detail && typeof detail === 'string' ? `${label}：${detail}` : label;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={a11yLabel}
      aria-busy="true"
      className={cn('w-full rounded-md', expanded ? 'min-h-[320px] p-5' : 'min-h-28 p-4', className)}
    >
      {expanded ? (
        <div className="flex flex-col gap-4">
          {/* 头部:标题 + 副标题 */}
          <div className="flex flex-col gap-2.5">
            <div className="cds-loading-skeleton-line h-6 w-1/3 min-w-[140px]" />
            <div className="cds-loading-skeleton-line h-3.5 w-2/3 max-w-md" />
          </div>
          {/* 指标条 */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="cds-loading-skeleton-panel h-16 rounded-lg"
                style={{ animationDelay: `${i * 0.12}s` }}
              />
            ))}
          </div>
          {/* 内容块 */}
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
            <div className="cds-loading-skeleton-panel h-40 rounded-lg" style={{ animationDelay: '0.2s' }} />
            <div className="cds-loading-skeleton-panel h-40 rounded-lg" style={{ animationDelay: '0.32s' }} />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {PANEL_SKELETON_ROWS.map((width, i) => (
            <div
              key={i}
              className="cds-loading-skeleton-line h-4"
              style={{ width, animationDelay: `${i * 0.1}s` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function BranchDetailLoadingSkeleton({ className }: { className?: string }): JSX.Element {
  return (
    <PartialLoadingPanel
      className={className}
      expanded
      label="加载分支详情"
      detail="正在读取分支状态、服务拓扑、最近部署记录和运行日志索引。"
    />
  );
}

export function ErrorBlock({ message, transient = false }: { message: string; transient?: boolean }): JSX.Element | null {
  // 2026-05-28 新增 transient 参数。
  // 用户反复反馈"主面板不能出现红色错误":Cloudflare 边缘 400 / CDN 抖动这类
  // 临时性错误调用方传 transient=true,本组件**完全不渲染**任何东西,只在
  // console 留诊断。真错误(认证、配置、依赖丢失)走原渲染。
  //
  // 调用方约定:
  //   const transient = err instanceof ApiError && err.transient;
  //   <ErrorBlock message={msg} transient={transient} />
  //
  // 这样 20+ 处现有 ErrorBlock 不用逐一改 catch 分支,只在传 ApiError.transient
  // 时自动哑。下一步把 ApiError 透传到这里。
  if (transient) {
    // eslint-disable-next-line no-console
    console.warn('[ErrorBlock transient hidden]', message);
    return null;
  }
  if (message.includes('未登录') || message.includes('401')) {
    return <AuthRequiredBlock />;
  }

  return (
    <div className="cds-shape-panel flex min-h-24 items-center gap-3 rounded-md border border-destructive/30 px-4 text-sm text-destructive">
      <ShapeGrid
        className="cds-shape-backdrop"
        speed={0.08}
        squareSize={34}
        borderColor="hsl(var(--destructive) / 0.16)"
        hoverFillColor="hsl(var(--destructive) / 0.08)"
        hoverTrailAmount={0}
      />
      <AlertCircle className="h-5 w-5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function AuthRequiredBlock(): JSX.Element {
  const loginHref =
    window.location.port === '5173'
      ? `${window.location.protocol}//${window.location.hostname}:9900/login`
      : '/login';

  return (
    <div className="cds-shape-panel flex min-h-32 flex-col items-start justify-center gap-3 rounded-md border border-border px-4 py-5">
      <ShapeGrid className="cds-shape-backdrop" speed={0.1} squareSize={34} hoverTrailAmount={0} />
      <div className="flex items-center gap-2 text-sm font-semibold">
        <AlertCircle className="h-5 w-5 text-primary" />
        需要登录 CDS
      </div>
      <p className="max-w-xl text-sm leading-6 text-muted-foreground">
        后端已经可达，但当前浏览器没有登录态。登录后刷新本页即可继续查看系统设置。
      </p>
      <Button asChild size="sm">
        <a href={loginHref}>打开登录页</a>
      </Button>
    </div>
  );
}

export function EmptyBlock({
  title,
  description,
}: {
  title: string;
  description: ReactNode;
}): JSX.Element {
  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm leading-6 text-muted-foreground">{description}</CardContent>
    </Card>
  );
}

export function MetricTile({
  icon,
  label,
  value,
  detail,
  className,
  valueClassName,
}: {
  icon?: ReactNode;
  label: string;
  value: string | number;
  detail?: ReactNode;
  className?: string;
  valueClassName?: string;
}): JSX.Element {
  return (
    <div className={cn('rounded-md border border-border bg-muted/30 px-3 py-2', className)}>
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={cn('truncate text-sm font-semibold', valueClassName)}>{value}</div>
      {detail ? <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

export function CodePill({ children }: { children: ReactNode }): JSX.Element {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{children}</code>
  );
}

export function maskSecret(key: string, value: string): string {
  if (!/password|secret|token|key|pat/i.test(key) || value.length <= 4) return value;
  return `****${value.slice(-4)}`;
}
