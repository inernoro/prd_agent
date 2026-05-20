import { useMemo } from 'react';
import { Clock, Copy, ExternalLink, Loader2, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ShapeGrid from '@/components/effects/ShapeGrid';
import type { PhaseKey } from '@/lib/deploymentPhases';
import type { BranchDeploymentItem } from '@/components/BranchDetailDrawer';
import { type PhaseLogState, type InlineContainerLogControls } from './PhaseTree';

function lastLines(text: string, n: number): string {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= n) return text;
  return lines.slice(-n).join('\n');
}

/**
 * 部署 tab 当前区域只展示容器运行日志。
 * 阶段树已经从主视图移除，避免右侧检查列表挤占用户真正需要看的日志。
 */
function PrimaryContainerLogPanel({
  containerLogsByPhase,
  containerLogControls,
}: {
  containerLogsByPhase?: Partial<Record<PhaseKey, PhaseLogState>>;
  containerLogControls?: InlineContainerLogControls;
}): JSX.Element {
  // 把 by-phase map 折成一个 state：优先 deploy → verify → 第一个 key。
  const state: PhaseLogState | null = useMemo(() => {
    if (!containerLogsByPhase) return null;
    return (
      containerLogsByPhase.deploy
      || containerLogsByPhase.verify
      || (Object.values(containerLogsByPhase)[0] as PhaseLogState | undefined)
      || null
    );
  }, [containerLogsByPhase]);
  const hasTabs = !!(containerLogControls && containerLogControls.services.length > 1);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">容器日志</div>
        {containerLogControls?.onMaximize ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-2 py-0.5 text-[11px] hover:border-[hsl(var(--hairline-strong))]"
            onClick={containerLogControls.onMaximize}
            title="跳转到「日志 → 容器日志」查看完整内容"
          >
            <Maximize2 className="h-3 w-3" />
            最大化
          </button>
        ) : null}
      </header>
      {hasTabs ? (
        <div className="flex flex-wrap gap-1.5 border-b border-[hsl(var(--hairline))] px-3 py-2">
          {containerLogControls!.services.map((svc) => {
            const active = svc.profileId === containerLogControls!.selected;
            const dot = svc.status === 'running'
              ? 'bg-emerald-500'
              : svc.status === 'error'
                ? 'bg-destructive'
                : 'bg-muted-foreground/40';
            return (
              <button
                key={svc.profileId}
                type="button"
                onClick={() => containerLogControls!.onSelect(svc.profileId)}
                className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] transition-colors ${
                  active
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] text-muted-foreground hover:text-foreground'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                <span className="font-mono">{svc.profileId}</span>
                {svc.hostPort ? <span className="font-mono opacity-70">:{svc.hostPort}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden p-2">
        {!state ? (
          <div className="rounded border border-dashed border-[hsl(var(--hairline))] px-3 py-6 text-center text-xs text-muted-foreground">
            还没有容器日志。容器进入 running 后这里会显示 docker logs 的最后若干行。
          </div>
        ) : state.status === 'loading' ? (
          <div className="flex items-center gap-2 rounded border border-[hsl(var(--hairline))] px-3 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在加载容器日志…
          </div>
        ) : state.status === 'error' ? (
          <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {state.message || '容器日志加载失败'}
          </div>
        ) : !state.logs || !state.logs.trim() ? (
          <div className="rounded border border-[hsl(var(--hairline))] px-3 py-3 text-xs text-muted-foreground">
            容器尚未输出任何日志（多半是进程在监听端口前就退出了）。
          </div>
        ) : (
          <pre className="max-h-[560px] min-h-[280px] overflow-auto rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 font-mono text-[11px] leading-5 text-foreground/85 whitespace-pre-wrap break-words">
            {lastLines(state.logs, 220)}
          </pre>
        )}
      </div>
    </section>
  );
}

/*
 * ActiveDeployment — 部署 tab 顶部那张「当前部署」大卡。
 *
 * 视觉对齐 Railway / Vercel：
 *  - 顶部 status 大徽章 + commit + 中文 kind + duration
 *  - 中间只显示容器运行日志，阶段检查与调试字段收进完整日志/诊断入口。
 *  - 底部固定一行通用动作：查看日志 / 复制排错摘要
 */

export interface ActiveDeploymentProps {
  deployment: BranchDeploymentItem;
  branchErrorMessage?: string;
  now: number;
  onOpenLogs: (deployment: BranchDeploymentItem) => void;
  onCopyDiagnosis: (deployment: BranchDeploymentItem) => void;
  containerLogsByPhase?: Partial<Record<PhaseKey, PhaseLogState>>;
  /**
   * 多容器 tab 切换 + 最大化控制。
   */
  containerLogControls?: InlineContainerLogControls;
}

function statusBadgeClass(status: BranchDeploymentItem['status']): string {
  if (status === 'running') return 'border-sky-500/30 bg-sky-500/10 text-sky-600';
  if (status === 'success') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  return 'border-destructive/30 bg-destructive/10 text-destructive';
}

function statusBadgeLabel(status: BranchDeploymentItem['status']): string {
  if (status === 'running') return '运行中';
  if (status === 'success') return '已完成';
  return '失败';
}

function effectiveDeploymentStatus(
  deployment: BranchDeploymentItem,
  branchErrorMessage?: string,
): BranchDeploymentItem['status'] {
  /*
   * A deployment action can be recorded as success while the branch is now in
   * error state after health/runtime checks. In the drawer this looked like
   * "异常" in the header and "已完成" in the deployment card, which is a
   * misleading lifecycle signal. Prefer the current branch error for display.
   */
  if (deployment.status === 'success' && branchErrorMessage) return 'error';
  return deployment.status;
}

function deploymentKindLabel(kind: BranchDeploymentItem['kind']): string {
  return ({
    preview: '预览部署',
    deploy: '部署',
    pull: '拉取',
    stop: '停止',
    create: '创建分支',
    favorite: '收藏',
    reset: '重置',
    delete: '删除',
  } as Record<BranchDeploymentItem['kind'], string>)[kind];
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function ActiveDeployment({
  deployment,
  branchErrorMessage,
  now,
  onOpenLogs,
  onCopyDiagnosis,
  containerLogsByPhase,
  containerLogControls,
}: ActiveDeploymentProps): JSX.Element {
  const displayStatus = effectiveDeploymentStatus(deployment, branchErrorMessage);

  const duration = formatDuration((deployment.finishedAt || now) - deployment.startedAt);
  const isError = displayStatus === 'error';

  return (
    <section
      className={`cds-shape-panel overflow-hidden rounded-md border ${
        isError ? 'border-destructive/35' : 'cds-hairline'
      }`}
    >
      <ShapeGrid
        className="cds-shape-backdrop"
        speed={displayStatus === 'running' ? 0.16 : 0.08}
        squareSize={36}
        borderColor={isError ? 'hsl(var(--destructive) / 0.1)' : 'hsl(var(--foreground) / 0.045)'}
        hoverFillColor={isError ? 'hsl(var(--destructive) / 0.055)' : 'hsl(var(--foreground) / 0.025)'}
        hoverTrailAmount={0}
      />
      <header className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline))] px-5 py-4">
        <span className={`rounded border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${statusBadgeClass(displayStatus)}`}>
          {deployment.status === 'success' && displayStatus === 'error' ? '运行异常' : statusBadgeLabel(displayStatus)}
        </span>
        <span className="text-sm font-semibold">{deploymentKindLabel(deployment.kind)}</span>
        {deployment.commitSha ? (
          <span className="font-mono text-xs text-muted-foreground">{deployment.commitSha.slice(0, 7)}</span>
        ) : null}
        <span
          className={`ml-auto inline-flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-xs font-semibold ${
            displayStatus === 'running'
              ? 'border-amber-500/35 bg-amber-500/10 text-amber-600 dark:text-amber-300'
              : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground'
          }`}
          title={displayStatus === 'running' ? '本次部署已持续时间' : '本次部署耗时'}
        >
          <Clock className="h-3.5 w-3.5" />
          {displayStatus === 'running' ? '已用' : '耗时'} {duration}
        </span>
      </header>

      <div className="px-5 py-4" style={{ minHeight: 360 }}>
        <PrimaryContainerLogPanel
          containerLogsByPhase={containerLogsByPhase}
          containerLogControls={containerLogControls}
        />
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/40 px-5 py-3">
        <div className="min-w-0 truncate text-xs text-muted-foreground">
          {branchErrorMessage || deployment.message || '部署进行中…'}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => onCopyDiagnosis(deployment)}>
            <Copy />
            复制排错摘要
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenLogs(deployment)}>
            <ExternalLink />
            查看完整日志
          </Button>
        </div>
      </footer>
    </section>
  );
}
