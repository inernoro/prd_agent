import type { ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';

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
  return (
    <div className="cds-shape-panel flex min-h-28 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
      <ShapeGrid className="cds-shape-backdrop" speed={0.12} squareSize={34} hoverTrailAmount={0} />
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function BranchDetailLoadingSkeleton({ className }: { className?: string }): JSX.Element {
  return (
    <div
      className={cn(
        'relative min-h-[620px] overflow-hidden bg-[#090a0f] px-7 py-7 text-white',
        className,
      )}
    >
      <ShapeGrid
        className="absolute inset-0 h-full w-full opacity-55"
        direction="diagonal"
        speed={0.39}
        squareSize={34}
        shape="hexagon"
        borderColor="rgba(255,255,255,0.052)"
        hoverFillColor="rgba(255,255,255,0.035)"
        hoverTrailAmount={0}
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_56%_44%,rgba(255,255,255,0.035),transparent_34%),linear-gradient(90deg,rgba(9,10,15,0.94),rgba(9,10,15,0.58)_46%,rgba(9,10,15,0.92))]" />
      <div className="relative z-10 space-y-8">
        <div className="flex flex-wrap items-center gap-5">
          <div className="cds-loading-skeleton-line h-[74px] w-[194px] rounded-[20px]" />
          <div className="cds-loading-skeleton-line h-[74px] w-[194px] rounded-[20px] opacity-90" />
          <div className="cds-loading-skeleton-line h-[74px] w-[170px] rounded-[20px] opacity-80" />
        </div>

        <div className="cds-loading-skeleton-panel h-[min(66vh,760px)] min-h-[430px] rounded-[28px]" />

        <div className="space-y-7 pb-10">
          <div className="cds-loading-skeleton-line h-11 w-[28%] min-w-72 rounded-[18px]" />
          <div className="cds-loading-skeleton-line h-11 w-[38%] min-w-96 rounded-[18px] opacity-88" />
          <div className="cds-loading-skeleton-line h-11 w-[30%] min-w-80 rounded-[18px] opacity-74" />
        </div>
      </div>
    </div>
  );
}

export function ErrorBlock({ message }: { message: string }): JSX.Element {
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
      ? `${window.location.protocol}//${window.location.hostname}:9900/login.html`
      : '/login.html';

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
