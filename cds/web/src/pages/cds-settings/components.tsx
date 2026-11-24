import { useContext, type ReactNode } from 'react';
import { SettingsContentSkeleton, SettingsLoadingContext } from '@/components/skeletons/SettingsSkeleton';
import { AlertCircle, ExternalLink, FileText, GitCommitHorizontal, Layers, ShieldCheck, TerminalSquare, Wrench } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import ShapeGrid from '@/components/effects/ShapeGrid';
import { cn } from '@/lib/utils';

export function Section({
  title,
  description,
  children,
  tone = 'default',
  actions,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'danger';
  actions?: ReactNode;
}): JSX.Element {
  return (
    <section className="border-b border-border pb-5 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className={tone === 'danger' ? 'text-lg font-semibold text-destructive' : 'text-lg font-semibold'}>{title}</h2>
        {actions}
      </div>
      {description ? (
        <div className="mt-1 max-w-3xl text-sm leading-5 text-muted-foreground">{description}</div>
      ) : null}
      <div className="mt-3">{children}</div>
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
  const settings = useContext(SettingsLoadingContext);
  if (settings) return <SettingsContentSkeleton label={label} />;
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
function PartialLoadingPanel({ label }: { label: string }): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      aria-busy="true"
      className="w-full rounded-md min-h-28 p-4"
    >
      <div className="flex flex-col gap-2.5">
        {PANEL_SKELETON_ROWS.map((width, i) => (
          <div
            key={i}
            className="cds-loading-skeleton-line h-4"
            style={{ width, animationDelay: `${i * 0.1}s` }}
          />
        ))}
      </div>
    </div>
  );
}

export const BRANCH_DETAIL_GRID_CLASS = 'grid gap-4 xl:grid-cols-[minmax(0,1fr)_22.5rem]';
export const BRANCH_DETAIL_COLUMN_CLASS = 'min-w-0 space-y-5';
export const BRANCH_DETAIL_HEADER_CLASS = 'flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between';
export const BRANCH_SELECTOR_GRID_CLASS = 'grid gap-3 md:grid-cols-2';
export const BRANCH_DIAGNOSTIC_TABS_CLASS = 'cds-surface-raised cds-hairline grid grid-cols-4 gap-1 p-1';

export function BranchDetailLoadingSkeleton({ selectBranch = false, canManage = true }: { selectBranch?: boolean; canManage?: boolean }): JSX.Element {
  const status = {
    role: 'status',
    'aria-label': '加载分支详情',
    'aria-busy': true,
  };

  if (selectBranch) {
    return <div {...status} className="max-w-5xl space-y-4">
      <div className="cds-surface-raised cds-hairline space-y-2 px-5 py-4" aria-hidden>
        <div className="cds-loading-skeleton-line h-6 w-32" />
        <div className="cds-loading-skeleton-line h-5 w-48" />
      </div>
      <div className={BRANCH_SELECTOR_GRID_CLASS} aria-hidden>
        {[0, 1, 2].map(i => <div key={i} className="cds-surface-raised cds-hairline space-y-2 p-4">
          <div className="cds-loading-skeleton-line h-6 w-24" />
          <div className="flex gap-2">
            <div className="cds-loading-skeleton-line h-4 w-32" />
            <div className="cds-loading-skeleton-line h-4 w-14" />
          </div>
        </div>)}
      </div>
      <div className="cds-loading-skeleton-panel h-9 w-28 rounded-md" aria-hidden />
    </div>;
  }

  return <div {...status} className={BRANCH_DETAIL_GRID_CLASS}>
    <div className={BRANCH_DETAIL_COLUMN_CLASS} aria-hidden>
      <Card className="rounded-md">
        <CardHeader className="p-5">
          <div className={BRANCH_DETAIL_HEADER_CLASS}>
            <div className="min-w-0">
              <div className="cds-loading-skeleton-line h-7 w-32" />
              <div className="mt-2 flex flex-wrap gap-2">
                <div className="cds-loading-skeleton-line h-5 w-28" />
                <div className="cds-loading-skeleton-line h-5 w-12" />
                <div className="cds-loading-skeleton-line h-5 w-20" />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="cds-loading-skeleton-panel h-9 w-28 rounded-md" />
              <div className="cds-loading-skeleton-panel h-9 w-24 rounded-md" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-5 pt-0">
          <div className="flex h-6 items-center"><div className="cds-loading-skeleton-line h-4 w-52 max-w-full" /></div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {['w-14', 'w-20', 'w-52', 'w-[13.25rem]'].map(w => <div className={`flex h-5 items-center ${w}`} key={w}>
              <div className="cds-loading-skeleton-line h-3.5 w-full" />
            </div>)}
          </div>
          <div className="flex h-10 items-center rounded-md border border-border bg-muted/30 p-3">
            <div className="cds-loading-skeleton-line h-3.5 w-32" />
          </div>
        </CardContent>
      </Card>
      <Card className="rounded-md">
        <CardHeader className="p-5"><CardTitle className="text-base">服务</CardTitle></CardHeader>
        <CardContent className="space-y-3 p-5 pt-0">
          {[0, 1].map(i => <div key={i} className="flex flex-col gap-3 rounded-md border border-border bg-card p-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <div className="flex h-6 items-center gap-2">
                <div className="cds-loading-skeleton-line h-4 w-4 rounded-full" />
                <div className="cds-loading-skeleton-line h-4 w-24" />
              </div>
              <div className="flex gap-2">
                <div className="cds-loading-skeleton-line h-5 w-12" />
                <div className="cds-loading-skeleton-line h-5 w-11" />
                <div className="cds-loading-skeleton-line h-5 w-8" />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {['w-20', 'w-16', 'w-24'].map(width => <div key={width} className={`cds-loading-skeleton-panel h-8 rounded-md ${width}`} />)}
            </div>
          </div>)}
          <div className="ml-auto cds-loading-skeleton-panel h-8 w-24 rounded-md" />
        </CardContent>
      </Card>
      <div>
        <div className={BRANCH_DIAGNOSTIC_TABS_CLASS}>
          {([[FileText, '日志'], [Wrench, '配置'], [GitCommitHorizontal, '历史'], [ShieldCheck, 'Bridge']] as const).map(([Icon, label], i) => (
            <span key={label} className={cn('flex min-h-11 items-center justify-center gap-1 rounded-md text-sm text-muted-foreground', i === 0 && 'bg-accent font-medium text-accent-foreground')}>
              <Icon className="h-4 w-4 shrink-0" />{label}
            </span>
          ))}
        </div>
        <div className="space-y-4">
          <div className="overflow-hidden rounded-md border border-border bg-card/70 shadow-sm">
            <BranchDetailDisclosureHeading icon={<TerminalSquare className="h-4 w-4" />} title="容器日志" />
            <div className="space-y-3 border-t border-border p-5">
              <div className="ml-auto cds-loading-skeleton-panel h-8 w-16 rounded-md" />
              <div className="cds-loading-skeleton-line h-4 w-24" />
              <div className="cds-loading-skeleton-panel h-16 rounded-md border border-dashed border-border" />
            </div>
          </div>
          {canManage ? <div className="rounded-md border border-border bg-card/70 shadow-sm">
            <BranchDetailDisclosureHeading icon={<ExternalLink className="h-4 w-4" />} title="HTTP 转发日志" />
          </div> : null}
        </div>
      </div>
      <div className="rounded-md border border-border bg-card/70 shadow-sm">
        <BranchDetailDisclosureHeading icon={<Layers className="h-4 w-4" />} title="生效配置" />
      </div>
      <div className="rounded-md border border-border bg-card/70 shadow-sm">
        <BranchDetailDisclosureHeading icon={<FileText className="h-4 w-4" />} title="构建日志" />
      </div>
    </div>
    <div className={BRANCH_DETAIL_COLUMN_CLASS} aria-hidden>
      <Card className="rounded-md">
        <CardHeader className="p-5">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">预览别名</CardTitle>
            {canManage ? <div className="cds-loading-skeleton-panel h-8 w-16 rounded-md" /> : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-5 pt-0">
          <div className="space-y-2">
            <div className="cds-loading-skeleton-line h-4 w-20" />
            <div className="cds-loading-skeleton-line h-5 w-52 max-w-full" />
          </div>
          <div className="cds-loading-skeleton-panel h-16 rounded-md border border-dashed border-border" />
          <div className="cds-loading-skeleton-line h-4 w-24" />
          <div className="cds-loading-skeleton-panel h-20 rounded-md border border-dashed border-border" />
        </CardContent>
      </Card>
    </div>
  </div>;
}

function BranchDetailDisclosureHeading({ icon, title }: { icon: ReactNode; title: string }): JSX.Element {
  return <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      <div className="space-y-1">
        <div className="font-semibold">{title}</div>
        <div className="cds-loading-skeleton-line h-4 w-24" />
      </div>
    </div>
    <div className="cds-loading-skeleton-line h-3 w-8" />
  </div>;
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

export function isSensitiveEnvKey(key: string): boolean {
  return /password|secret|token|key|pat|jwt|credential|private/i.test(key);
}

export function maskSecret(key: string, value: string): string {
  return isSensitiveEnvKey(key) && value ? '••••••••' : value;
}
